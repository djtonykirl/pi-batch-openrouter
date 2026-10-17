import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, type BatchConfig } from "../src/config.js";
import { OpenRouterBatchClient, type FetchLike } from "../src/openrouter/client.js";
import { JobRegistry } from "../src/registry.js";
import { BatchService, DuplicateActiveRequestError, SubmissionBlockedError, type AskOptions } from "../src/service.js";
import type { JobManifest } from "../src/types.js";
import { batchObject, completed, failedItem, successItem } from "./fixtures/openrouter.js";
import { rm, tempWorkspace, writeFiles } from "./helpers.js";

const FAKE_KEY = "sk-or-v1-" + "fa4e".repeat(16);

type Reply = { status: number; body: unknown } | Error | (() => Promise<{ status: number; body: unknown }>);

/** Scripted OpenRouter: queues of replies per route; records every request. */
class FakeOpenRouter {
  public readonly requests: Array<{ method: string; url: string; headers: Record<string, string>; body?: string }> = [];
  public submitReplies: Reply[] = [];
  public getReplies: Reply[] = [];
  public cancelReplies: Reply[] = [];
  public offline = false;

  public readonly fetch: FetchLike = async (url, init) => {
    this.requests.push({ method: init.method, url, headers: init.headers, body: init.body });
    if (this.offline) throw new TypeError("fetch failed (offline)");
    const queue = init.method === "POST" && url.endsWith("/batches") ? this.submitReplies : url.endsWith("/cancel") ? this.cancelReplies : this.getReplies;
    const reply = queue.length > 1 ? queue.shift()! : queue[0];
    if (!reply) throw new Error(`no scripted reply for ${init.method} ${url}`);
    if (reply instanceof Error) throw reply;
    const r = typeof reply === "function" ? await reply() : reply;
    return { status: r.status, text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)) };
  };
}

function makeConfig(): BatchConfig {
  const c = structuredClone(DEFAULT_CONFIG);
  c.polling.intervalSeconds = 60;
  c.polling.maxBackoffSeconds = 900;
  return c;
}

function makeService(root: string, fake: FakeOpenRouter, cfg = makeConfig(), settled: JobManifest[] = []) {
  return new BatchService({
    registry: new JobRegistry(path.join(root, ".pi", "batches")),
    workspaceRoot: root,
    getConfig: () => cfg,
    resolveApiKey: async () => FAKE_KEY,
    createClient: (apiKey, timeoutMs) => new OpenRouterBatchClient({ apiKey, fetchImpl: fake.fetch, timeoutMs }),
    gitIgnored: () => new Set(),
    onSettled: (j) => settled.push(j),
  });
}

const ASK: AskOptions = { objective: "Review the authentication design", files: ["src/auth.ts"], contexts: [], format: "markdown", includeInstructions: true };

function accepted(id = "batch_123") {
  return { status: 202, body: batchObject({ id }) };
}

async function submitOne(service: BatchService, fake: FakeOpenRouter, ask: AskOptions = ASK): Promise<JobManifest> {
  fake.submitReplies = [accepted()];
  const job = await service.createJob(await service.prepare(ask), { previewOnly: false });
  assert.equal(job.localStatus, "submitted");
  return job;
}

function withWorkspace(fn: (root: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const root = tempWorkspace();
    writeFiles(root, { "src/auth.ts": "export function login() { return true; }\r\n" });
    try {
      await fn(root);
    } finally {
      rm(root);
    }
  };
}

function allArtefactText(dir: string): string {
  let out = "";
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) out += fs.readFileSync(path.join(e.parentPath, e.name), "utf8");
  }
  return out;
}

