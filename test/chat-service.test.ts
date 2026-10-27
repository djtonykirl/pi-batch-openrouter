import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { ChatBlockedError, ChatService } from "../src/chat/service.js";
import { ThreadBusyError, ThreadStore } from "../src/chat/store.js";
import type { TranscriptEntry } from "../src/chat/types.js";
import type { BatchConfig } from "../src/config.js";
import { acquireLock } from "../src/fsutil.js";
import type { ChatMessage } from "../src/openrouter/types.js";
import { BatchService } from "../src/service.js";
import { JobRegistry } from "../src/registry.js";
import { OpenRouterBatchClient } from "../src/openrouter/client.js";
import type { JobManifest } from "../src/types.js";
import { FAKE_KEY, FakeOpenRouter, accepted, makeConfig, makeService } from "./fixtures/fake-openrouter.js";
import { batchObject, chatCompletion, completed, failedItem, successItem } from "./fixtures/openrouter.js";
import { rm, tempWorkspace, writeFiles } from "./helpers.js";

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

/** Reconciles a chat job to its terminal state with the given provider results. */
async function settle(s: Setup, jobId: string, results: (customIds: string[]) => unknown[]): Promise<JobManifest> {
  const job = s.batch.registry.read(jobId);
  s.fake.getReplies = [{ status: 200, body: completed(results(job.customIds), { id: job.providerBatchId }) }];
  await s.batch.reconcile(jobId, { force: true });
  return s.batch.registry.read(jobId);
}

async function settleFailed(s: Setup, jobId: string): Promise<JobManifest> {
  s.fake.getReplies = [{ status: 200, body: batchObject({ id: s.batch.registry.read(jobId).providerBatchId, status: "failed" }) }];
  await s.batch.reconcile(jobId, { force: true });
  return s.batch.registry.read(jobId);
}

/** One full turn: send, settle with `reply` (plus an optional title item result), apply. */
async function turn(s: Setup, id: string, text: string, reply: string, titleResult?: (cid: string) => unknown): Promise<JobManifest> {
  const r = await s.chat.send(id, text);
  assert.equal(r.queued, false);
  const job = await settle(s, r.jobId!, (c) => [successItem(c[0]!, reply), ...(c[1] ? [titleResult ? titleResult(c[1]) : successItem(c[1], "Some title")] : [])]);
  s.chat.applySettled(job);
  return job;
}

function entries(s: Setup, id: string): TranscriptEntry[] {
  return s.store.transcript(id).entries;
}

