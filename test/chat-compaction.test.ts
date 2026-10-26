import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ChatBlockedError, ChatService } from "../src/chat/service.js";
import { ThreadStore } from "../src/chat/store.js";
import type { TranscriptEntry } from "../src/chat/types.js";
import type { BatchConfig } from "../src/config.js";
import type { ChatMessage } from "../src/openrouter/types.js";
import type { BatchService } from "../src/service.js";
import type { JobManifest } from "../src/types.js";
import { FakeOpenRouter, accepted, makeConfig, makeService } from "./fixtures/fake-openrouter.js";
import { batchObject, completed, successItem } from "./fixtures/openrouter.js";
import { rm, tempWorkspace } from "./helpers.js";

interface Setup {
  root: string;
  fake: FakeOpenRouter;
  batch: BatchService;
  store: ThreadStore;
  chat: ChatService;
  cfg: BatchConfig;
}

function setup(over: (c: BatchConfig) => void = () => {}): Setup {
  const root = tempWorkspace();
  const fake = new FakeOpenRouter();
  let n = 0;
  fake.submitReplies = [async () => accepted(`batch_${++n}`)];
  const cfg = makeConfig(over);
  const batch = makeService(root, fake, cfg);
  const store = new ThreadStore(join(root, ".pi/batches/threads"));
  const chat = new ChatService({ store, batch, workspaceRoot: root, getConfig: () => cfg });
  return { root, fake, batch, store, chat, cfg };
}

function withSetup(fn: (s: Setup) => Promise<void>, over?: (c: BatchConfig) => void): () => Promise<void> {
  return async () => {
    const s = setup(over);
    try {
      await fn(s);
    } finally {
      rm(s.root);
    }
  };
}

/** Reconciles a chat job to its terminal state: item 1 gets `text`, a title item gets "Some title". */
async function settle(s: Setup, jobId: string, text: string): Promise<JobManifest> {
  const job = s.batch.registry.read(jobId);
  const results = [successItem(job.customIds[0]!, text), ...(job.customIds[1] ? [successItem(job.customIds[1], "Some title")] : [])];
  s.fake.getReplies = [{ status: 200, body: completed(results, { id: job.providerBatchId }) }];
  await s.batch.reconcile(jobId, { force: true });
  return s.batch.registry.read(jobId);
}

async function settleFailed(s: Setup, jobId: string): Promise<JobManifest> {
  s.fake.getReplies = [{ status: 200, body: batchObject({ id: s.batch.registry.read(jobId).providerBatchId, status: "failed" }) }];
  await s.batch.reconcile(jobId, { force: true });
  return s.batch.registry.read(jobId);
}

async function turn(s: Setup, id: string, text: string, reply: string): Promise<void> {
  const r = await s.chat.send(id, text);
  assert.equal(r.queued, false);
  s.chat.applySettled(await settle(s, r.jobId!, reply));
}

async function exchanges(s: Setup, id: string, n: number, pad = ""): Promise<void> {
  for (let i = 1; i <= n; i++) await turn(s, id, `question ${i}${pad}`, `answer ${i}${pad}`);
}

function entries(s: Setup, id: string): TranscriptEntry[] {
  return s.store.transcript(id).entries;
}

function assistantSeq(s: Setup, id: string, text: string): number {
  const e = entries(s, id).find((x) => x.type === "assistant" && x.text === text);
  assert.ok(e, `no assistant entry "${text}"`);
  return e.seq;
}

function postedMessages(s: Setup, index: number, item = 0): ChatMessage[] {
  return (s.fake.accepted[index]!.requests[item]!.body as { messages: ChatMessage[] }).messages;
}

function lastPosted(s: Setup, item = 0): ChatMessage[] {
  return postedMessages(s, s.fake.accepted.length - 1, item);
}

const allText = (m: ChatMessage[]) => m.map((x) => x.content).join("\n");

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const noAuto = (c: BatchConfig) => {
  c.chat.autoCompact = false;
};

