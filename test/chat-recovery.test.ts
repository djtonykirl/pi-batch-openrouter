import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { ChatService, staleClaimMs } from "../src/chat/service.js";
import { ThreadStore } from "../src/chat/store.js";
import type { TranscriptEntry } from "../src/chat/types.js";
import type { BatchConfig } from "../src/config.js";
import type { LogFields, Logger, LogLevel } from "../src/logger.js";
import type { BatchService } from "../src/service.js";
import { CorruptManifestError, JobNotFoundError } from "../src/registry.js";
import type { JobManifest } from "../src/types.js";
import { FakeOpenRouter, accepted, makeConfig, makeService } from "./fixtures/fake-openrouter.js";
import { completed, successItem } from "./fixtures/openrouter.js";
import { rm, tempWorkspace, writeFiles } from "./helpers.js";

interface Setup {
  root: string;
  fake: FakeOpenRouter;
  batch: BatchService;
  store: ThreadStore;
  chat: ChatService;
  cfg: BatchConfig;
  logs: Array<{ level: LogLevel; event: string; fields?: LogFields }>;
}

function setup(over: (c: BatchConfig) => void = () => {}): Setup {
  const root = tempWorkspace();
  const fake = new FakeOpenRouter();
  let n = 0;
  fake.submitReplies = [async () => accepted(`batch_${++n}`)];
  const cfg = makeConfig(over);
  const batch = makeService(root, fake, cfg);
  const store = new ThreadStore(join(root, ".pi/batches/threads"));
  const logs: Setup["logs"] = [];
  const logger: Logger = { log: (level, event, fields) => logs.push({ level, event, fields }) };
  const chat = new ChatService({ store, batch, workspaceRoot: root, getConfig: () => cfg, logger });
  return { root, fake, batch, store, chat, cfg, logs };
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

async function settle(s: Setup, jobId: string, reply: string): Promise<JobManifest> {
  const job = s.batch.registry.read(jobId);
  s.fake.getReplies = [{ status: 200, body: completed([successItem(job.customIds[0]!, reply)], { id: job.providerBatchId }) }];
  await s.batch.reconcile(jobId, { force: true });
  return s.batch.registry.read(jobId);
}

function entries(s: Setup, id: string): TranscriptEntry[] {
  return s.store.transcript(id).entries;
}

function agoIso(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

/** A user entry with a claim on it, as a send that stopped mid-way would leave it. */
function claimed(s: Setup, id: string, ageMs: number): number {
  return s.store.update(id, (th, append) => {
    const e = append({ type: "user", text: "lost?" });
    th.pending = { throughSeq: e.seq, claimedAt: agoIso(ageMs) };
    return e.seq;
  });
}

// ------------------------------------------------------------------ C-I1

test("C-I1: the stale-claim threshold scales with polling.requestTimeoutSeconds", () => {
  assert.equal(staleClaimMs(makeConfig()), 120_000);
  assert.ok(staleClaimMs(makeConfig((c) => (c.polling.requestTimeoutSeconds = 600))) > 600_000);
});

test(
  "C-I1: a claim older than the default threshold is not expired while a long HTTP timeout may still be running",
  withSetup(
    async (s) => {
      const t = s.chat.newThread();
      claimed(s, t.id, 200_000);
      await s.chat.tick();
      assert.ok(s.store.read(t.id).pending, "claim kept: the submit could still be in flight");
      assert.equal(s.store.read(t.id).lastFailure, undefined);
    },
    (c) => (c.polling.requestTimeoutSeconds = 600),
  ),
);

test(
  "C-I1: a stale claim with a matching job in the registry is adopted, not failed, and its reply lands",
  withSetup(async (s) => {
    const t = s.chat.newThread();
    const seq = claimed(s, t.id, 200_000);
    // The job a stopped (or slow) send created and submitted after it claimed the thread.
    const job = await s.batch.createChatJob({ threadId: t.id, purpose: "turn", throughSeq: seq, model: "m/x", account: "openrouter", main: [{ role: "user", content: "lost?" }] });
    await s.chat.tick();
    let thread = s.store.read(t.id);
    assert.equal(thread.pending?.jobId, job.localId);
    assert.equal(thread.lastFailure, undefined);
    assert.equal(entries(s, t.id).some((e) => e.type === "failure"), false);
    await settle(s, job.localId, "Recovered reply");
    await s.chat.tick();
    thread = s.store.read(t.id);
    assert.equal(thread.pending, undefined);
    const last = entries(s, t.id).at(-1)!;
    assert.equal(last.type === "assistant" && last.text, "Recovered reply");
  }),
);

test(
  "C-I1: a job created before the claim (an older turn) is not adopted",
  withSetup(async (s) => {
    const t = s.chat.newThread();
    const seq = s.store.update(t.id, (_th, append) => append({ type: "user", text: "x" }).seq);
    await s.batch.createChatJob({ threadId: t.id, purpose: "turn", throughSeq: seq, model: "m/x", account: "openrouter", main: [{ role: "user", content: "x" }] });
    // The claim was made after that job was created (a later claim over the same messages).
    s.store.update(t.id, (th) => {
      th.pending = { throughSeq: seq, claimedAt: agoIso(-1000) };
    });
    // Let time pass so the claim is stale.
    const realNow = Date.now;
    Date.now = () => realNow() + 300_000;
    try {
      await s.chat.tick();
    } finally {
      Date.now = realNow;
    }
    const thread = s.store.read(t.id);
    assert.equal(thread.pending, undefined);
    assert.match(thread.lastFailure?.message ?? "", /never submitted/);
  }),
);

test(
  "C-I1: a claim that expires while the submit HTTP call is still running is adopted; the send still reports its job",
  withSetup(async (s) => {
    const t = s.chat.newThread();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    s.fake.submitReplies = [
      async () => {
        await gate;
        return accepted("batch_slow");
      },
    ];
    const sending = s.chat.send(t.id, "slow one");
    // Wait until the job exists (it is created before the HTTP call), then age the claim and run the poller tick.
    while (s.batch.registry.list().jobs.length === 0) await new Promise((r) => setTimeout(r, 5));
    s.store.update(t.id, (th) => {
      th.pending!.claimedAt = agoIso(500_000);
    });
    await s.chat.tick();
    const jobId = s.batch.registry.list().jobs[0]!.localId;
    assert.equal(s.store.read(t.id).pending?.jobId, jobId);
    assert.equal(s.store.read(t.id).lastFailure, undefined);
    release();
    const r = await sending;
    assert.equal(r.jobId, jobId);
    await settle(s, jobId, "Slow reply");
    await s.chat.tick();
    const last = entries(s, t.id).at(-1)!;
    assert.equal(last.type === "assistant" && last.text, "Slow reply");
    assert.equal(s.fake.accepted.length, 1, "billed exactly once");
  }),
);

test(
  "C-I1: a stale compaction claim with a matching job is adopted",
  withSetup(async (s) => {
    const t = s.chat.newThread();
    s.store.update(t.id, (th) => {
      th.compacting = { throughSeq: 2, claimedAt: agoIso(200_000) };
    });
    const job = await s.batch.createChatJob({ threadId: t.id, purpose: "compact", throughSeq: 2, model: "m/x", account: "openrouter", main: [{ role: "user", content: "summarise" }] });
    await s.chat.tick();
    const thread = s.store.read(t.id);
    assert.equal(thread.compacting?.jobId, job.localId);
    assert.equal(entries(s, t.id).some((e) => e.type === "failure"), false);
  }),
);

test(
  "C-I1: when the job cannot be linked, the send logs it and does not report the job as linked",
  withSetup(async (s) => {
    const t = s.chat.newThread();
    s.fake.submitReplies = [
      async () => {
        // Another process replaces the claim while the HTTP call runs.
        s.store.update(t.id, (th) => {
          th.pending = { throughSeq: th.pending!.throughSeq, claimedAt: agoIso(1) };
        });
        return accepted("batch_x");
      },
    ];
    const r = await s.chat.send(t.id, "hello");
    assert.equal(r.queued, false);
    assert.equal(r.jobId, undefined);
    assert.ok(s.logs.some((l) => l.event === "chat_job_link_failed"));
  }),
);

// ------------------------------------------------------------------ C-I2

/** Makes the next `count` registry reads of `jobId` throw `err`. */
function failReads(s: Setup, jobId: string, count: number, err: () => Error): void {
  const registry = s.batch.registry;
  const real = registry.read.bind(registry);
  let left = count;
  registry.read = (id: string) => {
    if (id === jobId && left > 0) {
      left--;
      throw err();
    }
    return real(id);
  };
}

test(
  "C-I2: a transient manifest read error leaves the pending turn intact, and the reply is applied on the next tick",
  withSetup(async (s) => {
    const t = s.chat.newThread();
    const r = await s.chat.send(t.id, "hello");
    await settle(s, r.jobId!, "Hi there");
    failReads(s, r.jobId!, 1, () => new CorruptManifestError(r.jobId!, "EBUSY: resource busy or locked"));
    await s.chat.tick();
    let thread = s.store.read(t.id);
    assert.equal(thread.pending?.jobId, r.jobId);
    assert.equal(thread.lastFailure, undefined);
    assert.equal(entries(s, t.id).some((e) => e.type === "failure"), false);
    await s.chat.tick();
    thread = s.store.read(t.id);
    assert.equal(thread.pending, undefined);
    const last = entries(s, t.id).at(-1)!;
    assert.equal(last.type === "assistant" && last.text, "Hi there");
  }),
);

test(
  "C-I2: a read error that persists across several ticks records the failure",
  withSetup(async (s) => {
    const t = s.chat.newThread();
    const r = await s.chat.send(t.id, "hello");
    failReads(s, r.jobId!, 100, () => new CorruptManifestError(r.jobId!, "Unexpected end of JSON input"));
    for (let i = 0; i < 10 && !s.store.read(t.id).lastFailure; i++) await s.chat.tick();
    const thread = s.store.read(t.id);
    assert.equal(thread.pending, undefined);
    assert.match(thread.lastFailure?.message ?? "", /can no longer be read/);
  }),
);

test(
  "C-I2: a job that no longer exists fails the turn on the first tick",
  withSetup(async (s) => {
    const t = s.chat.newThread();
    const r = await s.chat.send(t.id, "hello");
    failReads(s, r.jobId!, 100, () => new JobNotFoundError(r.jobId!));
    await s.chat.tick();
    assert.match(s.store.read(t.id).lastFailure?.message ?? "", /can no longer be read/);
  }),
);

test(
  "C-I2: a stale claim is not expired on the first tick while a manifest that could be its job is unreadable",
  withSetup(async (s) => {
    const t = s.chat.newThread();
    claimed(s, t.id, 200_000);
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    writeFiles(s.batch.registry.root, { [`B-${day}-ZZZZ/manifest.json`]: "{ half-written" });
    await s.chat.tick();
    assert.ok(s.store.read(t.id).pending, "kept while the unreadable manifest might be its job");
    for (let i = 0; i < 10 && s.store.read(t.id).pending; i++) await s.chat.tick();
    assert.match(s.store.read(t.id).lastFailure?.message ?? "", /never submitted/);
  }),
);

test(
  "C-I2: a transient read error on a compaction job leaves the compaction claim intact",
  withSetup(async (s) => {
    const t = s.chat.newThread();
    const job = await s.batch.createChatJob({ threadId: t.id, purpose: "compact", throughSeq: 2, model: "m/x", account: "openrouter", main: [{ role: "user", content: "summarise" }] });
    s.store.update(t.id, (th) => {
      th.compacting = { throughSeq: 2, claimedAt: agoIso(1000), jobId: job.localId };
    });
    failReads(s, job.localId, 1, () => new CorruptManifestError(job.localId, "EPERM: operation not permitted"));
    await s.chat.tick();
    assert.equal(s.store.read(t.id).compacting?.jobId, job.localId);
    assert.equal(entries(s, t.id).some((e) => e.type === "failure"), false);
  }),
);
