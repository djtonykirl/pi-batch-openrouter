import assert from "node:assert/strict";
import test from "node:test";
import { buildCompactionMessages, buildTitleMessages, buildTurnMessages, estimateTokens } from "../src/chat/request.js";
import type { ThreadState, TranscriptEntry } from "../src/chat/types.js";

const AT = "2026-01-01T00:00:00.000Z";
const prompt = { systemPrompt: "SYS" };
const IMG = "data:image/png;base64," + "A".repeat(4000);

function thread(): ThreadState {
  return { schemaVersion: 1, id: "T-20260101-ABCD", title: "t", titleLocked: false, retitled: false, model: "m/x", account: "a", createdAt: AT, updatedAt: AT, nextSeq: 100 };
}

const withImage: TranscriptEntry = {
  seq: 1,
  at: AT,
  type: "user",
  text: "what is this?",
  attachments: [{ source: "upload", kind: "image", name: "a.png", mimeType: "image/png", bytes: 3000, sha256: "x", mode: "multimodal" }],
  parts: [{ type: "image_url", image_url: { url: IMG } }],
};
const reply: TranscriptEntry = { seq: 2, at: AT, type: "assistant", text: "a cat", model: "m/x", jobId: "J", throughSeq: 1 };
const next: TranscriptEntry = { seq: 3, at: AT, type: "user", text: "and now?" };

test("U-I6: estimateTokens counts attachment parts", () => {
  const n = estimateTokens([{ role: "user", content: "abcd", parts: [{ type: "image_url", image_url: { url: "x".repeat(400) } }] }]);
  assert.equal(n, Math.ceil(404 / 4));
  const f = estimateTokens([{ role: "user", content: "", parts: [{ type: "file", file: { filename: "b.pdf", file_data: "y".repeat(800) } }] }]);
  assert.equal(f, 200);
});

test("U-I6: an attachment is sent with its own turn only; later turns carry a placeholder", () => {
  const first = buildTurnMessages(thread(), [withImage], 1, prompt);
  assert.deepEqual(first[1]!.parts, withImage.type === "user" ? withImage.parts : undefined);

  const second = buildTurnMessages(thread(), [withImage, reply, next], 3, prompt);
  assert.equal(second.some((m) => m.parts !== undefined), false, "no parts re-sent");
  assert.equal(JSON.stringify(second).includes("base64,"), false);
  assert.match(second[1]!.content, /^what is this\?\n\n\[attached: a\.png \(image\/png, 3000 bytes\)\]$/);
  assert.equal(second[3]!.content, "and now?");
  // The estimate of the next request follows what is actually sent.
  assert.ok(estimateTokens(second) < 200);
  assert.ok(estimateTokens(first) > 1000);
});

test("U-I6: messages queued with an attachment while a reply is pending still send it with their turn", () => {
  const queued: TranscriptEntry = { ...withImage, seq: 2 } as TranscriptEntry;
  const first: TranscriptEntry = { seq: 1, at: AT, type: "user", text: "hi" };
  const r: TranscriptEntry = { seq: 3, at: AT, type: "assistant", text: "hello", model: "m/x", jobId: "J", throughSeq: 1 };
  // Conversation order: hi, hello, (queued image message).
  const m = buildTurnMessages(thread(), [first, r, queued], 2, prompt);
  assert.ok(m.at(-1)!.parts?.length === 1);
});

test("U-I6: compaction and title prompts never include raw base64", () => {
  const entries = [withImage, reply, next, { ...reply, seq: 4, throughSeq: 3 } as TranscriptEntry];
  const c = buildCompactionMessages(thread(), entries, 4, prompt);
  const t = buildTitleMessages(thread(), entries, 4);
  for (const m of [...c, ...t]) {
    assert.equal(m.parts, undefined);
    assert.equal(m.content.includes("base64,"), false);
  }
  assert.match(c[1]!.content, /\[attached: a\.png/);
});
