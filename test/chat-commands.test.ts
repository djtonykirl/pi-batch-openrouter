import assert from "node:assert/strict";
import test from "node:test";
import { CHAT_HELP, exportMarkdown, formatContext, formatCost } from "../src/chat/commands.js";
import type { ThreadState, TranscriptEntry } from "../src/chat/types.js";
import type { JobManifest } from "../src/types.js";

const thread = (over: Partial<ThreadState> = {}): ThreadState => ({
  schemaVersion: 1,
  id: "T-20261026-AAAA",
  title: "My chat",
  titleLocked: false,
  retitled: false,
  model: "openai/gpt-x",
  account: "openrouter",
  createdAt: "2026-10-26T10:00:00.000Z",
  updatedAt: "2026-10-26T10:00:00.000Z",
  nextSeq: 10,
  ...over,
});

const at = "2026-10-26T10:00:00.000Z";
const jobWith = (usage?: JobManifest["usage"]): JobManifest => ({ localId: "B-1", usage }) as unknown as JobManifest;

test("formatContext shows estimate, split and percent of limit", () => {
  const s = formatContext({ tokens: 3000, summaryTokens: 1000, recentTokens: 2000, limit: 6000 });
  assert.match(s, /3000/);
  assert.match(s, /summary/i);
  assert.match(s, /recent/i);
  assert.match(s, /50% of auto-compact limit/);
});

test("formatCost sums reported usage and says not reported otherwise", () => {
  const s = formatCost([jobWith({ cost: 0.5, totalTokens: 100 }), jobWith({ cost: 0.25, totalTokens: 50 }), jobWith(undefined)]);
  assert.match(s, /0\.75/);
  assert.match(s, /150/);
  assert.match(formatCost([jobWith(undefined)]), /not reported/);
  assert.match(formatCost([]), /not reported/);
});

test("exportMarkdown renders heading, roles, markers in conversation order", () => {
  const entries: TranscriptEntry[] = [
    { seq: 1, at, type: "user", text: "hello" },
    { seq: 2, at, type: "user", text: "queued behind" },
    { seq: 3, at, type: "assistant", text: "hi back", model: "openai/gpt-x", jobId: "B-1", finishReason: "length", throughSeq: 1 },
    { seq: 4, at, type: "compaction", summary: "SUMMARY TEXT", throughSeq: 1, jobId: "B-2", model: "m" },
    { seq: 5, at, type: "model", from: "a/b", to: "c/d" },
    { seq: 6, at, type: "title", title: "New name", source: "auto" },
  ];
  const md = exportMarkdown(thread(), entries);
  assert.match(md, /^# My chat/);
  assert.ok(md.includes("### You"));
  assert.ok(md.includes("### openai/gpt-x"));
  assert.ok(md.includes("SUMMARY TEXT"));
  assert.ok(md.includes("a/b") && md.includes("c/d"));
  assert.ok(md.includes("New name"));
  assert.ok(md.includes("(truncated: max_tokens)"));
  assert.ok(md.indexOf("hi back") < md.indexOf("queued behind"));
});

test("CHAT_HELP mentions every subcommand", () => {
  for (const w of "continue resume clear rename model compact context cost export off retry help".split(" ")) assert.ok(CHAT_HELP.includes(w), w);
});
