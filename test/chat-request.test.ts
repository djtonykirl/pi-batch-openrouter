import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCompactionMessages,
  buildTitleMessages,
  buildTurnMessages,
  cleanTitle,
  compactionBoundary,
  conversationOrder,
  estimateTokens,
  provisionalTitle,
} from "../src/chat/request.js";
import type { ThreadState, TranscriptEntry } from "../src/chat/types.js";

const AT = "2026-01-01T00:00:00.000Z";
const prompt = { systemPrompt: "SYS" };

function thread(over: Partial<ThreadState> = {}): ThreadState {
  return {
    schemaVersion: 1, id: "T-20260101-ABCD", title: "t", titleLocked: false, retitled: false,
    model: "m/x", account: "a", createdAt: AT, updatedAt: AT, nextSeq: 100, ...over,
  };
}
const u = (seq: number, text = `t${seq}`): TranscriptEntry => ({ seq, at: AT, type: "user", text });
const a = (seq: number, text = `a${seq}`): TranscriptEntry => ({ seq, at: AT, type: "assistant", text, model: "m/x", jobId: "J" });
function exchanges(n: number): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (let i = 1; i <= n; i++) out.push(u(i * 2 - 1), a(i * 2));
  return out;
}

describe("buildTurnMessages", () => {
  it("turn messages merge queued user entries", () => {
    const m = buildTurnMessages(thread(), [u(1), a(2), u(3), u(4)], 4, prompt);
    assert.deepEqual(m, [
      { role: "system", content: "SYS" },
      { role: "user", content: "t1" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "t3\n\nt4" },
    ]);
  });
  it("turn messages include project instructions and summary", () => {
    const m = buildTurnMessages(thread({ summary: { text: "S", throughSeq: 2, jobId: "J" } }), [u(1), a(2), u(3)], 3,
      { systemPrompt: "SYS", projectInstructions: "PI" });
    assert.ok(m[0]?.content.includes("## Project instructions\n\nPI"));
    assert.ok(m[0]?.content.includes("## Summary of the earlier conversation\n\nS"));
    assert.equal(m.length, 2);
    assert.equal(m[1]?.content, "t3");
  });
  it("turn messages skip model/title/status/failure entries", () => {
    const entries: TranscriptEntry[] = [
      u(1),
      { seq: 2, at: AT, type: "model", from: "a", to: "b" },
      { seq: 3, at: AT, type: "title", title: "x", source: "auto" },
      { seq: 4, at: AT, type: "status", text: "s" },
      { seq: 5, at: AT, type: "failure", purpose: "turn", message: "f" },
      u(6),
    ];
    const m = buildTurnMessages(thread(), entries, 6, prompt);
    assert.deepEqual(m.map((x) => x.role), ["system", "user"]);
    assert.equal(m[1]?.content, "t1\n\nt6");
  });
  it("respects throughSeq", () => {
    const m = buildTurnMessages(thread(), [u(1), a(2), u(3)], 2, prompt);
    assert.equal(m.length, 3);
  });
});

describe("compactionBoundary", () => {
  it("returns the assistant seq before the recent exchanges", () => {
    assert.equal(compactionBoundary(thread(), exchanges(6), 4), 4);
  });
  it("returns undefined when too few exchanges", () => {
    assert.equal(compactionBoundary(thread(), exchanges(4), 4), undefined);
  });
  it("counts only exchanges after the summary", () => {
    const t = thread({ summary: { text: "S", throughSeq: 4, jobId: "J" } });
    assert.equal(compactionBoundary(t, exchanges(8), 4), 8);
    assert.equal(compactionBoundary(t, exchanges(6), 4), undefined);
  });
});

describe("buildCompactionMessages", () => {
  it("compaction messages carry focus instructions", () => {
    const m = buildCompactionMessages(thread(), exchanges(2), 4, prompt, "API decisions");
    assert.equal(m[0]?.role, "system");
    assert.ok(m[0]?.content.includes("Focus: API decisions"));
    assert.equal(m[1]?.role, "user");
    assert.ok(m[1]?.content.includes("User: t1"));
    assert.ok(m[1]?.content.includes("Assistant (m/x): a2"));
  });
  it("includes previous summary and excludes covered entries", () => {
    const t = thread({ summary: { text: "PREV", throughSeq: 2, jobId: "J" } });
    const m = buildCompactionMessages(t, exchanges(3), 4, prompt);
    assert.ok(!m[0]?.content.includes("Focus:"));
    assert.ok(m[1]?.content.includes("PREV"));
    assert.ok(!m[1]?.content.includes("User: t1"));
    assert.ok(m[1]?.content.includes("User: t3"));
    assert.ok(!m[1]?.content.includes("User: t5"));
  });
});