test(
  "manual compaction adopts the summary and later turns send it",
  withSetup(async (s) => {
    const t = s.chat.newThread();
    await exchanges(s, t.id, 6);
    const before = s.fake.accepted.length;
    const jobId = await s.chat.compact(t.id, "API decisions");
    assert.equal(s.fake.accepted.length, before + 1);
    const thread = s.store.read(t.id);
    assert.equal(thread.compacting?.jobId, jobId);
    assert.equal(thread.compacting?.instructions, "API decisions");
    const job = s.batch.registry.read(jobId);
    assert.equal(job.chat?.purpose, "compact");
    assert.equal(job.objective, `Chat compaction in ${t.id}`);
    const msgs = lastPosted(s);
    assert.equal(msgs[0]!.role, "system");
    assert.ok(msgs[0]!.content.includes("Focus: API decisions"));
    assert.ok(allText(msgs).includes("question 2"));
    assert.ok(!allText(msgs).includes("question 3"));

    s.chat.applySettled(await settle(s, jobId, "SUMMARY"));
    const after = s.store.read(t.id);
    assert.equal(after.compacting, undefined);
    assert.equal(after.summary?.text, "SUMMARY");
    assert.equal(after.summary?.throughSeq, assistantSeq(s, t.id, "answer 2"));
    assert.equal(after.summary?.jobId, jobId);
    const compaction = entries(s, t.id).find((e) => e.type === "compaction");
    assert.ok(compaction && compaction.type === "compaction");
    assert.equal(compaction.summary, "SUMMARY");
    assert.equal(compaction.instructions, "API decisions");
    assert.equal(after.title, "Some title");

    await s.chat.send(t.id, "next");
    const next = lastPosted(s);
    assert.ok(next[0]!.content.includes("SUMMARY"));
    assert.ok(!allText(next).includes("question 1"));
    assert.ok(!allText(next).includes("question 2"));
    assert.ok(allText(next).includes("question 3"));
    const transcript = readFileSync(join(s.store.root, t.id, "transcript.jsonl"), "utf8");
    assert.ok(transcript.includes("question 1"));
    assert.ok(transcript.includes("answer 1"));
  }, noAuto),
);

test(
  "nothing to compact",
  withSetup(async (s) => {
    const t = s.chat.newThread();
    await exchanges(s, t.id, 2);
    const before = s.fake.accepted.length;
    await assert.rejects(s.chat.compact(t.id), /Nothing to compact/);
    assert.equal(s.fake.accepted.length, before);
    assert.equal(s.store.read(t.id).compacting, undefined);
  }, noAuto),
);

test(
  "already compacting",
  withSetup(async (s) => {
    const t = s.chat.newThread();
    await exchanges(s, t.id, 6);
    await s.chat.compact(t.id);
    await assert.rejects(s.chat.compact(t.id), /Already compacting/);
  }, noAuto),
);

test(
  "a secret in the compaction instructions is refused",
  withSetup(async (s) => {
    const t = s.chat.newThread();
    await exchanges(s, t.id, 6);
    const before = s.fake.accepted.length;
    await assert.rejects(s.chat.compact(t.id, "key sk-or-v1-" + "a".repeat(64)), ChatBlockedError);
    assert.equal(s.fake.accepted.length, before);
    assert.equal(s.store.read(t.id).compacting, undefined);
  }, noAuto),
);

test(
  "a locked title gets no title item on compaction",
  withSetup(async (s) => {
    const t = s.chat.newThread();
    await exchanges(s, t.id, 6);
    s.chat.rename(t.id, "Mine");
    const jobId = await s.chat.compact(t.id);
    assert.equal(s.batch.registry.read(jobId).chat?.titleItem, false);
    s.chat.applySettled(await settle(s, jobId, "SUMMARY"));
    assert.equal(s.store.read(t.id).title, "Mine");
  }, noAuto),
);

test(
  "auto compaction triggers after a reply over the limit",
  withSetup(
    async (s) => {
      const t = s.chat.newThread();
      const pad = " " + "x".repeat(60);
      await exchanges(s, t.id, 2, pad);
      // Two exchanges with keep 1: a boundary exists and the estimate is over 50 tokens.
      await waitFor(() => s.store.read(t.id).compacting?.jobId !== undefined);
      const job = s.batch.registry.read(s.store.read(t.id).compacting!.jobId!);
      assert.equal(job.chat?.purpose, "compact");
      assert.equal(job.chat?.throughSeq, assistantSeq(s, t.id, `answer 1${pad}`));
    },
    (c) => {
      c.chat.autoCompactTokens = 50;
      c.chat.keepRecentExchanges = 1;
    },
  ),
);

test(
  "auto compaction does not start when disabled or under the limit",
  withSetup(
    async (s) => {
      const t = s.chat.newThread();
      await exchanges(s, t.id, 3);
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(s.store.read(t.id).compacting, undefined);
      assert.equal(s.fake.accepted.length, 3);
    },
    (c) => {
      c.chat.keepRecentExchanges = 1;
    },
  ),
);

test(
  "message sent during compaction goes out at once with the full history",
  withSetup(async (s) => {
    const t = s.chat.newThread();
    await exchanges(s, t.id, 6);
    await s.chat.compact(t.id);
    const before = s.fake.accepted.length;
    const r = await s.chat.send(t.id, "while compacting");
    assert.equal(r.queued, false);
    assert.equal(s.fake.accepted.length, before + 1);
    const msgs = lastPosted(s);
    assert.ok(allText(msgs).includes("question 1"));
    assert.ok(allText(msgs).includes("while compacting"));
  }, noAuto),
);