function postedMessages(s: Setup, index: number, item = 0): ChatMessage[] {
  return (s.fake.accepted[index]!.requests[item]!.body as { messages: ChatMessage[] }).messages;
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const SECRET = "sk-or-v1-" + "a".repeat(64);

test(
  "send submits a turn and settle appends the reply",
  withSetup(async (s) => {
    const t = s.chat.newThread();
    assert.equal(t.model, s.cfg.defaultModel);
    assert.equal(t.account, s.cfg.defaultAccount);
    const r = await s.chat.send(t.id, "Hello   there,\nhow are you?");
    assert.equal(r.queued, false);
    assert.ok(r.jobId);
    assert.equal(s.store.read(t.id).pending?.jobId, r.jobId);
    const job = await settle(s, r.jobId!, (c) => [successItem(c[0]!, "Hello!")]);
    assert.equal(job.localStatus, "ready");
    s.chat.applySettled(job);
    const e = entries(s, t.id);
    assert.deepEqual(e.map((x) => x.type), ["user", "assistant"]);
    assert.equal(e[1]!.type === "assistant" && e[1]!.text, "Hello!");
    const thread = s.store.read(t.id);
    assert.equal(thread.pending, undefined);
    assert.equal(thread.title, "Hello there, how are you?");
    assert.equal(s.chat.mostRecent()?.id, t.id);
  }),
);

test(
  "empty or whitespace-only text is ignored",
  withSetup(async (s) => {
    const t = s.chat.newThread();
    assert.deepEqual(await s.chat.send(t.id, "  \n\t "), { queued: true });
    assert.equal(entries(s, t.id).length, 0);
    assert.equal(s.fake.requests.length, 0);
  }),
);

test(
  "secret in message is refused before anything is written",
  withSetup(async (s) => {
    const t = s.chat.newThread();
    const before = s.fake.requests.length;
    await assert.rejects(s.chat.send(t.id, "key " + SECRET), (e: unknown) => e instanceof ChatBlockedError && /not saved/.test((e as Error).message));
    assert.equal(entries(s, t.id).length, 0);
    assert.equal(s.fake.requests.length, before);
    assert.equal(s.store.read(t.id).title, "(untitled)");
  }),
);

test(
  "secret in .pi/BATCH_CHAT.md blocks the send",
  withSetup(async (s) => {
    writeFiles(s.root, { ".pi/BATCH_CHAT.md": `Use this key: ${SECRET}\n` });
    const t = s.chat.newThread();
    await assert.rejects(s.chat.send(t.id, "harmless"), ChatBlockedError);
    assert.equal(entries(s, t.id).length, 0);
    assert.equal(s.fake.requests.length, 0);
  }),
);

test(
  "BATCH_CHAT.md content reaches the system prompt",
  withSetup(async (s) => {
    writeFiles(s.root, { ".pi/BATCH_CHAT.md": "Always answer in British English." });
    const t = s.chat.newThread();
    await s.chat.send(t.id, "colour?");
    const system = postedMessages(s, 0)[0]!;
    assert.equal(system.role, "system");
    assert.ok(system.content.startsWith(s.cfg.chat.systemPrompt));
    assert.ok(system.content.includes("Always answer in British English."));
  }),
);

test(
  "messages typed while pending are combined into the next turn",
  withSetup(async (s) => {
    const t = s.chat.newThread();
    const a = await s.chat.send(t.id, "A");
    assert.deepEqual(await s.chat.send(t.id, "B"), { queued: true });
    assert.deepEqual(await s.chat.send(t.id, "C"), { queued: true });
    assert.equal(s.fake.accepted.length, 1);
    const job = await settle(s, a.jobId!, (c) => [successItem(c[0]!, "Hello!")]);
    s.chat.applySettled(job);
    await waitFor(() => s.fake.accepted.length === 2);
    const msgs = postedMessages(s, 1);
    assert.deepEqual(
      msgs.slice(1).map((m) => [m.role, m.content]),
      [
        ["user", "A"],
        ["assistant", "Hello!"],
        ["user", "B\n\nC"],
      ],
    );
    await waitFor(() => s.store.read(t.id).pending?.jobId !== undefined);
    // A second tick (e.g. another process) must not send the same queue twice.
    await s.chat.tick();
    assert.equal(s.fake.accepted.length, 2);
  }),
);

test(
  "model switch while pending labels the reply with the job's model",
  withSetup(async (s) => {
    const t = s.chat.newThread();
    const x = t.model;
    const r = await s.chat.send(t.id, "first");
    await s.chat.setModel(t.id, "y/model:batch");
    assert.equal(s.store.read(t.id).model, "y/model");
    const job = await settle(s, r.jobId!, (c) => [successItem(c[0]!, "reply")]);
    s.chat.applySettled(job);
    const e = entries(s, t.id);
    const model = e.find((x) => x.type === "model");
    assert.deepEqual(model && { from: model.from, to: model.to }, { from: x, to: "y/model" });
    const reply = e.find((x) => x.type === "assistant");
    assert.equal(reply?.type === "assistant" && reply.model, x);
    await s.chat.send(t.id, "second");
    assert.equal(s.fake.accepted[1]!.model, "y/model");
  }),
);

test(
  "truncated reply is kept with finishReason",
  withSetup(async (s) => {
    const t = s.chat.newThread();
    const r = await s.chat.send(t.id, "write a lot");
    const job = await settle(s, r.jobId!, (c) => [
      successItem(c[0]!, "partial answer", { choices: [{ index: 0, message: { role: "assistant", content: "partial answer" }, finish_reason: "length" }] }),
    ]);
    s.chat.applySettled(job);
    const reply = entries(s, t.id).find((x) => x.type === "assistant");
    assert.equal(reply?.type === "assistant" && reply.finishReason, "length");
    assert.equal(reply?.type === "assistant" && reply.text, "partial answer");
  }),
);

test(
  "failed turn keeps the user message and blocks auto-send until retry",
  withSetup(async (s) => {
    const t = s.chat.newThread();
    const r = await s.chat.send(t.id, "A");
    const job = await settleFailed(s, r.jobId!);
    assert.equal(job.localStatus, "failed");
    s.chat.applySettled(job);
    let thread = s.store.read(t.id);
    assert.equal(thread.pending, undefined);
    assert.equal(thread.lastFailure?.purpose, "turn");
    assert.equal(thread.lastFailure?.jobId, r.jobId);
    assert.ok(entries(s, t.id).some((e) => e.type === "failure"));
    assert.deepEqual(await s.chat.send(t.id, "B"), { queued: true });
    await s.chat.tick();
    assert.equal(s.fake.accepted.length, 1);
    const jobId = await s.chat.retry(t.id);
    assert.equal(s.fake.accepted.length, 2);
    thread = s.store.read(t.id);
    assert.equal(thread.lastFailure, undefined);
    assert.equal(thread.pending?.jobId, jobId);
    const msgs = postedMessages(s, 1);
    assert.deepEqual(msgs.slice(1), [{ role: "user", content: "A\n\nB" }]);
    await assert.rejects(s.chat.retry(t.id), /Nothing to retry/);
  }),
);

test(
  "retitle rides along on the 3rd turn and a manual rename locks it",
  withSetup(async (s) => {
    const t = s.chat.newThread();
    await turn(s, t.id, "one", "r1");
    await turn(s, t.id, "two", "r2");
    await turn(s, t.id, "three", "r3", (cid) => successItem(cid, '"Title: Auth redesign"'));
    assert.deepEqual(s.fake.accepted.map((a) => a.requests.length), [1, 1, 2]);
    const thread = s.store.read(t.id);
    assert.equal(thread.title, "Auth redesign");
    assert.equal(thread.retitled, true);
    const title = entries(s, t.id).find((e) => e.type === "title");
    assert.deepEqual(title && title.type === "title" && { title: title.title, source: title.source }, { title: "Auth redesign", source: "auto" });
    await turn(s, t.id, "four", "r4");
    assert.equal(s.fake.accepted[3]!.requests.length, 1);

    const t2 = s.chat.newThread();
    await turn(s, t2.id, "one", "r1");
    await turn(s, t2.id, "two", "r2");
    s.chat.rename(t2.id, "Mine");
    let th2 = s.store.read(t2.id);
    assert.equal(th2.title, "Mine");
    assert.equal(th2.titleLocked, true);
    await turn(s, t2.id, "three", "r3");
    assert.equal(s.fake.accepted[6]!.requests.length, 1);
    assert.equal(s.store.read(t2.id).title, "Mine");
    s.chat.rename(t2.id, { auto: true });
    th2 = s.store.read(t2.id);
    assert.equal(th2.titleLocked, false);
    assert.equal(th2.title, "Mine");
  }),
);

test(
  "failed title item does not fail the turn",
  withSetup(async (s) => {
    const t = s.chat.newThread();
    await turn(s, t.id, "one", "r1");
    await turn(s, t.id, "two", "r2");
    const job = await turn(s, t.id, "three", "r3", (cid) => failedItem(cid));
    assert.equal(job.localStatus, "partial");
    const e = entries(s, t.id);
    assert.equal(e.filter((x) => x.type === "assistant").length, 3);
    assert.equal(e.some((x) => x.type === "failure" || x.type === "title"), false);
    const thread = s.store.read(t.id);
    assert.equal(thread.title, "one");
    assert.equal(thread.lastFailure, undefined);
    assert.equal(thread.pending, undefined);
  }),
);

test(
  "applySettled is idempotent and cross-instance",
  withSetup(async (s) => {
    const t = s.chat.newThread();
    const r = await s.chat.send(t.id, "hi");
    const job = await settle(s, r.jobId!, (c) => [successItem(c[0]!, "Hello!")]);
    const other = new ChatService({ store: new ThreadStore(s.store.root), batch: makeService(s.root, s.fake, s.cfg), workspaceRoot: s.root, getConfig: () => s.cfg });
    other.applySettled(job);
    assert.equal(entries(s, t.id).length, 2);
    other.applySettled(job);
    s.chat.applySettled(job);
    await s.chat.tick();
    assert.equal(entries(s, t.id).length, 2);
  }),
);

test(
  "restart recovery",
  withSetup(async (s) => {
    const t = s.chat.newThread();
    const r = await s.chat.send(t.id, "hi");
    await settle(s, r.jobId!, (c) => [successItem(c[0]!, "Hello!")]);
    // No ChatService saw the settle; a fresh instance (new Pi process) picks it up.
    const fresh = new ChatService({ store: new ThreadStore(s.store.root), batch: makeService(s.root, s.fake, s.cfg), workspaceRoot: s.root, getConfig: () => s.cfg });
    await fresh.tick();
    const e = entries(s, t.id);
    assert.deepEqual(e.map((x) => x.type), ["user", "assistant"]);
    assert.equal(s.store.read(t.id).pending, undefined);
  }),
);

test(
  "stale claim expires",
  withSetup(async (s) => {
    const t = s.chat.newThread();
    s.store.update(t.id, (th, append) => {
      const e = append({ type: "user", text: "lost" });
      th.pending = { throughSeq: e.seq, claimedAt: new Date(Date.now() - 121_000).toISOString() };
    });
    await s.chat.tick();
    const thread = s.store.read(t.id);
    assert.equal(thread.pending, undefined);
    assert.equal(thread.lastFailure?.purpose, "turn");
    assert.ok(entries(s, t.id).some((e) => e.type === "failure"));
    assert.equal(s.fake.requests.length, 0);
  }),
);

test(
  "fresh claim without a job is left alone",
  withSetup(async (s) => {
    const t = s.chat.newThread();
    s.store.update(t.id, (th, append) => {
      const e = append({ type: "user", text: "in flight" });
      th.pending = { throughSeq: e.seq, claimedAt: new Date(Date.now() - 5_000).toISOString() };
    });
    await s.chat.tick();
    const thread = s.store.read(t.id);
    assert.ok(thread.pending);
    assert.equal(thread.lastFailure, undefined);
  }),
);

test(
  "provider rejection at submit records a failure",
  withSetup(async (s) => {
    s.fake.submitReplies = [{ status: 400, body: { error: { code: 400, message: "model has no batch endpoint" } } }];
    const t = s.chat.newThread();
    const r = await s.chat.send(t.id, "hi");
    assert.equal(r.queued, false);
    const thread = s.store.read(t.id);
    assert.equal(thread.pending, undefined);
    assert.match(thread.lastFailure?.message ?? "", /no batch endpoint/);
    assert.ok(entries(s, t.id).some((e) => e.type === "failure"));
  }),
);

test(
  "ThreadBusyError surfaces and nothing is written",
  withSetup(async (s) => {
    const t = s.chat.newThread();
    const lock = acquireLock(join(s.store.root, t.id, "thread.lock"), 0);
    try {
      await assert.rejects(s.chat.send(t.id, "hi"), ThreadBusyError);
    } finally {
      lock.release();
    }
    assert.equal(entries(s, t.id).length, 0);
    assert.equal(s.fake.requests.length, 0);
  }),
);

test(
  "nextRequestEstimate reports the size of the next request",
  withSetup(async (s) => {
    const t = s.chat.newThread();
    await turn(s, t.id, "x".repeat(400), "y".repeat(400));
    const est = s.chat.nextRequestEstimate(t.id);
    assert.equal(est.limit, s.cfg.chat.autoCompactTokens);
    assert.equal(est.summaryTokens, 0);
    assert.equal(est.recentTokens, 200);
    assert.equal(est.tokens, Math.ceil((s.cfg.chat.systemPrompt.length + 800) / 4));
  }),
);

test("a free-model reply that settles inside submit is in the transcript when send returns, once", async () => {
  const root = tempWorkspace();
  try {
    const fake = new FakeOpenRouter();
    fake.chatReplies = [{ status: 200, body: chatCompletion("Free hello!") }];
    const cfg = makeConfig();
    let chat: ChatService | undefined;
    let settledCalls = 0;
    // Wired as the runtime does: onSettled fires inside submit, before ChatService has linked the claim.
    const batch = new BatchService({
      registry: new JobRegistry(join(root, ".pi", "batches")),
      workspaceRoot: root,
      getConfig: () => cfg,
      resolveApiKey: async () => FAKE_KEY,
      createClient: (apiKey, timeoutMs) => new OpenRouterBatchClient({ apiKey, fetchImpl: fake.fetch, timeoutMs }),
      gitIgnored: () => new Set(),
      onSettled: (job) => {
        settledCalls++;
        chat?.applySettled(job);
      },
    });
    const store = new ThreadStore(join(root, ".pi/batches/threads"));
    chat = new ChatService({ store, batch, workspaceRoot: root, getConfig: () => cfg });
    const t = chat.newThread();
    await chat.setModel(t.id, "meta/llama-free:free");

    const r = await chat.send(t.id, "hello");
    assert.equal(r.queued, false);
    assert.equal(batch.registry.read(r.jobId!).localStatus, "ready");
    assert.equal(settledCalls, 1);
    const assistant = () => store.transcript(t.id).entries.filter((e) => e.type === "assistant");
    assert.equal(assistant().length, 1, "applied without waiting for a tick");
    assert.equal(assistant()[0]!.type === "assistant" && assistant()[0]!.text, "Free hello!");
    assert.equal(store.read(t.id).pending, undefined);

    // Neither a later tick nor a repeated onSettled appends it again.
    await chat.tick();
    chat.applySettled(batch.registry.read(r.jobId!));
    assert.equal(assistant().length, 1);
    assert.equal(fake.requests.filter((x) => x.url.endsWith("/chat/completions")).length, 1);
  } finally {
    rm(root);
  }
});
