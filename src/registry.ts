import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { acquireLock, appendJsonl, atomicWriteFile, atomicWriteJson, readJsonl, tryAcquireLock, type FileLock } from "./fsutil.js";
import { isLocalJobId, newLocalJobId } from "./ids.js";
import { assertTransition, isLocalStatus, type LocalStatus } from "./state.js";
import { nowIso } from "./time.js";
import type { JobEvent, JobManifest } from "./types.js";

/**
 * Durable job registry: one directory per job under the storage root.
 *
 *   <root>/
 *     .gitignore                 ("*": job artefacts are never committed by accident)
 *     extension.log
 *     B-20261016-A7C2/
 *       manifest.json            atomic snapshot (source of truth for current state)
 *       events.jsonl             append-only lifecycle history
 *       .lock                    cross-process advisory lock
 *       request/  objective.md, context.md, context-manifest.json, submitted-request.json, request.sha256,
 *                 plan.json (workflows), synthesis-linkage.json (synthesis jobs)
 *       request/items/001/  metadata.json, request.json, request.sha256, prompt.md     (Release 2)
 *       request/  workflow.yaml, workflow.json, dataset.json                         (Release 3 dataset jobs)
 *       provider/ submission-response.json, latest-status.json, final-response.json
 *       result/   result.md, result.json, metadata.json, summary.json, unexpected.json
 *       result/items/001/   raw.json, result.json, result.md, output.json (parsed JSON; Release 3)
 *       exports/  written only by an explicit `/batch export`                       (Release 3)
 *
 * Item folders are named by ordinal, not custom_id: Release 1 custom_ids could
 * contain ':' which is not a valid Windows file name character.
 *
 * Chosen over SQLite (better-sqlite3 / node:sqlite) for portability: no native
 * addon to build against Pi's Node ABI on Windows, and no ExperimentalWarning
 * written to the TUI. The registry interface is narrow so it can be swapped.
 */

export const ARTEFACTS = {
  manifest: "manifest.json",
  events: "events.jsonl",
  lock: ".lock",
  objective: "request/objective.md",
  context: "request/context.md",
  contextManifest: "request/context-manifest.json",
  submittedRequest: "request/submitted-request.json",
  requestSha: "request/request.sha256",
  submissionResponse: "provider/submission-response.json",
  latestStatus: "provider/latest-status.json",
  finalResponse: "provider/final-response.json",
  cancelResponse: "provider/cancel-response.json",
  resultMd: "result/result.md",
  resultJson: "result/result.json",
  resultMetadata: "result/metadata.json",
  plan: "request/plan.json",
  synthesisLinkage: "request/synthesis-linkage.json",
  resultSummary: "result/summary.json",
  resultUnexpected: "result/unexpected.json",
  workflowSource: "request/workflow.yaml",
  workflowResolved: "request/workflow.json",
  dataset: "request/dataset.json",
  exportsDir: "exports",
} as const;

export const ITEM_ARTEFACTS = {
  metadata: "metadata.json",
  request: "request.json",
  requestSha: "request.sha256",
  prompt: "prompt.md",
  raw: "raw.json",
  resultJson: "result.json",
  resultMd: "result.md",
  output: "output.json",
} as const;

const ITEM_SIDE: Record<keyof typeof ITEM_ARTEFACTS, "request" | "result"> = {
  metadata: "request",
  request: "request",
  requestSha: "request",
  prompt: "request",
  raw: "result",
  resultJson: "result",
  resultMd: "result",
  output: "result",
};

export function itemFolder(ordinal: number): string {
  return String(ordinal).padStart(3, "0");
}

export class JobNotFoundError extends Error {
  constructor(public readonly localId: string) {
    super(`No batch job ${localId}. Use /batch list to see known jobs.`);
    this.name = "JobNotFoundError";
  }
}

export class CorruptManifestError extends Error {
  constructor(
    public readonly localId: string,
    reason: string,
  ) {
    super(`Job ${localId} has an unreadable manifest: ${reason}`);
    this.name = "CorruptManifestError";
  }
}

/** In-memory handle for one read-modify-write of a manifest. */
export class JobUpdate {
  public readonly events: JobEvent[] = [];

  constructor(public manifest: JobManifest) {}

  /** Validated state change; throws IllegalTransitionError rather than corrupting state. */
  public transition(to: LocalStatus, details?: Record<string, unknown>): void {
    const from = this.manifest.localStatus;
    assertTransition(from, to, this.manifest.localId);
    this.manifest.localStatus = to;
    this.events.push(makeEvent(this.manifest.localId, "transition", details, from, to));
  }

  public note(eventType: string, details?: Record<string, unknown>): void {
    this.events.push(makeEvent(this.manifest.localId, eventType, details));
  }
}

function makeEvent(localId: string, eventType: string, details?: Record<string, unknown>, from?: LocalStatus, to?: LocalStatus): JobEvent {
  return {
    id: crypto.randomUUID(),
    localId,
    eventType,
    ...(from ? { previousStatus: from } : {}),
    ...(to ? { newStatus: to } : {}),
    eventAt: nowIso(),
    ...(details ? { details } : {}),
  };
}

export interface ListResult {
  jobs: JobManifest[];
  unreadable: Array<{ localId: string; reason: string }>;
}