test(
  "happy path: submit -> validating -> in_progress -> completed -> ready, with exact request and raw response preserved",
  withWorkspace(async (root) => {
    const fake = new FakeOpenRouter();
    const service = makeService(root, fake);
    const job = await submitOne(service, fake);
    const reg = service.registry;

    // Exact request bytes POSTed == preserved artefact; hash matches.
    const posted = fake.requests[0]!;
    assert.equal(posted.method, "POST");
    assert.equal(posted.headers.Authorization, `Bearer ${FAKE_KEY}`);
    const preserved = fs.readFileSync(reg.artefact(job.localId, "submittedRequest"), "utf8");
    assert.equal(posted.body, preserved);
    const body = JSON.parse(preserved);
    assert.deepEqual(Object.keys(body), ["endpoint", "model", "completion_window", "requests"]);
    assert.equal(body.requests[0].custom_id, `${job.localId}_request-001`);
    assert.match(fs.readFileSync(reg.artefact(job.localId, "requestSha"), "utf8"), new RegExp(`^${job.requestSha256}`));
    assert.equal(job.providerBatchId, "batch_123");
    assert.equal(job.providerStatus, "validating");

    const cid = job.customIds[0]!;
    fake.getReplies = [
      { status: 200, body: batchObject({ status: "validating" }) },
      { status: 200, body: batchObject({ status: "in_progress" }) },
      { status: 200, body: completed([successItem(cid, "## Findings\n\nNo confirmed defects.")]) },
    ];
    assert.equal((await service.reconcile(job.localId, { force: true })).status, "polling");
    assert.equal((await service.reconcile(job.localId, { force: true })).status, "polling");
    assert.equal((await service.reconcile(job.localId, { force: true })).status, "ready");

    const done = reg.read(job.localId);
    assert.equal(done.providerStatus, "completed");
    assert.equal(done.finalizedAt, "2026-10-15T14:26:10.000Z"); // seconds handled explicitly
    assert.deepEqual(done.usage, { inputTokens: 20, outputTokens: 40, totalTokens: 60, cost: 0.000225, isByok: false });
    assert.equal(done.completedCount, 1);
    assert.equal(done.failedCount, 0);

    const raw = fs.readFileSync(reg.artefact(job.localId, "finalResponse"), "utf8");
    assert.deepEqual(JSON.parse(raw), completed([successItem(cid, "## Findings\n\nNo confirmed defects.")]));
    assert.equal(service.read(job.localId, "default").body, "## Findings\n\nNo confirmed defects.\n");
    assert.match(service.read(job.localId, "full").body, /Usage: input 20 tok, output 40 tok, charged \$0\.000225/);

    const transitions = reg.events(job.localId).filter((e) => e.eventType === "transition");
    assert.deepEqual(
      transitions.map((e) => `${e.newStatus}${e.details?.providerStatus ? `(${e.details.providerStatus})` : ""}`),
      // polling->polling is recorded only because the provider status changed (validating -> in_progress).
      ["previewed", "submitting", "submitted(validating)", "polling(validating)", "polling(in_progress)", "provider_completed(completed)", "retrieving", "ready"],
    );

    // The API key never lands in artefacts.
    assert.ok(!allArtefactText(reg.jobDir(job.localId)).includes(FAKE_KEY));
  }),
);

test(
  "restart recovery: a fresh service over the same directory reconciles and reads without re-fetching",
  withWorkspace(async (root) => {
    const fake = new FakeOpenRouter();
    const job = await submitOne(makeService(root, fake), fake);
    // "Pi exits." A brand-new process/service starts later:
    const fake2 = new FakeOpenRouter();
    const service2 = makeService(root, fake2);
    const pending = service2.jobsNeedingReconcile().map((j) => j.localId);
    assert.deepEqual(pending, [job.localId]);
    fake2.getReplies = [{ status: 200, body: completed([successItem(job.customIds[0]!, "result after restart")]) }];
    await service2.reconcile(job.localId, { force: true });
    assert.equal(service2.registry.read(job.localId).localStatus, "ready");
    // Reading is purely local: go offline and read again from a third instance.
    const fake3 = new FakeOpenRouter();
    fake3.offline = true;
    assert.equal(makeService(root, fake3).read(job.localId, "default").body, "result after restart\n");
    assert.equal(fake3.requests.length, 0);
  }),
);

