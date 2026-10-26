import type { ChatMessage } from "../openrouter/types.js";
import type { ThreadState, TranscriptEntry } from "./types.js";

export interface ChatPrompt {
  systemPrompt: string;
  projectInstructions?: string;
}

const TITLE_MAX = 60;

type Turn = Extract<TranscriptEntry, { type: "user" | "assistant" }>;

function turnsBetween(thread: ThreadState, entries: TranscriptEntry[], throughSeq: number): Turn[] {
  const from = thread.summary?.throughSeq ?? 0;
  return entries.filter(
    (e): e is Turn => (e.type === "user" || e.type === "assistant") && e.seq > from && e.seq <= throughSeq,
  );
}

function systemContent(thread: ThreadState, prompt: ChatPrompt): string {
  let content = prompt.systemPrompt;
  if (prompt.projectInstructions) content += `\n\n## Project instructions\n\n${prompt.projectInstructions}`;
  if (thread.summary) content += `\n\n## Summary of the earlier conversation\n\n${thread.summary.text}`;
  return content;
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
    if (e.type === "user" && last?.role === "user") last.content += `\n\n${e.text}`;
    else messages.push({ role: e.type, content: e.text });
  }
  return messages;
}

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
    .map((e) => (e.type === "user" ? `User: ${e.text}` : `Assistant (${e.model}): ${e.text}`))
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
