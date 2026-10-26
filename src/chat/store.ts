import * as fs from "node:fs";
import * as path from "node:path";
import { acquireLock, appendJsonl, LockTimeoutError, atomicWriteJson, readJsonl } from "../fsutil.js";
import { isThreadId, newThreadId } from "../ids.js";
import type { ProviderPin } from "../openrouter/types.js";
import { nowIso } from "../time.js";
import type { ThreadState, TranscriptEntry, TranscriptEntryInput } from "./types.js";

/**
 * Durable chat threads: one directory per thread under <storage>/threads.
 *
 *   T-20261026-A7C2/
 *     thread.json        atomic snapshot (source of truth for current state)
 *     transcript.jsonl   append-only; never rewritten
 *     thread.lock        cross-process advisory lock
 */

const FILES = { state: "thread.json", transcript: "transcript.jsonl", lock: "thread.lock" } as const;

export class ThreadNotFoundError extends Error {
  constructor(public readonly input: string) {
    super(`No chat thread matches "${input}". Use /chat list to see threads.`);
    this.name = "ThreadNotFoundError";
  }
}

export class ThreadBusyError extends Error {
  constructor(id: string) {
    super(`Thread ${id} is busy (lock held). Try again shortly.`);
    this.name = "ThreadBusyError";
  }
}

export class ThreadStore {
  constructor(public readonly root: string) {}

  private dir(id: string): string {
    if (!isThreadId(id)) throw new ThreadNotFoundError(id);
    return path.join(this.root, id);
  }

  public create(init: { model: string; account: string; providerPin?: ProviderPin }): ThreadState {
    fs.mkdirSync(this.root, { recursive: true });
    for (let attempt = 0; attempt < 20; attempt++) {
      const id = newThreadId(new Date(), attempt < 10 ? 4 : 6);
      try {
        fs.mkdirSync(path.join(this.root, id)); // non-recursive: EEXIST on collision
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw err;
      }
      const now = nowIso();
      const state: ThreadState = {
        schemaVersion: 1,
        id,
        title: "(untitled)",
        titleLocked: false,
        retitled: false,
        model: init.model,
        account: init.account,
        ...(init.providerPin ? { providerPin: init.providerPin } : {}),
        createdAt: now,
        updatedAt: now,
        nextSeq: 1,
      };
      atomicWriteJson(path.join(this.root, id, FILES.state), state);
      return state;
    }
    throw new Error("Could not allocate a unique thread ID");
  }

  public read(id: string): ThreadState {
    const file = path.join(this.dir(id), FILES.state);
    if (!fs.existsSync(file)) throw new ThreadNotFoundError(id);
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ThreadState>;
    if (!parsed || parsed.id !== id || parsed.schemaVersion !== 1) throw new Error(`Thread ${id} has an unreadable thread.json`);
    return parsed as ThreadState;
  }

  /** Most recently updated first. Unreadable threads are skipped. */
  public list(): ThreadState[] {
    if (!fs.existsSync(this.root)) return [];
    const out: ThreadState[] = [];
    for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !isThreadId(entry.name)) continue;
      try {
        out.push(this.read(entry.name));
      } catch {
        // skip unreadable or half-created threads
      }
    }
    return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : b.id.localeCompare(a.id)));
  }

  /** Accepts a full ID, a unique ID suffix, or an exact title (all case-insensitive). Any overlap is ambiguous. */
  public resolve(input: string): string {
    const wanted = input.trim().toUpperCase();
    if (!wanted) throw new ThreadNotFoundError(input);
    const threads = this.list();
    const exact = threads.find((t) => t.id.toUpperCase() === wanted);
    if (exact) return exact.id;
    const matches = threads.filter((t) => t.id.toUpperCase().endsWith(wanted) || t.title.trim().toUpperCase() === wanted);
    if (matches.length === 1) return matches[0]!.id;
    if (matches.length > 1) throw new Error(`"${input}" is ambiguous: ${matches.map((m) => `${m.id} (${m.title})`).join(", ")}`);
    throw new ThreadNotFoundError(input);
  }

  /** Locked read -> mutate -> append entries -> atomic snapshot. Entries hit disk before the snapshot. */
  public update<T>(id: string, fn: (t: ThreadState, append: (e: TranscriptEntryInput) => TranscriptEntry) => T, waitMs = 3000): T {
    const dir = this.dir(id);
    if (!fs.existsSync(path.join(dir, FILES.state))) throw new ThreadNotFoundError(id);
    let lock;
    try {
      lock = acquireLock(path.join(dir, FILES.lock), waitMs);
    } catch (err) {
      if (err instanceof LockTimeoutError) throw new ThreadBusyError(id);
      throw err;
    }
    try {
      const state = this.read(id);
      // A crash after appending but before the snapshot leaves transcript seqs the snapshot doesn't know about.
      state.nextSeq = Math.max(state.nextSeq, this.lastSeq(id) + 1);
      const entries: TranscriptEntry[] = [];
      const append = (e: TranscriptEntryInput): TranscriptEntry => {
        const entry = { ...e, seq: state.nextSeq++, at: nowIso() } as TranscriptEntry;
        entries.push(entry);
        return entry;
      };
      const out = fn(state, append);
      for (const e of entries) appendJsonl(path.join(dir, FILES.transcript), e);
      state.updatedAt = nowIso();
      atomicWriteJson(path.join(dir, FILES.state), state);
      return out;
    } finally {
      lock.release();
    }
  }

  private lastSeq(id: string): number {
    let max = 0;
    for (const e of readJsonl<TranscriptEntry>(path.join(this.dir(id), FILES.transcript)).records) {
      if (typeof e.seq === "number" && e.seq > max) max = e.seq;
    }
    return max;
  }

  public transcript(id: string): { entries: TranscriptEntry[]; malformedLines: number } {
    const { records, malformedLines } = readJsonl<TranscriptEntry>(path.join(this.dir(id), FILES.transcript));
    return { entries: records, malformedLines };
  }
}