test(
  "provider failure and expiry map to failed / expired with evidence",
  withWorkspace(async (root) => {
    const fake = new FakeOpenRouter();
    const service = makeService(root, fake);
    const a = await submitOne(service, fake);
    fake.getReplies = [{ status: 200, body: batchObject({ status: "failed", error: { message: "requests rejected after validation" } }) }];
    await service.reconcile(a.localId, { force: true });
    const failed = service.registry.read(a.localId);
    assert.equal(failed.localStatus, "failed");
    assert.equal(failed.error?.message, "requests rejected after validation");

    const b = await submitOne(service, fake, { ...ASK, objective: "different objective" });
    fake.getReplies = [{ status: 200, body: batchObject({ status: "expired" }) }];
    await service.reconcile(b.localId, { force: true });
    assert.equal(service.registry.read(b.localId).localStatus, "expired");
  }),
);

test(
  "network loss while polling is transient: status kept, error recorded, backoff applied, then recovers",
  withWorkspace(async (root) => {
    const fake = new FakeOpenRouter();
    const service = makeService(root, fake);
    const job = await submitOne(service, fake);
    fake.getReplies = [new TypeError("fetch failed: ECONNRESET")];
    const o = await service.reconcile(job.localId, { force: true });
    assert.match(o.error!, /network/);
    let m = service.registry.read(job.localId);
    assert.equal(m.localStatus, "submitted");
    assert.equal(m.lastPollError?.category, "network");
    assert.equal(m.consecutivePollFailures, 1);
    assert.ok(Date.parse(m.nextPollAt!) > Date.now() + 50_000);

    fake.getReplies = [{ status: 503, body: { error: { code: 503, message: "upstream down" } } }];
    await service.reconcile(job.localId, { force: true });
    m = service.registry.read(job.localId);
    assert.equal(m.consecutivePollFailures, 2);
    assert.equal(m.lastPollError?.httpStatus, 503);
    assert.ok(Date.parse(m.nextPollAt!) > Date.now() + 110_000); // 60s * 2^1

    // Not due yet: a non-forced reconcile does nothing.
    assert.equal((await service.reconcile(job.localId)).skipped, "not_due");

    fake.getReplies = [{ status: 200, body: completed([successItem(job.customIds[0]!)]) }];
    await service.reconcile(job.localId, { force: true });
    m = service.registry.read(job.localId);
    assert.equal(m.localStatus, "ready");
    assert.equal(m.lastPollError, undefined);
    assert.equal(m.consecutivePollFailures, 0);
  }),
);

test(
  "timeout during submission -> failed/submission_unknown (never silently resubmitted)",
  withWorkspace(async (root) => {
    const fake = new FakeOpenRouter();
    const cfg = makeConfig();
    cfg.polling.requestTimeoutSeconds = 1;
    const service = makeService(root, fake, cfg);
    fake.submitReplies = [() => new Promise(() => {})]; // never answers
    const job = await service.createJob(await service.prepare(ASK), { previewOnly: false });
    assert.equal(job.localStatus, "failed");
    assert.equal(job.error?.code, "submission_unknown");
    assert.match(job.error!.message, /MAY have been accepted/);
  }),
);

test(
  "HTTP rejection at submit -> failed with provider error body preserved",
  withWorkspace(async (root) => {
    const fake = new FakeOpenRouter();
    const service = makeService(root, fake);
    fake.submitReplies = [{ status: 400, body: { error: { code: 400, message: "Model has no :batch endpoint" } } }];
    const job = await service.createJob(await service.prepare(ASK), { previewOnly: false });
    assert.equal(job.localStatus, "failed");
    assert.equal(job.error?.code, "submission_rejected_invalid_request");
    assert.equal(job.error?.message, "Model has no :batch endpoint");
    assert.match(fs.readFileSync(service.registry.artefact(job.localId, "submissionResponse"), "utf8"), /no :batch endpoint/);
  }),
);

