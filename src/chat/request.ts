import type { ChatMessage } from "../openrouter/types.js";
import type { ThreadState, TranscriptEntry } from "./types.js";

export interface ChatPrompt {
  systemPrompt: string;
  projectInstructions?: string;
}

const TITLE_MAX = 60;

type Turn = Extract<TranscriptEntry, { type: "user" | "assistant" }>;

/**
 * Index just past the entry at `seq` in `entries` (conversation order): the entry with that seq if there is one,
 * otherwise the last entry with a lower seq. Bounds are positions, not seq ranges: a message queued while a reply
 * was pending has a lower seq than the reply but follows it in the conversation.
 */
function endOf(entries: TranscriptEntry[], seq: number): number {
  const exact = entries.findIndex((e) => e.seq === seq);
  if (exact >= 0) return exact + 1;
  let end = 0;
  entries.forEach((e, i) => {
    if (e.seq <= seq) end = i + 1;
  });
  return end;
}

/** The user and assistant entries after the summary's position, up to and including the entry at `throughSeq`. */
function turnsBetween(thread: ThreadState, entries: TranscriptEntry[], throughSeq: number): Turn[] {
  const from = thread.summary ? endOf(entries, thread.summary.throughSeq) : 0;
  return entries
    .slice(from, endOf(entries, throughSeq))
    .filter((e): e is Turn => e.type === "user" || e.type === "assistant");
}

function systemContent(thread: ThreadState, prompt: ChatPrompt): string {
  let content = prompt.systemPrompt;
  if (prompt.projectInstructions) content += `\n\n## Project instructions\n\n${prompt.projectInstructions}`;
  if (thread.summary) content += `\n\n## Summary of the earlier conversation\n\n${thread.summary.text}`;
  return content;
}

/**
 * Messages typed while a reply is pending are appended before that reply lands, so the transcript holds them ahead
 * of it. In the conversation they follow it. Returns the entries in conversation order (each such reply directly
 * after the last user entry it answers, its `throughSeq`), with their seqs unchanged. Every builder in this module
 * expects this order and reads a seq bound (a turn's `throughSeq`, `summary.throughSeq`, a compaction boundary) as
 * a position in it. Without queued messages the entries are returned unchanged.
 */
export function conversationOrder(entries: TranscriptEntry[]): TranscriptEntry[] {
  const userSeqs = entries.filter((e) => e.type === "user").map((e) => e.seq);
  let moved = false;
  const keyed = entries.map((e, i) => {
    let key = e.seq;
    if (e.type === "assistant" && e.throughSeq !== undefined) {
      const through = e.throughSeq;
      if (userSeqs.some((s) => s > through && s < e.seq)) {
        key = through;
        moved = true;
      }
    }
    return { e, i, key };
  });
  if (!moved) return entries;
  // Stable: a moved reply sorts directly after the user entry it answers (whose seq is its key).
  const rank = (x: { e: TranscriptEntry; key: number }) => (x.key !== x.e.seq ? 1 : 0);
  return keyed.sort((a, b) => a.key - b.key || rank(a) - rank(b) || a.i - b.i).map((x) => x.e);
}

function userTurnText(e: Extract<TranscriptEntry, { type: "user" }>): string {
  if (!e.inlinedText) return e.text;
  return e.text ? `${e.text}\n\n${e.inlinedText}` : e.inlinedText;
}

export function buildTurnMessages(
  thread: ThreadState,
  entries: TranscriptEntry[],
  throughSeq: number,
  prompt: ChatPrompt,
): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: systemContent(thread, prompt) }];
  for (const e of turnsBetween(thread, entries, throughSeq)) {
    const last = messages[messages.length - 1];
    if (e.type === "user") {
      const text = userTurnText(e);
      if (last?.role === "user") {
        last.content += `\n\n${text}`;
        if (e.parts && e.parts.length > 0) {
          last.parts = [...(last.parts ?? []), ...e.parts];
        }
      } else {
        messages.push({
          role: "user",
          content: text,
          ...(e.parts && e.parts.length > 0 ? { parts: [...e.parts] } : {}),
        });
      }
    } else {
      messages.push({ role: e.type, content: e.text });
    }
  }
  return messages;
}

/**
 * The seq of the reply that ends the last exchange before the `keepRecentExchanges` most recent ones (after the
 * current summary): a compaction covers everything up to and including it. Undefined when there is nothing to compact.
 */
export function compactionBoundary(
  thread: ThreadState,
  entries: TranscriptEntry[],
  keepRecentExchanges: number,
): number | undefined {
  const assistantSeqs: number[] = [];
  let sawUser = false;
  for (const e of turnsBetween(thread, entries, Number.MAX_SAFE_INTEGER)) {
    if (e.type === "user") sawUser = true;
    else if (sawUser) {
      assistantSeqs.push(e.seq);
      sawUser = false;
    }
  }
  const index = assistantSeqs.length - keepRecentExchanges - 1;
  return index >= 0 ? assistantSeqs[index] : undefined;
}

function plainTranscript(turns: Turn[]): string {
  return turns
    .map((e) => {
      if (e.type !== "user") return `Assistant (${e.model}): ${e.text}`;
      const body = userTurnText(e);
      return `User: ${body}`;
    })
    .join("\n\n");
}

export function buildCompactionMessages(
  thread: ThreadState,
  entries: TranscriptEntry[],
  boundary: number,
  prompt: ChatPrompt,
  instructions?: string,
): ChatMessage[] {
  let system =
    "You summarise a conversation between a user and an assistant so it can continue later with only your summary. " +
    "Be faithful: record the decisions made, the facts established, the open questions, and the user's stated preferences. " +
    "Do not invent anything. Reply with the summary only.";
  if (instructions) system += `\n\nFocus: ${instructions}`;
  const parts: string[] = [];
  if (thread.summary) parts.push(`Previous summary:\n\n${thread.summary.text}`);
  parts.push(`Conversation to summarise:\n\n${plainTranscript(turnsBetween(thread, entries, boundary))}`);
  return [
    { role: "system", content: system },
    { role: "user", content: parts.join("\n\n") },
  ];
}

export function buildTitleMessages(
  thread: ThreadState,
  entries: TranscriptEntry[],
  throughSeq: number,
): ChatMessage[] {
  const parts: string[] = [
    `Write a title for this conversation of at most ${TITLE_MAX} characters. Reply with only the title.`,
  ];
  if (thread.summary) parts.push(`Summary of the earlier conversation:\n\n${thread.summary.text}`);
  parts.push(`Conversation:\n\n${plainTranscript(turnsBetween(thread, entries, throughSeq))}`);
  return [{ role: "user", content: parts.join("\n\n") }];
}

export function estimateTokens(messages: ChatMessage[]): number {
  return Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 4);
}

export function provisionalTitle(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, TITLE_MAX);
}

export function cleanTitle(raw: string): string | undefined {
  const line = raw.split(/\r?\n/).find((l) => l.trim() !== "");
  if (line === undefined) return undefined;
  const strip = (s: string) => s.replace(/^[\s"'#*]+|[\s"'#*]+$/g, "");
  const title = strip(strip(line).replace(/^Title:/i, "")).slice(0, TITLE_MAX).trim();
  return title === "" ? undefined : title;
}
