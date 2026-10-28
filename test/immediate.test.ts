import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";
import * as path from "node:path";
import { ModelCatalog } from "../src/models/catalog.js";
import { withFreeZdr } from "./fixtures/catalog.js";
import type { BatchConfig } from "../src/config.js";
import { atomicWriteJson } from "../src/fsutil.js";
import { itemText, jobItems } from "../src/items.js";
import { OpenRouterBatchClient } from "../src/openrouter/client.js";
import { classify429, immediateResultId, runImmediateJob } from "../src/openrouter/immediate.js";
import { normaliseBatchResult } from "../src/openrouter/normalise-result.js";
import type { BatchService } from "../src/service.js";
import type { JobManifest } from "../src/types.js";
import { FAKE_KEY, FakeOpenRouter, accepted, makeConfig, makeService } from "./fixtures/fake-openrouter.js";
import { chatCompletion } from "./fixtures/openrouter.js";
import { rm, tempWorkspace } from "./helpers.js";

const FREE = "meta/llama-free:free";
const DAILY = { error: { code: 429, message: "Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day" } };
const PER_MINUTE = { error: { code: 429, message: "Rate limit exceeded: free-models-per-min." } };

interface Ctx {
  service: BatchService;
  fake: FakeOpenRouter;
  cfg: BatchConfig;
  settled: JobManifest[];
}

function withService(level: BatchConfig["privacy"]["level"], fn: (c: Ctx) => Promise<void>): () => Promise<void> {
  return async () => {
    const root = tempWorkspace("pi batch immediate-");
    try {
      const fake = new FakeOpenRouter();
      const cfg = makeConfig((c) => {
        c.privacy.level = level;
      });
      const settled: JobManifest[] = [];
      const catalog = new ModelCatalog({ fetch: async () => withFreeZdr({ models: [], zdr: [] }), file: path.join(root, "catalog.json") });
      await catalog.load();
      await fn({ service: makeService(root, fake, cfg, settled, catalog), fake, cfg, settled });
    } finally {
      rm(root);
    }
  };
}

function chatJob(service: BatchService, opts: { title?: boolean; model?: string } = {}): Promise<JobManifest> {
  return service.createChatJob({
    threadId: "T-20261026-ABCD",
    purpose: "turn",
    throughSeq: 1,
    model: opts.model ?? FREE,
    account: "default",
    main: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "hello there" },
    ],
    ...(opts.title ? { title: [{ role: "user" as const, content: "Title this: hello there" }] } : {}),
  });
}

const chatPosts = (fake: FakeOpenRouter) => fake.requests.filter((r) => r.method === "POST" && r.url.endsWith("/chat/completions"));
const batchPosts = (fake: FakeOpenRouter) => fake.requests.filter((r) => r.url.includes("/batches"));

/**
 * An in-flight immediate chat job whose item 1 has no progress record yet (its first call got a
 * per-minute 429). Tests then write the record a crash would leave. The fake's request log is cleared.
 */
async function stoppedAfterSubmit(service: BatchService, fake: FakeOpenRouter): Promise<JobManifest> {
  fake.chatReplies = [{ status: 429, body: PER_MINUTE, headers: { "Retry-After": "1" } }];
  const job = await chatJob(service);
  assert.equal(job.route, "immediate");
  assert.equal(job.localStatus, "polling");
  assert.deepEqual(JSON.parse(fs.readFileSync(service.registry.artefact(job.localId, "immediateProgress"), "utf8")), {});
  fake.requests.length = 0;
  return job;
}

// ------------------------------------------------------------------ brief

test(
  "immediate job settles ready through the normal path",
  withService("standard", async ({ service, fake, settled }) => {
    fake.chatReplies = [{ status: 200, body: chatCompletion("Hi from a free model.") }];
    const job = await chatJob(service);
    assert.equal(job.localStatus, "ready", job.error?.message);
    const manifest = service.registry.read(job.localId);
    assert.equal(manifest.localStatus, "ready");
    assert.equal(manifest.route, "immediate");
    assert.equal(manifest.providerBatchId, undefined, "an immediate job never gets a batch ID");
    assert.equal(manifest.remoteDeletion, undefined);
    assert.ok(manifest.finalResponseFile);
    const [item] = jobItems(service.registry, manifest);
    assert.equal(itemText(service.registry, manifest, item!)?.trimEnd(), "Hi from a free model.");
    assert.deepEqual(manifest.usage, { inputTokens: 12, outputTokens: 8, totalTokens: 20, cost: 0 });
    assert.equal(batchPosts(fake).length, 0);
    assert.equal(chatPosts(fake).length, 1);
    assert.equal(chatPosts(fake)[0]!.headers.Authorization, `Bearer ${FAKE_KEY}`);
    assert.ok(settled.some((j) => j.localId === job.localId && j.localStatus === "ready"));
  }),
);