test(
  "cancel race: cancellation requested but provider already completed -> real result, not 'cancelled'",
  withWorkspace(async (root) => {
    const fake = new FakeOpenRouter();
    const service = makeService(root, fake);
    const job = await submitOne(service, fake);
    fake.cancelReplies = [{ status: 404, body: { error: { code: 404, message: "Not Found" } } }];
    fake.getReplies = [{ status: 200, body: completed([successItem(job.customIds[0]!, "finished anyway")]) }];
    const { job: after, message } = await service.cancel(job.localId);
    assert.equal(after.localStatus, "ready");
    assert.ok(after.cancelRequestedAt);
    assert.match(message, /does not document a batch cancel endpoint/);
    assert.match(message, /already completed before cancellation took effect/);
    const t = service.registry.events(job.localId).filter((e) => e.eventType === "transition").map((e) => e.newStatus);
    assert.deepEqual(t.slice(-4), ["cancel_requested", "provider_completed", "retrieving", "ready"]);
  }),
);

test(
  "cancel that the provider honours -> cancelled, history kept",
  withWorkspace(async (root) => {
    const fake = new FakeOpenRouter();
    const service = makeService(root, fake);
    const job = await submitOne(service, fake);
    fake.cancelReplies = [{ status: 200, body: batchObject({ status: "cancelling" }) }];
    fake.getReplies = [{ status: 200, body: batchObject({ status: "cancelling" }) }, { status: 200, body: batchObject({ status: "cancelled" }) }];
    const first = await service.cancel(job.localId);
    assert.equal(first.job.localStatus, "cancel_requested");
    await service.reconcile(job.localId, { force: true });
    const m = service.registry.read(job.localId);
    assert.equal(m.localStatus, "cancelled");
    assert.ok(fs.existsSync(service.registry.artefact(job.localId, "submittedRequest")));
    assert.ok(service.registry.events(job.localId).some((e) => e.eventType === "cancel_provider_response"));
    assert.equal((await service.cancel(job.localId)).message.includes("already cancelled"), true);
  }),
);

test(
  "duplicate active submission is detected; preview jobs do not count",
  withWorkspace(async (root) => {
    const fake = new FakeOpenRouter();
    const service = makeService(root, fake);
    const preview = await service.createJob(await service.prepare(ASK), { previewOnly: true });
    assert.equal(preview.localStatus, "previewed");
    assert.equal(fake.requests.length, 0);
    const job = await submitOne(service, fake);
    await assert.rejects(service.createJob(await service.prepare(ASK), { previewOnly: false }), (err: unknown) => {
      assert.ok(err instanceof DuplicateActiveRequestError);
      assert.equal(err.existingId, job.localId);
      return true;
    });
    // Submitting the earlier preview is also caught as a duplicate.
    await assert.rejects(service.submit(preview.localId), DuplicateActiveRequestError);
  }),
);

test(
  "retry creates a linked job with the original request and leaves the original untouched",
  withWorkspace(async (root) => {
    const fake = new FakeOpenRouter();
    const service = makeService(root, fake);
    const job = await submitOne(service, fake);
    fake.getReplies = [{ status: 200, body: completed([failedItem(job.customIds[0]!)]) }];
    await service.reconcile(job.localId, { force: true });
    const before = fs.readFileSync(path.join(service.registry.jobDir(job.localId), "manifest.json"), "utf8");
    assert.equal(service.registry.read(job.localId).localStatus, "failed");

    fake.submitReplies = [accepted("batch_456")];
    const child = await service.retry(job.localId, { model: "openai/gpt-5-mini:batch" });
    assert.equal(child.parentJobId, job.localId);
    assert.equal(child.retryCount, 1);
    assert.equal(child.model, "openai/gpt-5-mini");
    assert.equal(child.providerBatchId, "batch_456");
    const parentBody = JSON.parse(fs.readFileSync(service.registry.artefact(job.localId, "submittedRequest"), "utf8"));
    const childBody = JSON.parse(fs.readFileSync(service.registry.artefact(child.localId, "submittedRequest"), "utf8"));
    assert.deepEqual(childBody.requests[0].body, parentBody.requests[0].body);
    assert.equal(childBody.requests[0].custom_id, `${child.localId}_request-001`);
    assert.equal(childBody.model, "openai/gpt-5-mini");
    // Original manifest unchanged; only an event was appended.
    assert.equal(fs.readFileSync(path.join(service.registry.jobDir(job.localId), "manifest.json"), "utf8"), before);
    assert.ok(service.registry.events(job.localId).some((e) => e.eventType === "retried" && e.details?.childJobId === child.localId));
    await assert.rejects(service.retry(child.localId), /only finished jobs/);
  }),
);

