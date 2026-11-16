import { relativeTime } from "../humanize.js";
import { mcpWording } from "../mcp/wording.js";
import { conversationOrder } from "./request.js";
import type { ThreadStore } from "./store.js";
import type { ThreadState, TranscriptEntry } from "./types.js";

/**
 * Chat threads as the MCP server shows them. Only threads an agent started through `chat_start` (they carry
 * `ThreadState.mcp`) are visible: a thread the user opened in Pi or the web UI is their own conversation and is
 * never listed, read or sent to from here.
 */

export type ThreadStatus = "pending" | "failed" | "idle";

export function mcpThreads(store: ThreadStore): ThreadState[] {
  return store.list().filter((t) => t.mcp !== undefined);
}

export function threadStatus(t: ThreadState): ThreadStatus {
  return t.pending ? "pending" : t.lastFailure ? "failed" : "idle";
}

const STATUS_PHRASE: Record<ThreadStatus, string> = {
  pending: "waiting for a reply",
  failed: "last turn failed",
  idle: "no reply pending",
};

export function describeThread(t: ThreadState, now: Date = new Date()): string {
  return `"${t.title}" (${t.id}, ${STATUS_PHRASE[threadStatus(t)]}, updated ${relativeTime(t.updatedAt, now)})`;
}

const LATEST = new Set(["latest", "last", "newest", "recent", "current"]);
const FILLER = new Set(["the", "a", "an", "my", "our", "that", "this", "chat", "thread", "conversation", "about", "on", "with", "one"]);

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !FILLER.has(t));
}

/**
 * Resolves a natural reference to one MCP-started thread: "latest", an ID or unique ID suffix, its title, or topic
 * words from its title. Sending is billed, so an ambiguous reference is refused with the candidates listed.
 */
export function resolveThreadRef(store: ThreadStore, reference: string | undefined, now: Date = new Date()): ThreadState {
  const threads = mcpThreads(store);
  if (threads.length === 0) throw new Error("No chat thread has been started from here yet. Start one with chat_start once the user agrees.");
  const raw = (reference ?? "").trim();
  const list = () => threads.slice(0, 8).map((t) => `  - ${describeThread(t, now)}`).join("\n");
  if (!raw) return threads[0]!;

  const upper = raw.toUpperCase();
  const byId = threads.filter((t) => t.id.toUpperCase() === upper || (upper.length >= 4 && t.id.toUpperCase().endsWith(upper)));
  if (byId.length === 1) return byId[0]!;
  const byTitle = threads.filter((t) => t.title.trim().toUpperCase() === upper);
  if (byTitle.length === 1) return byTitle[0]!;

  const words = tokens(raw);
  const topic = words.filter((w) => !LATEST.has(w));
  const pool = topic.length ? threads.filter((t) => topic.every((w) => tokens(t.title).some((x) => x.startsWith(w) || w.startsWith(x)))) : threads;
  // `threads` is newest first, so a recency word picks the newest of whatever matched.
  if (pool.length === 1 || (pool.length > 1 && words.some((w) => LATEST.has(w)))) return pool[0]!;
  if (pool.length > 1) throw new Error(`"${raw}" matches more than one chat thread. Which one did you mean?\n${pool.slice(0, 8).map((t) => `  - ${describeThread(t, now)}`).join("\n")}`);
  throw new Error(`I couldn't find a chat thread matching "${raw}". Threads started from here:\n${list()}`);
}

export interface ThreadMessage {
  seq: number;
  at: string;
  role: "user" | "assistant" | "failure";
  text: string;
  model?: string;
}

export interface ThreadView {
  threadId: string;
  title: string;
  model: string;
  status: ThreadStatus;
  /** The job the thread is waiting on, when a turn has been submitted. */
  pendingJobId?: string;
  failure?: string;
  turnBudget: number;
  turnsUsed: number;
  lastSeq: number;
  messages: ThreadMessage[];
}

function toMessage(e: TranscriptEntry): ThreadMessage | undefined {
  if (e.type === "user") {
    const files = e.attachments?.length ? `\n[attached: ${e.attachments.map((a) => a.name).join(", ")}]` : "";
    return { seq: e.seq, at: e.at, role: "user", text: e.text + files };
  }
  if (e.type === "assistant") return { seq: e.seq, at: e.at, role: "assistant", text: e.text, model: e.model };
  // Failure messages are stored with Pi command hints; this view names the MCP tools instead.
  if (e.type === "failure" && e.purpose === "turn") return { seq: e.seq, at: e.at, role: "failure", text: mcpWording(e.message) };
  return undefined;
}

/** The thread's state and its messages after `sinceSeq` (0 = all), in conversation order. */
export function readThreadView(store: ThreadStore, thread: ThreadState, sinceSeq = 0): ThreadView {
  const all = conversationOrder(store.transcript(thread.id).entries);
  const messages = all.map(toMessage).filter((m): m is ThreadMessage => m !== undefined && m.seq > sinceSeq);
  return {
    threadId: thread.id,
    title: thread.title,
    model: thread.model,
    status: threadStatus(thread),
    ...(thread.pending?.jobId ? { pendingJobId: thread.pending.jobId } : {}),
    ...(thread.lastFailure ? { failure: mcpWording(thread.lastFailure.message) } : {}),
    turnBudget: thread.mcp?.turnBudget ?? 0,
    turnsUsed: thread.mcp?.turnsUsed ?? 0,
    lastSeq: all.reduce((max, e) => Math.max(max, e.seq), 0),
    messages,
  };
}

/** Markdown for a tool result or resource. Keeps the newest messages when the text would exceed `maxCharacters`. */
export function renderThreadView(view: ThreadView, maxCharacters: number): { text: string; truncated: boolean } {
  const blocks = view.messages.map((m) => {
    const who = m.role === "user" ? "User" : m.role === "assistant" ? `Reply (${m.model})` : "Failed turn";
    return `### ${who} · #${m.seq}\n\n${m.text}`;
  });
  let truncated = false;
  let size = blocks.reduce((n, b) => n + b.length + 2, 0);
  while (blocks.length > 1 && size > maxCharacters) {
    size -= blocks.shift()!.length + 2;
    truncated = true;
  }
  if (blocks.length === 1 && blocks[0]!.length > maxCharacters) {
    blocks[0] = blocks[0]!.slice(0, maxCharacters) + "\n\n[TRUNCATED]";
    truncated = true;
  }
  const state =
    view.status === "pending"
      ? "A reply is pending. Batch replies usually take minutes to a few hours (at most 24h); read the thread again later."
      : view.status === "failed"
        ? `The last turn failed: ${view.failure ?? "unknown error"}`
        : "No reply is pending.";
  const head = `Chat thread "${view.title}" (${view.threadId}) on ${view.model}. ${state} Turns sent: ${view.turnsUsed} of ${view.turnBudget} agreed.`;
  const body = blocks.length ? blocks.join("\n\n") : "(no messages to show)";
  return { text: `${head}${truncated ? "\n(Older messages were left out to fit; pass since_seq to page.)" : ""}\n\n${body}`, truncated };
}
