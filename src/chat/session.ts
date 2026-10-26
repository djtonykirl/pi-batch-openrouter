import type { BatchConfig } from "../config.js";
import { ChatBlockedError, type ChatService } from "./service.js";
import { ThreadBusyError, type ThreadStore } from "./store.js";
import type { ThreadState, TranscriptEntry } from "./types.js";

/** The custom entry type chat content is displayed with (appended to the Pi session, never sent to the agent). */
export const CHAT_ENTRY_TYPE = "pi-batch-chat";

const FOOTER_TITLE_MAX = 40;
const FOOTER_WARN_RATIO = 0.8;

export interface ChatEntryData {
  threadId: string;
  seq?: number;
  role: "user" | "assistant" | "status";
  text: string;
  model?: string;
  title: string;
  truncated?: boolean;
}

export interface ChatSessionDeps {
  chat: ChatService;
  store: ThreadStore;
  /** index.ts binds this to pi.appendEntry(CHAT_ENTRY_TYPE, data). */
  appendEntry: (data: ChatEntryData) => void;
  setStatus: (text: string | undefined) => void;
  notify: (message: string, level: "info" | "warning" | "error") => void;
  getConfig: () => BatchConfig;
}

const key = (threadId: string, seq: number): string => `${threadId}:${seq}`;

function maxAssistantSeq(entries: TranscriptEntry[]): number {
  let max = 0;
  for (const e of entries) if (e.type === "assistant") max = Math.max(max, e.seq);
  return max;
}

/** Entries are shown in seq (chronological) order, as the user saw them happen. */
function toDisplay(thread: ThreadState, e: TranscriptEntry): ChatEntryData {
  const base = { threadId: thread.id, seq: e.seq, title: thread.title };
  switch (e.type) {
    case "user":
      return { ...base, role: "user", text: e.text };
    case "assistant":
      return { ...base, role: "assistant", text: e.text, model: e.model, ...(e.finishReason === "length" ? { truncated: true } : {}) };
    case "model":
      return { ...base, role: "status", text: `Model → ${e.to}` };
    case "title":
      return { ...base, role: "status", text: `Retitled: ${e.title}` };
    case "compaction":
      return { ...base, role: "status", text: `Compacted (through #${e.throughSeq})` };
    case "failure":
      return {
        ...base,
        role: "status",
        text: e.purpose === "compact" ? `⚠ Compaction failed: ${e.message} (thread unchanged)` : `⚠ Turn failed: ${e.message} — /batch chat retry`,
      };
    case "status":
      return { ...base, role: "status", text: e.text };
  }
}

/**
 * Per-Pi-session chat layer: chat mode, typed input, display of thread entries and the footer. It reaches Pi only
 * through `ChatSessionDeps`, and never puts chat text into the agent's conversation.
 */
export class ChatSession {
  private active: string | undefined;
  private readonly shown = new Set<string>();
  /** Per thread: the highest assistant seq already displayed or announced. */
  private readonly announced = new Map<string, number>();

  constructor(
    private readonly deps: ChatSessionDeps,
    alreadyShown: Iterable<{ threadId: string; seq: number }>,
  ) {
    for (const a of alreadyShown) this.shown.add(key(a.threadId, a.seq));
    try {
      for (const t of deps.store.list()) this.announced.set(t.id, maxAssistantSeq(deps.store.transcript(t.id).entries));
    } catch {
      // No baseline: replies that already exist may be announced once.
    }
  }

  get activeThreadId(): string | undefined {
    return this.active;
  }

  enter(threadId: string): void {
    const thread = this.deps.store.read(threadId);
    this.active = threadId;
    this.deps.appendEntry({ threadId, role: "status", title: thread.title, text: `Resumed: ${thread.title}` });
    if (thread.summary) {
      const through = thread.summary.throughSeq;
      this.deps.appendEntry({ threadId, role: "status", title: thread.title, text: `Compacted earlier conversation (through #${through})` });
      for (const e of this.deps.store.transcript(threadId).entries) if (e.seq <= through) this.shown.add(key(threadId, e.seq));
    }
    this.sync();
  }

  leave(): void {
    this.active = undefined;
    this.deps.setStatus(undefined);
  }

  async handleInput(text: string, source: "interactive" | "rpc" | "extension"): Promise<"handled" | "continue"> {
    const threadId = this.active;
    if (!threadId || source === "extension" || text.trim().startsWith("/")) return "continue";
    if (text.trim() === "") return "handled";
    try {
      await this.deps.chat.send(threadId, text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof ChatBlockedError) this.deps.notify(message, "warning");
      else if (err instanceof ThreadBusyError) this.deps.notify(`${message}\nYour message was not saved. Try again.`, "warning");
      else this.deps.notify(`Chat send failed: ${message}\nYour message may not be saved.`, "error");
    }
    this.sync();
    return "handled";
  }

  /** Displays unseen entries of the active thread, announces replies elsewhere, and refreshes the footer. */
  sync(): void {
    try {
      this.syncThreads();
    } catch (err) {
      this.deps.notify(`Chat refresh failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
    this.deps.setStatus(this.footerText());
  }

  footerText(): string | undefined {
    if (!this.active) return undefined;
    try {
      const t = this.deps.store.read(this.active);
      const title = t.title.replace(/\s+/g, " ").trim().slice(0, FOOTER_TITLE_MAX);
      let line = `💬 ${title} · ${t.model}`;
      if (t.pending) line += " · waiting";
      if (t.compacting) line += " · compacting";
      const { tokens, limit } = this.deps.chat.nextRequestEstimate(this.active);
      if (limit > 0 && tokens >= FOOTER_WARN_RATIO * limit) {
        line += ` · ${Math.max(0, 100 - Math.floor((tokens / limit) * 100))}% until compact`;
      }
      return line;
    } catch {
      return undefined;
    }
  }

  private syncThreads(): void {
    const { store, appendEntry, notify } = this.deps;
    for (const thread of store.list()) {
      const entries = store.transcript(thread.id).entries;
      if (thread.id === this.active) {
        for (const e of [...entries].sort((a, b) => a.seq - b.seq)) {
          const k = key(thread.id, e.seq);
          if (this.shown.has(k)) continue;
          this.shown.add(k);
          appendEntry(toDisplay(thread, e));
        }
        this.announced.set(thread.id, Math.max(this.announced.get(thread.id) ?? 0, maxAssistantSeq(entries)));
        continue;
      }
      const seen = this.announced.get(thread.id) ?? 0;
      const latest = maxAssistantSeq(entries);
      if (latest > seen) {
        this.announced.set(thread.id, latest);
        notify(`💬 reply in ${thread.title}`, "info");
      }
    }
  }
}