test(
  "malformed completed output -> corrupt; cannot be read as a result or injected",
  withWorkspace(async (root) => {
    const fake = new FakeOpenRouter();
    const service = makeService(root, fake);
    const job = await submitOne(service, fake);
    fake.getReplies = [{ status: 200, body: completed([successItem("someone-else_request-001")]) }];
    await service.reconcile(job.localId, { force: true });
    const m = service.registry.read(job.localId);
    assert.equal(m.localStatus, "corrupt");
    assert.match(m.error!.message, /unexpected custom_id/);
    assert.ok(fs.existsSync(service.registry.artefact(job.localId, "finalResponse")));
    assert.ok(!fs.existsSync(service.registry.artefact(job.localId, "resultMd")));
    const inj = service.buildInjection(job.localId, "full");
    assert.equal(inj.ok, false);
  }),
);

test(
  "completed with withheld results (HTTP 402) stays provider_completed, then retrieves later",
  withWorkspace(async (root) => {
    const fake = new FakeOpenRouter();
    const service = makeService(root, fake);
    const job = await submitOne(service, fake);
    fake.getReplies = [
      { status: 402, body: batchObject({ status: "completed", results: null }) },
      { status: 200, body: completed([successItem(job.customIds[0]!)]) },
    ];
    await service.reconcile(job.localId, { force: true });
    let m = service.registry.read(job.localId);
    assert.equal(m.localStatus, "provider_completed");
    assert.equal(m.lastPollError?.httpStatus, 402);
    assert.deepEqual(service.jobsNeedingReconcile().map((j) => j.localId), [job.localId]);
    await service.reconcile(job.localId, { force: true });
    m = service.registry.read(job.localId);
    assert.equal(m.localStatus, "ready");
  }),
);

test(
  "HTTP 410 (results purged) -> failed/results_gone",
  withWorkspace(async (root) => {
    const fake = new FakeOpenRouter();
    const service = makeService(root, fake);
    const job = await submitOne(service, fake);
    fake.getReplies = [{ status: 410, body: { error: { code: 410, message: "Batch results expired" } } }];
    await service.reconcile(job.localId, { force: true });
    const m = service.registry.read(job.localId);
    assert.equal(m.localStatus, "failed");
    assert.equal(m.error?.code, "results_gone");
  }),
);

test(
  "concurrent reconciles of the same job never overlap",
  withWorkspace(async (root) => {
    const fake = new FakeOpenRouter();
    const service = makeService(root, fake);
    const job = await submitOne(service, fake);
    fake.getReplies = [async () => (await new Promise((r) => setTimeout(r, 100)), { status: 200, body: batchObject({ status: "in_progress" }) })];
    const [a, b] = await Promise.all([service.reconcile(job.localId, { force: true }), service.reconcile(job.localId, { force: true })]);
    assert.deepEqual([a.skipped, b.skipped].sort(), ["locked", undefined].sort());
    assert.equal(service.registry.read(job.localId).pollAttempts, 1);
  }),
);

test(
  "crash while submitting is recovered as failed/submission_unknown on next start",
  withWorkspace(async (root) => {
    const fake = new FakeOpenRouter();
    const service = makeService(root, fake);
    const preview = await service.createJob(await service.prepare(ASK), { previewOnly: true });
    service.registry.update(preview.localId, (u) => {
      u.transition("submitting");
      u.manifest.createdAt = new Date(Date.now() - 120_000).toISOString();
    });
    const fresh = makeService(root, new FakeOpenRouter());
    await fresh.reconcile(preview.localId);
    const m = fresh.registry.read(preview.localId);
    assert.equal(m.localStatus, "failed");
    assert.equal(m.error?.code, "submission_unknown");
  }),
);