test(
  "compaction failure leaves the thread unchanged",
  withSetup(async (s) => {
    const t = s.chat.newThread();
    await exchanges(s, t.id, 6);
    const title = s.store.read(t.id).title;
    const jobId = await s.chat.compact(t.id);
    s.chat.applySettled(await settleFailed(s, jobId));
    const thread = s.store.read(t.id);
    assert.equal(thread.summary, undefined);
    assert.equal(thread.compacting, undefined);
    assert.equal(thread.lastFailure, undefined);
    assert.equal(thread.title, title);
    const failure = entries(s, t.id).find((e) => e.type === "failure");
    assert.ok(failure && failure.type === "failure");
    assert.equal(failure.purpose, "compact");
    assert.equal(failure.jobId, jobId);
    // Sending is unaffected.
    const r = await s.chat.send(t.id, "after failure");
    assert.equal(r.queued, false);
  }, noAuto),
);

test(
  "stale compaction result is not adopted",
  withSetup(async (s) => {
    const t = s.chat.newThread();
    await exchanges(s, t.id, 8);
    const jobId = await s.chat.compact(t.id);
    const covers = assistantSeq(s, t.id, "answer 4");
    assert.equal(s.batch.registry.read(jobId).chat?.throughSeq, covers);
    const later = assistantSeq(s, t.id, "answer 6");
    // Another compaction (e.g. in another process) already covers more.
    s.store.update(t.id, (th) => {
      th.summary = { text: "NEWER", throughSeq: later, jobId: "other" };
    });
    s.chat.applySettled(await settle(s, jobId, "OLDER"));
    const thread = s.store.read(t.id);
    assert.deepEqual(thread.summary, { text: "NEWER", throughSeq: later, jobId: "other" });
    assert.equal(thread.compacting, undefined);
    assert.ok(entries(s, t.id).some((e) => e.type === "compaction" && e.summary === "OLDER"));
  }, noAuto),
);

test(
  "a queued message after the compacted reply is still sent verbatim",
  withSetup(
    async (s) => {
      const t = s.chat.newThread();
      const a = await s.chat.send(t.id, "A-msg");
      assert.deepEqual(await s.chat.send(t.id, "B-queued"), { queued: true });
      s.chat.applySettled(await settle(s, a.jobId!, "reply-A"));
      await waitFor(() => s.store.read(t.id).pending?.jobId !== undefined);
      const bJob = s.store.read(t.id).pending!.jobId!;
      s.chat.applySettled(await settle(s, bJob, "reply-B"));
      // B has a lower seq than reply-A but follows it in the conversation.
      const replyA = assistantSeq(s, t.id, "reply-A");
      const b = entries(s, t.id).find((e) => e.type === "user" && e.text === "B-queued")!;
      assert.ok(b.seq < replyA);

      const jobId = await s.chat.compact(t.id);
      assert.equal(s.batch.registry.read(jobId).chat?.throughSeq, replyA);
      const compactMsgs = allText(lastPosted(s));
      assert.ok(compactMsgs.includes("A-msg"));
      assert.ok(compactMsgs.includes("reply-A"));
      assert.ok(!compactMsgs.includes("B-queued"));
      s.chat.applySettled(await settle(s, jobId, "SUMMARY"));
      assert.equal(s.store.read(t.id).summary?.throughSeq, replyA);

      await s.chat.send(t.id, "C-msg");
      const next = lastPosted(s);
      assert.ok(next[0]!.content.includes("SUMMARY"));
      assert.ok(!allText(next).includes("A-msg"));
      assert.ok(!allText(next).includes("reply-A"));
      assert.deepEqual(next.slice(1).map((m) => [m.role, m.content]), [
        ["user", "B-queued"],
        ["assistant", "reply-B"],
        ["user", "C-msg"],
      ]);
    },
    (c) => {
      c.chat.autoCompact = false;
      c.chat.keepRecentExchanges = 1;
    },
  ),
);

test(
  "tick settles a compaction that finished while no Pi was open",
  withSetup(async (s) => {
    const t = s.chat.newThread();
    await exchanges(s, t.id, 6);
    const jobId = await s.chat.compact(t.id);
    await settle(s, jobId, "SUMMARY");
    await s.chat.tick();
    assert.equal(s.store.read(t.id).summary?.text, "SUMMARY");
    assert.equal(s.store.read(t.id).compacting, undefined);
  }, noAuto),
);