export class JobRegistry {
  constructor(public readonly root: string) {}

  public ensureRoot(): void {
    fs.mkdirSync(this.root, { recursive: true });
    const gi = path.join(this.root, ".gitignore");
    if (!fs.existsSync(gi)) atomicWriteFile(gi, "# pi-batch-openrouter job state: contains submitted context and provider output\n*\n");
  }

  public jobDir(localId: string): string {
    if (!isLocalJobId(localId)) throw new JobNotFoundError(localId);
    return path.join(this.root, localId);
  }

  public artefact(localId: string, name: keyof typeof ARTEFACTS): string {
    return path.join(this.jobDir(localId), ...ARTEFACTS[name].split("/"));
  }

  public itemArtefact(localId: string, ordinal: number, name: keyof typeof ITEM_ARTEFACTS): string {
    if (!Number.isInteger(ordinal) || ordinal < 1) throw new Error(`invalid item ordinal ${ordinal}`);
    return path.join(this.jobDir(localId), ITEM_SIDE[name], "items", itemFolder(ordinal), ITEM_ARTEFACTS[name]);
  }

  public exists(localId: string): boolean {
    return isLocalJobId(localId) && fs.existsSync(path.join(this.root, localId, ARTEFACTS.manifest));
  }

  /** Allocates a unique ID by exclusive mkdir (no reliance on timestamps for uniqueness). */
  public create(build: (localId: string, dir: string) => JobManifest): JobManifest {
    this.ensureRoot();
    for (let attempt = 0; attempt < 20; attempt++) {
      const localId = newLocalJobId(new Date(), attempt < 10 ? 4 : 6);
      const dir = path.join(this.root, localId);
      try {
        fs.mkdirSync(dir); // non-recursive: throws EEXIST on collision
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw err;
      }
      const manifest = build(localId, dir);
      const update = new JobUpdate(manifest);
      update.note("created", { localStatus: manifest.localStatus, parentJobId: manifest.parentJobId });
      this.commit(update);
      return manifest;
    }
    throw new Error("Could not allocate a unique local job ID");
  }

  public read(localId: string): JobManifest {
    const file = path.join(this.jobDir(localId), ARTEFACTS.manifest);
    if (!fs.existsSync(file)) throw new JobNotFoundError(localId);
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      throw new CorruptManifestError(localId, (err as Error).message);
    }
    const m = parsed as Partial<JobManifest>;
    if (!m || m.localId !== localId || !isLocalStatus(m.localStatus) || (m.schemaVersion !== 1 && m.schemaVersion !== 2 && m.schemaVersion !== 3)) {
      throw new CorruptManifestError(localId, "missing or invalid localId/localStatus/schemaVersion");
    }
    return m as JobManifest;
  }

  /** Writes events (append-only history) then the manifest snapshot (atomic). */
  public commit(update: JobUpdate): void {
    const dir = this.jobDir(update.manifest.localId);
    for (const ev of update.events) appendJsonl(path.join(dir, ARTEFACTS.events), ev);
    update.events.length = 0;
    atomicWriteJson(path.join(dir, ARTEFACTS.manifest), update.manifest);
  }

  /** Fresh read -> mutate -> commit. Caller must hold the job lock when concurrency matters. */
  public update<T>(localId: string, fn: (u: JobUpdate) => T): T {
    const u = new JobUpdate(this.read(localId));
    const out = fn(u);
    this.commit(u);
    return out;
  }

  public events(localId: string): JobEvent[] {
    return readJsonl<JobEvent>(path.join(this.jobDir(localId), ARTEFACTS.events)).records;
  }

  public tryLock(localId: string): FileLock | null {
    return tryAcquireLock(path.join(this.jobDir(localId), ARTEFACTS.lock));
  }

  public lock(localId: string, waitMs = 3000): FileLock {
    return acquireLock(path.join(this.jobDir(localId), ARTEFACTS.lock), waitMs);
  }

  /** Newest first. Unreadable manifests are reported, never silently dropped. */
  public list(): ListResult {
    const result: ListResult = { jobs: [], unreadable: [] };
    if (!fs.existsSync(this.root)) return result;
    for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !isLocalJobId(entry.name)) continue;
      try {
        result.jobs.push(this.read(entry.name));
      } catch (err) {
        if (err instanceof JobNotFoundError) {
          result.unreadable.push({ localId: entry.name, reason: "manifest.json missing (creation interrupted?)" });
        } else {
          result.unreadable.push({ localId: entry.name, reason: (err as Error).message });
        }
      }
    }
    result.jobs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.localId.localeCompare(a.localId)));
    return result;
  }

  /** Accepts a full ID or a unique case-insensitive suffix/prefix (e.g. "A7C2"). */
  public resolveId(input: string): string {
    const wanted = input.trim().toUpperCase();
    if (isLocalJobId(wanted) && this.exists(wanted)) return wanted;
    const matches = this.list().jobs.filter((j) => j.localId.endsWith(wanted) || j.localId.startsWith(wanted) || j.providerBatchId === input.trim());
    if (matches.length === 1) return matches[0]!.localId;
    if (matches.length > 1) throw new Error(`"${input}" is ambiguous: ${matches.map((m) => m.localId).join(", ")}`);
    throw new JobNotFoundError(input);
  }
}