test(
  "secret in selected file blocks submission before anything is persisted or sent",
  withWorkspace(async (root) => {
    writeFiles(root, { "src/settings.json": `{ "client_secret": "${"Zx9" + "-cl13nt-s3cr3t-value"}" }` });
    const fake = new FakeOpenRouter();
    const service = makeService(root, fake);
    const prepared = await service.prepare({ ...ASK, files: ["src/settings.json"] });
    assert.equal(prepared.blockers.length, 1);
    assert.match(prepared.blockers[0]!, /File: src\/settings\.json\n {2}Line: 1\n {2}Type: client secret assignment/);
    await assert.rejects(service.createJob(prepared, { previewOnly: false }), SubmissionBlockedError);
    assert.equal(fake.requests.length, 0);
    assert.equal(service.registry.list().jobs.length, 0);
  }),
);

test(
  "injection: bounded by default, explicit --summary excerpt, --full, and status guard",
  withWorkspace(async (root) => {
    const fake = new FakeOpenRouter();
    const cfg = makeConfig();
    cfg.injection.maxCharacters = 2000;
    const service = makeService(root, fake, cfg);
    const job = await submitOne(service, fake);
    const big = Array.from({ length: 200 }, (_, i) => `line ${i} of the analysis`).join("\n");
    fake.getReplies = [{ status: 200, body: completed([successItem(job.customIds[0]!, big)]) }];
    await service.reconcile(job.localId, { force: true });

    const def = service.buildInjection(job.localId, "default");
    assert.equal(def.ok, false);
    assert.match((def as { message: string }).message, /Nothing was injected/);

    const sum = service.buildInjection(job.localId, "summary");
    assert.ok(sum.ok);
    assert.ok(sum.bounded);
    assert.ok(sum.characters <= 2000, `summary ${sum.characters} chars`);
    assert.match(sum.content, /^Deferred batch result: B-/);
    assert.match(sum.content, /Original objective:\nReview the authentication design/);
    assert.match(sum.content, /\[EXCERPT: first \d+ of \d+ result characters/);
    assert.match(sum.content, /Validate it against the current repository/);

    const full = service.buildInjection(job.localId, "full");
    assert.ok(full.ok && full.content.includes("line 199 of the analysis"));

    service.recordInjection(job.localId, { mode: "full", characters: full.characters, bounded: false });
    const m = service.registry.read(job.localId);
    assert.ok(m.injectedAt);
    assert.equal(m.injectionCount, 1);
    assert.ok(service.registry.events(job.localId).some((e) => e.eventType === "injected"));

    const other = await submitOne(service, fake, { ...ASK, objective: "still running" });
    const refused = service.buildInjection(other.localId, "full");
    assert.equal(refused.ok, false);
  }),
);

test(
  "partial results are injectable only with an explicit PARTIAL label",
  withWorkspace(async (root) => {
    const fake = new FakeOpenRouter();
    const service = makeService(root, fake);
    const job = await submitOne(service, fake);
    // Simulate a two-request job (Release 2 shape) to exercise partial.
    service.registry.update(job.localId, (u) => {
      u.manifest.customIds.push(`${job.localId}_request-002`);
      u.manifest.requestCount = 2;
    });
    fake.getReplies = [{ status: 200, body: completed([successItem(job.customIds[0]!, "half"), failedItem(`${job.localId}_request-002`)]) }];
    await service.reconcile(job.localId, { force: true });
    assert.equal(service.registry.read(job.localId).localStatus, "partial");
    const inj = service.buildInjection(job.localId, "default");
    assert.ok(inj.ok);
    assert.match(inj.content, /PARTIAL RESULT: 1 of 2 request\(s\) failed/);
    assert.match(service.read(job.localId, "default").body, /^⚠ Status: partial/);
  }),
);