test("immediate body carries the privacy fields", async () => {
  const cases = [
    { level: "standard", provider: undefined },
    { level: "no-training", provider: { data_collection: "deny" } },
    { level: "zdr", provider: { zdr: true } },
  ] as const;
  for (const c of cases) {
    await withService(c.level, async ({ service, fake }) => {
      fake.chatReplies = [{ status: 200, body: chatCompletion() }];
      const job = await chatJob(service);
      assert.equal(job.localStatus, "ready", job.error?.message);
      const raw = chatPosts(fake)[0]!.body!;
      const body = JSON.parse(raw) as Record<string, unknown>;
      assert.equal(body.model, FREE);
      assert.deepEqual(body.messages, [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "hello there" },
      ]);
      assert.equal(body.max_tokens, makeConfig().request.maxTokens);
      assert.ok(!("custom_id" in body));
      if (c.provider === undefined) assert.ok(!("provider" in body), raw);
      else assert.deepEqual(body.provider, c.provider);
      if (c.level === "no-training") assert.match(raw, /"data_collection":"deny"/);
      if (c.level === "zdr") assert.match(raw, /"zdr":true/);
    })();
  }
});

test(
  "per-minute 429 reschedules without failure",
  withService("standard", async ({ service, fake }) => {
    fake.chatReplies = [{ status: 429, body: PER_MINUTE, headers: { "Retry-After": "20" } }];
    const before = Date.now();
    const job = await chatJob(service);
    const m = service.registry.read(job.localId);
    assert.ok(m.localStatus === "submitted" || m.localStatus === "polling", m.localStatus);
    assert.equal(m.error, undefined);
    assert.equal(m.lastPollError, undefined);
    assert.equal(m.items![0]!.status, "submitted");
    const delay = Date.parse(m.nextPollAt!) - before;
    assert.ok(delay >= 19_000 && delay <= 22_000, `nextPollAt is ${delay} ms ahead`);

    // Not due yet: the poller leaves it alone.
    const early = await service.reconcile(job.localId);
    assert.equal(early.skipped, "not_due");
    assert.equal(chatPosts(fake).length, 1);

    fake.chatReplies = [{ status: 200, body: chatCompletion("Later.") }];
    const r = await service.reconcile(job.localId, { force: true });
    assert.equal(r.status, "ready");
    assert.equal(chatPosts(fake).length, 2);
    const done = service.registry.read(job.localId);
    assert.equal(itemText(service.registry, done, jobItems(service.registry, done)[0]!)?.trimEnd(), "Later.");
  }),
);

test(
  "per-minute 429 without Retry-After backs off 30 s x 2^attempt",
  withService("standard", async ({ service, fake }) => {
    fake.chatReplies = [{ status: 429, body: PER_MINUTE }];
    const job = await chatJob(service);
    const first = Date.parse(service.registry.read(job.localId).nextPollAt!) - Date.now();
    assert.ok(first > 28_000 && first <= 30_000, `first backoff ${first}`);
    await service.reconcile(job.localId, { force: true });
    const second = Date.parse(service.registry.read(job.localId).nextPollAt!) - Date.now();
    assert.ok(second > 58_000 && second <= 60_000, `second backoff ${second}`);
  }),
);

test(
  "daily 429 fails with rate_limited_daily",
  withService("standard", async ({ service, fake, settled }) => {
    fake.chatReplies = [{ status: 429, body: DAILY }];
    const job = await chatJob(service, { title: true });
    assert.equal(job.localStatus, "failed");
    assert.deepEqual(job.error, { code: "rate_limited_daily", message: "Free-model daily limit reached; try later or switch model" });
    assert.equal(chatPosts(fake).length, 1, "the title is not attempted after the reply failed");
    assert.ok(settled.some((j) => j.localId === job.localId));
  }),
);

test(
  "more than 8 consecutive 429s count as the daily limit",
  withService("standard", async ({ service, fake }) => {
    fake.chatReplies = [{ status: 429, body: PER_MINUTE, headers: { "Retry-After": "1" } }];
    const job = await chatJob(service);
    for (let i = 0; i < 7; i++) {
      const r = await service.reconcile(job.localId, { force: true });
      assert.notEqual(r.status, "failed", `attempt ${i + 2}`);
    }
    assert.equal(chatPosts(fake).length, 8);
    const r = await service.reconcile(job.localId, { force: true });
    assert.equal(r.status, "failed");
    assert.equal(service.registry.read(job.localId).error?.code, "rate_limited_daily");
  }),
);