describe("buildTitleMessages", () => {
  it("builds a single user message", () => {
    const m = buildTitleMessages(thread({ summary: { text: "SUM", throughSeq: 2, jobId: "J" } }), exchanges(2), 4);
    assert.equal(m.length, 1);
    assert.equal(m[0]?.role, "user");
    assert.ok(m[0]?.content.includes("60 characters"));
    assert.ok(m[0]?.content.includes("SUM"));
    assert.ok(m[0]?.content.includes("User: t3"));
    assert.ok(!m[0]?.content.includes("User: t1"));
  });
});

describe("helpers", () => {
  it("estimateTokens", () => {
    assert.equal(estimateTokens([{ role: "user", content: "x".repeat(10) }, { role: "user", content: "yyy" }]), 4);
  });
  it("provisionalTitle", () => {
    const t = provisionalTitle(("word ".repeat(10) + "\n").repeat(2));
    assert.equal(t, "word ".repeat(11) + "word…", "cut at a word boundary, with an ellipsis, within 60 characters");
    assert.ok(t.length <= 60);
    assert.ok(!t.includes("\n"));
    // The walk-through's title: never cut mid-word.
    assert.equal(
      provisionalTitle("How does the token cache work, and when does the refresh trigger fire exactly?"),
      "How does the token cache work, and when does the refresh…",
    );
    assert.equal(provisionalTitle("Short question"), "Short question");
    // One long word: cut it, still with the ellipsis.
    assert.equal(provisionalTitle("x".repeat(80)), "x".repeat(59) + "…");
  });
  it("cleanTitle truncates at a word boundary too", () => {
    assert.equal(cleanTitle("Title: " + "alpha ".repeat(15)), "alpha ".repeat(9) + "alpha…");
  });
  it("cleanTitle", () => {
    assert.equal(cleanTitle('  "Title: Auth redesign"\nmore'), "Auth redesign");
    assert.equal(cleanTitle("  \n "), undefined);
    assert.equal(cleanTitle("\n## **Hello**"), "Hello");
  });
});

describe("conversationOrder", () => {
  const ra = (seq: number, throughSeq: number): TranscriptEntry => ({ seq, at: AT, type: "assistant", text: `a${seq}`, model: "m/x", jobId: "J", throughSeq });
  it("moves messages queued while a reply was pending after that reply", () => {
    // A(1) sent; B(2), C(3) typed while pending; reply(4) to A; reply(5) to B+C.
    const ordered = conversationOrder([u(1, "A"), u(2, "B"), u(3, "C"), ra(4, 1), ra(5, 3)]);
    assert.deepEqual(ordered.map((e) => [e.type, e.seq]), [["user", 1], ["assistant", 4], ["user", 2], ["user", 3], ["assistant", 5]]);
    const m = buildTurnMessages(thread(), ordered, 3, prompt);
    assert.deepEqual(m.slice(1).map((x) => x.content), ["A", "a4", "B\n\nC"]);
  });
  it("a summary through a reply covers its position, not a seq range", () => {
    // A(1) sent; B(2) typed while pending; reply(3) to A; reply(4) to B.
    const ordered = conversationOrder([u(1, "A"), u(2, "B"), ra(3, 1), ra(4, 2)]);
    assert.equal(compactionBoundary(thread(), ordered, 1), 3);
    const c = buildCompactionMessages(thread(), ordered, 3, prompt);
    assert.ok(c[1]?.content.includes("User: A"));
    assert.ok(c[1]?.content.includes("a3"));
    assert.ok(!c[1]?.content.includes("User: B"));
    const t = thread({ summary: { text: "S", throughSeq: 3, jobId: "J" } });
    const m = buildTurnMessages(t, [...ordered, u(5, "C")], 5, prompt);
    assert.deepEqual(m.slice(1).map((x) => x.content), ["B", "a4", "C"]);
    assert.ok(buildTitleMessages(t, ordered, Number.MAX_SAFE_INTEGER)[0]?.content.includes("User: B"));
    assert.ok(!buildTitleMessages(t, ordered, Number.MAX_SAFE_INTEGER)[0]?.content.includes("User: A"));
    assert.equal(compactionBoundary(t, ordered, 0), 4);
  });
  it("a turn built while a reply is pending keeps the earlier reply", () => {
    // A(1), B(2) queued, reply(3) to A; B is claimed through 2 and C(4) is typed before the request is built.
    const ordered = conversationOrder([u(1, "A"), u(2, "B"), ra(3, 1), u(4, "C")]);
    const m = buildTurnMessages(thread(), ordered, 2, prompt);
    assert.deepEqual(m.slice(1).map((x) => x.content), ["A", "a3", "B"]);
  });
  it("leaves an unqueued transcript unchanged", () => {
    const plain = [u(1), ra(2, 1), u(3), { seq: 4, at: AT, type: "model", from: "a", to: "b" } as TranscriptEntry, ra(5, 3)];
    assert.deepEqual(conversationOrder(plain), plain);
    assert.equal(compactionBoundary(thread(), conversationOrder(exchanges(6)), 4), 4);
  });
});