test(
  "title item failure leaves the job partial with item 1 completed",
  withService("standard", async ({ service, fake }) => {
    fake.chatReplies = [
      { status: 200, body: chatCompletion("The reply.") },
      { status: 400, body: { error: { code: 400, message: "title prompt rejected" } } },
    ];
    const job = await chatJob(service, { title: true });
    assert.equal(job.localStatus, "partial");
    assert.equal(job.items![0]!.status, "completed");
    assert.equal(job.items![1]!.status, "failed");
    assert.match(job.items![1]!.error!.message, /title prompt rejected/);
    assert.equal(itemText(service.registry, job, jobItems(service.registry, job)[0]!)?.trimEnd(), "The reply.");
    const bodies = fake.chatBodies();
    assert.equal(bodies.length, 2);
    assert.deepEqual(bodies[1]!.messages, [{ role: "user", content: "Title this: hello there" }]);
  }),
);

test(
  "batch jobs never call chat completions",
  withService("standard", async ({ service, fake }) => {
    fake.submitReplies = [accepted("batch_9")];
    fake.chatReplies = [new Error("chat completions must not be called")];
    const job = await chatJob(service, { model: "openai/gpt-4o-mini", title: true });
    assert.equal(job.localStatus, "submitted");
    assert.equal(job.providerBatchId, "batch_9");
    fake.getReplies = [{ status: 200, body: { id: "batch_9", status: "in_progress" } }];
    await service.reconcile(job.localId, { force: true });
    assert.equal(chatPosts(fake).length, 0);
  }),
);

// ----------------------------------------------------------- crash safety

test(
  "a restart after item 1 completed sends only item 2",
  withService("standard", async ({ service, fake }) => {
    fake.chatReplies = [
      { status: 200, body: chatCompletion("Reply.") },
      { status: 429, body: PER_MINUTE, headers: { "Retry-After": "5" } },
    ];
    const job = await chatJob(service, { title: true });
    assert.ok(job.localStatus === "submitted" || job.localStatus === "polling", job.localStatus);
    fake.chatReplies = [{ status: 200, body: chatCompletion("A title") }];
    const r = await service.reconcile(job.localId, { force: true });
    assert.equal(r.status, "ready");
    const bodies = fake.chatBodies();
    assert.equal(bodies.length, 3);
    assert.deepEqual(bodies[2]!.messages, [{ role: "user", content: "Title this: hello there" }]);
  }),
);

test(
  "an item whose call started but never finished is never sent again",
  withService("standard", async ({ service, fake }) => {
    const job = await stoppedAfterSubmit(service, fake);
    // Pi stopped mid-call long ago: the provider may have answered (and counted) it.
    atomicWriteJson(service.registry.artefact(job.localId, "immediateProgress"), {
      [job.customIds[0]!]: { state: "started", at: new Date(Date.now() - 3_600_000).toISOString() },
    });
    fake.chatReplies = [new Error("must not be sent again")];
    const r = await service.reconcile(job.localId, { force: true });
    assert.equal(r.status, "failed");
    assert.equal(chatPosts(fake).length, 0);
    assert.equal(service.registry.read(job.localId).error?.code, "submission_unknown");
  }),
);

test(
  "a call started recently by another process is left alone",
  withService("standard", async ({ service, fake }) => {
    const job = await stoppedAfterSubmit(service, fake);
    atomicWriteJson(service.registry.artefact(job.localId, "immediateProgress"), {
      [job.customIds[0]!]: { state: "started", at: new Date().toISOString() },
    });
    fake.chatReplies = [new Error("must not be sent while in flight")];
    const r = await service.reconcile(job.localId, { force: true });
    assert.equal(chatPosts(fake).length, 0);
    assert.equal(r.polled, false);
    assert.equal(service.registry.read(job.localId).localStatus, "polling");
  }),
);

test(
  "a chat thread's provider pin is neither sent nor recorded on the immediate route",
  withService("standard", async ({ service, fake }) => {
    fake.chatReplies = [{ status: 200, body: chatCompletion() }];
    const job = await service.createChatJob({
      threadId: "T-20261026-ABCD",
      purpose: "turn",
      throughSeq: 1,
      model: FREE,
      account: "default",
      pin: { only: ["some-provider"], allow_fallbacks: false },
      main: [{ role: "user", content: "hello there" }],
    });
    assert.equal(job.localStatus, "ready", job.error?.message);
    assert.equal(job.providerPin, undefined);
    assert.ok(!("provider" in fake.chatBodies()[0]!));
  }),
);

test(
  "a timeout is not retried: the reply may have been produced",
  withService("standard", async ({ service, fake }) => {
    fake.chatReplies = [new TypeError("fetch failed (socket hang up)")];
    const job = await chatJob(service);
    assert.equal(job.localStatus, "failed");
    assert.equal(job.error?.code, "submission_unknown");
    await service.reconcile(job.localId, { force: true });
    assert.equal(chatPosts(fake).length, 1);
  }),
);

test(
  "a settled response saved before a crash finishes from disk without calling again",
  withService("standard", async ({ service, fake }) => {
    const job = await stoppedAfterSubmit(service, fake);
    atomicWriteJson(service.registry.artefact(job.localId, "immediateProgress"), {
      [job.customIds[0]!]: { state: "completed", at: new Date().toISOString(), status: 200, bodyText: JSON.stringify(chatCompletion("Saved.")) },
    });
    fake.chatReplies = [new Error("must not be called")];
    const r = await service.reconcile(job.localId, { force: true });
    assert.equal(r.status, "ready");
    assert.equal(chatPosts(fake).length, 0);
  }),
);

test(
  "a crash in retrieving before the final response was saved rebuilds it from progress without calling",
  withService("standard", async ({ service, fake }) => {
    const job = await stoppedAfterSubmit(service, fake);
    atomicWriteJson(service.registry.artefact(job.localId, "immediateProgress"), {
      [job.customIds[0]!]: { state: "completed", at: new Date().toISOString(), status: 200, bodyText: JSON.stringify(chatCompletion("Rebuilt.")) },
    });
    service.registry.update(job.localId, (u) => {
      u.transition("provider_completed");
      u.transition("retrieving");
    });
    assert.equal(service.registry.read(job.localId).finalResponseFile, undefined);
    fake.chatReplies = [new Error("must not be called")];
    const r = await service.reconcile(job.localId);
    assert.equal(r.status, "ready");
    assert.equal(chatPosts(fake).length, 0);
    const done = service.registry.read(job.localId);
    assert.ok(done.finalResponseFile);
    assert.equal(itemText(service.registry, done, jobItems(service.registry, done)[0]!)?.trimEnd(), "Rebuilt.");
  }),
);

test(
  "cancelling a waiting immediate job never calls the batch cancel endpoint",
  withService("standard", async ({ service, fake }) => {
    fake.chatReplies = [{ status: 429, body: PER_MINUTE, headers: { "Retry-After": "20" } }];
    const job = await chatJob(service);
    const { job: after } = await service.cancel(job.localId);
    assert.equal(after.localStatus, "cancelled");
    assert.equal(batchPosts(fake).length, 0);
  }),
);

// ------------------------------------------------------------- unit level

test("classify429 reads Retry-After and recognises daily limits", () => {
  assert.deepEqual(classify429({ status: 429, bodyText: JSON.stringify(PER_MINUTE), headers: { "retry-after": "20" } }), { daily: false, retryAfterMs: 20_000 });
  assert.deepEqual(classify429({ status: 429, bodyText: JSON.stringify(PER_MINUTE) }), { daily: false, retryAfterMs: 0 });
  assert.equal(classify429({ status: 429, bodyText: JSON.stringify(DAILY) }).daily, true);
  assert.equal(classify429({ status: 429, bodyText: "daily quota exhausted" }).daily, true);
});

test("runImmediateJob builds a final response normaliseBatchResult accepts", async () => {
  const fake = new FakeOpenRouter();
  fake.chatReplies = [{ status: 200, body: chatCompletion("one") }];
  const client = new OpenRouterBatchClient({ apiKey: FAKE_KEY, fetchImpl: fake.fetch });
  const job = { localId: "B-20261027-ABCD", model: FREE, customIds: ["B-20261027-ABCD-001"], consecutivePollFailures: 0 } as JobManifest;
  const out = await runImmediateJob(job, [{ custom_id: "B-20261027-ABCD-001", body: { messages: [{ role: "user", content: "hi" }] } }], client, "standard");
  assert.equal(out.kind, "done");
  if (out.kind !== "done") return;
  const n = normaliseBatchResult(out.finalResponseText, { localJobId: job.localId, providerBatchId: immediateResultId(job.localId), expectedCustomIds: job.customIds });
  assert.equal(n.outcome, "ready");
  assert.equal(n.items[0]!.text, "one");
  assert.deepEqual(n.warnings, []);
});
