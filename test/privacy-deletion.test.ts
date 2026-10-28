import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import type { BatchConfig } from "../src/config.js";
import { ModelCatalog } from "../src/models/catalog.js";
import { OpenRouterBatchClient } from "../src/openrouter/client.js";
import type { ZdrEndpoint } from "../src/privacy/policy.js";
import { JobRegistry } from "../src/registry.js";
import { describeJob, retentionLine } from "../src/dashboard.js";
import { badgeText } from "../src/poller.js";
import { RETENTION_DELETED, RETENTION_KEPT } from "../src/privacy/policy.js";
import { BatchService, DELETION_TIME_LIMIT_MS, type AskOptions } from "../src/service.js";
import { FAKE_KEY, FakeOpenRouter, accepted, makeConfig } from "./fixtures/fake-openrouter.js";
import { batchObject, completed, successItem } from "./fixtures/openrouter.js";
import { rm, tempWorkspace, writeFiles } from "./helpers.js";

const ASK: AskOptions = { objective: "Review the authentication design", files: ["src/auth.ts"], contexts: [], format: "markdown", includeInstructions: true };
const ZDR: ZdrEndpoint[] = [{ model: "anthropic/claude-opus-5.5", provider: "anthropic" }];

function env(
  level: BatchConfig["privacy"]["level"],
  fn: (c: { service: BatchService; fake: FakeOpenRouter; cfg: BatchConfig; root: string; key: { value: string } }) => Promise<void>,
): () => Promise<void> {
  return async () => {
    const root = tempWorkspace("pi batch deletion-");
    writeFiles(root, { "src/auth.ts": "export function login() { return true; }\r\n" });
    try {
      const fake = new FakeOpenRouter();
      const cfg = makeConfig((c) => {
        c.privacy.level = level;
        c.privacy.accountNoTraining = true;
      });
      const catalog = new ModelCatalog({ fetch: async () => ({ models: [], zdr: ZDR }), file: path.join(root, "catalog.json") });
      await catalog.load();
      const key = { value: FAKE_KEY };
      const service = new BatchService({
        registry: new JobRegistry(path.join(root, ".pi", "batches")),
        workspaceRoot: root,
        getConfig: () => cfg,
        resolveApiKey: async () => key.value,
        createClient: (apiKey, timeoutMs) => new OpenRouterBatchClient({ apiKey, fetchImpl: fake.fetch, timeoutMs }),
        gitIgnored: () => new Set(),
        catalog,
      });
      await fn({ service, fake, cfg, root, key });
    } finally {
      rm(root);
    }
  };
}

async function settle(service: BatchService, fake: FakeOpenRouter) {
  fake.submitReplies = [accepted("batch_123")];
  const job = await service.createJob(await service.prepare(ASK), { previewOnly: false });
  assert.equal(job.localStatus, "submitted", job.error?.message);
  fake.getReplies = [{ status: 200, body: completed(job.customIds.map((c) => successItem(c)), { id: "batch_123" }) }];
  await service.reconcile(job.localId, { force: true });
  return job.localId;
}

const deletes = (fake: FakeOpenRouter) => fake.requests.filter((r) => r.method === "DELETE");

/** Moves a pending deletion's next attempt into the past (instead of waiting out the backoff). */
function makeDue(service: BatchService, id: string, extra: { firstAttemptAt?: string } = {}): void {
  service.registry.update(id, (u) => {
    const d = u.manifest.remoteDeletion!;
    u.manifest.remoteDeletion = { ...d, ...extra, nextAttemptAt: new Date(Date.now() - 1000).toISOString() };
  });
}

/** A submitted batch that OpenRouter then reports in `status` (failed, expired or cancelled). */
async function endsAs(service: BatchService, fake: FakeOpenRouter, status: "failed" | "expired" | "cancelled") {
  fake.submitReplies = [accepted("batch_123")];
  const job = await service.createJob(await service.prepare(ASK), { previewOnly: false });
  assert.equal(job.localStatus, "submitted", job.error?.message);
  fake.getReplies = [{ status: 200, body: batchObject({ id: "batch_123", status }) }];
  await service.reconcile(job.localId, { force: true });
  const m = service.registry.read(job.localId);
  assert.equal(m.localStatus, status);
  return m;
}

for (const level of ["zdr", "no-training"] as const) {
  test(
    `${level} job is deleted after retrieval`,
    env(level, async ({ service, fake }) => {
      const id = await settle(service, fake);
      assert.equal(service.registry.read(id).remoteDeletion?.state, "pending");
      fake.deleteReplies = [{ status: 204, body: "" }];
      await service.runRemoteDeletions();
      assert.equal(deletes(fake).length, 1);
      assert.ok(deletes(fake)[0]!.url.endsWith("/batches/batch_123"));
      const m = service.registry.read(id);
      assert.equal(m.remoteDeletion?.state, "done");
      assert.equal(m.localStatus, "ready");
      assert.ok(fs.existsSync(service.registry.artefact(id, "finalResponse")));
      await service.runRemoteDeletions();
      assert.equal(deletes(fake).length, 1, "done jobs are not deleted again");
    }),
  );
}

test(
  "delete failure is retried and never changes status",
  env("zdr", async ({ service, fake }) => {
    const id = await settle(service, fake);
    fake.deleteReplies = [{ status: 500, body: { error: { message: "boom" } } }, { status: 204, body: "" }];
    await service.runRemoteDeletions();
    let m = service.registry.read(id);
    assert.equal(m.remoteDeletion?.state, "pending");
    assert.equal(m.remoteDeletion?.attempts, 1);
    assert.match(m.remoteDeletion?.lastError ?? "", /500/);
    assert.equal(m.localStatus, "ready");
    await service.runRemoteDeletions();
    assert.equal(deletes(fake).length, 1, "not retried before nextAttemptAt");
    makeDue(service, id);
    await service.runRemoteDeletions();
    m = service.registry.read(id);
    assert.equal(m.remoteDeletion?.attempts, 2);
    assert.equal(m.remoteDeletion?.state, "done");
    assert.equal(m.localStatus, "ready");
  }),
);

test(
  "409 retries later",
  env("zdr", async ({ service, fake }) => {
    const id = await settle(service, fake);
    fake.deleteReplies = [{ status: 409, body: { error: { message: "not finished" } } }, { status: 200, body: {} }];
    await service.runRemoteDeletions();
    assert.equal(service.registry.read(id).remoteDeletion?.state, "pending");
    makeDue(service, id);
    await service.runRemoteDeletions();
    assert.equal(service.registry.read(id).remoteDeletion?.state, "done");
  }),
);

test(
  "404 counts as already deleted",
  env("zdr", async ({ service, fake }) => {
    const id = await settle(service, fake);
    fake.deleteReplies = [{ status: 404, body: { error: { message: "gone" } } }];
    await service.runRemoteDeletions();
    assert.equal(service.registry.read(id).remoteDeletion?.state, "done");
  }),
);

test(
  "retries back off exponentially (30 s x 2^n, capped at 1 h) and are not abandoned after a fixed count",
  env("zdr", async ({ service, fake }) => {
    const id = await settle(service, fake);
    fake.deleteReplies = [{ status: 500, body: "x" }];
    const expected = [30, 60, 120, 240, 480, 960, 1920, 3600, 3600, 3600, 3600, 3600];
    for (const [i, seconds] of expected.entries()) {
      const before = Date.now();
      await service.runRemoteDeletions();
      const d = service.registry.read(id).remoteDeletion!;
      assert.equal(d.state, "pending", `attempt ${i + 1}`);
      assert.equal(d.attempts, i + 1);
      const ahead = Date.parse(d.nextAttemptAt!) - before;
      assert.ok(ahead >= seconds * 1000 - 50 && ahead <= seconds * 1000 + 2000, `attempt ${i + 1}: next attempt ${ahead} ms ahead, expected ${seconds} s`);
      await service.runRemoteDeletions();
      assert.equal(deletes(fake).length, i + 1, "nothing is sent before nextAttemptAt");
      makeDue(service, id);
    }
    assert.equal(service.registry.read(id).localStatus, "ready");
  }),
);

test(
  "gives up as failed 24 hours after the first attempt; failed shows as needing attention",
  env("zdr", async ({ service, fake }) => {
    const id = await settle(service, fake);
    fake.deleteReplies = [{ status: 500, body: "x" }];
    await service.runRemoteDeletions();
    const first = service.registry.read(id).remoteDeletion!.firstAttemptAt!;
    assert.ok(first);
    makeDue(service, id);
    await service.runRemoteDeletions();
    assert.equal(service.registry.read(id).remoteDeletion?.firstAttemptAt, first, "the limit runs from the first attempt");
    // Just inside the limit: still retried.
    makeDue(service, id, { firstAttemptAt: new Date(Date.now() - DELETION_TIME_LIMIT_MS + 60_000).toISOString() });
    await service.runRemoteDeletions();
    assert.equal(service.registry.read(id).remoteDeletion?.state, "pending");
    // Past it: failed, and never tried again.
    makeDue(service, id, { firstAttemptAt: new Date(Date.now() - DELETION_TIME_LIMIT_MS - 1000).toISOString() });
    await service.runRemoteDeletions();
    const m = service.registry.read(id);
    assert.equal(m.remoteDeletion?.state, "failed");
    assert.equal(m.remoteDeletion?.attempts, 4);
    assert.equal(m.localStatus, "ready");
    await service.runRemoteDeletions();
    assert.equal(deletes(fake).length, 4);
    assert.ok(service.registry.events(id).some((e) => e.eventType === "remote_deletion_failed"));
    // Needs attention: the badge and /batch show say so.
    assert.match(badgeText([m]) ?? "", /1 remote deletion failed/);
    assert.match(describeJob(m).join("\n"), /Remote deletion\s+failed .*NEEDS ATTENTION/);
  }),
);

test(
  "a missing API key uses up no attempts and does not start the 24-hour limit",
  env("zdr", async ({ service, fake, key }) => {
    const id = await settle(service, fake);
    key.value = "";
    for (let i = 0; i < 3; i++) await service.runRemoteDeletions();
    let d = service.registry.read(id).remoteDeletion!;
    assert.equal(d.state, "pending");
    assert.equal(d.attempts, 0);
    assert.equal(d.firstAttemptAt, undefined);
    assert.equal(d.nextAttemptAt, undefined);
    assert.match(d.lastError ?? "", /no API key/);
    assert.equal(deletes(fake).length, 0);
    key.value = FAKE_KEY;
    fake.deleteReplies = [{ status: 204, body: "" }];
    await service.runRemoteDeletions();
    d = service.registry.read(id).remoteDeletion!;
    assert.equal(d.state, "done");
    assert.equal(d.attempts, 1);
  }),
);

test(
  "a missing API key is recorded once, shown as waiting, and not rewritten on every pass",
  env("zdr", async ({ service, fake, key }) => {
    const id = await settle(service, fake);
    key.value = "";
    await service.runRemoteDeletions();
    const file = path.join(service.registry.jobDir(id), "manifest.json");
    const first = { text: fs.readFileSync(file, "utf8"), mtime: fs.statSync(file).mtimeMs };
    assert.equal(service.registry.read(id).remoteDeletion?.waitingForKey, true);
    assert.match(badgeText(service.registry.list().jobs) ?? "", /1 remote deletion waiting for an API key/);
    assert.match(describeJob(service.registry.read(id)).join("\n"), /waiting for an API key/);
    await new Promise((r) => setTimeout(r, 20));
    for (let i = 0; i < 3; i++) await service.runRemoteDeletions();
    assert.equal(fs.readFileSync(file, "utf8"), first.text);
    assert.equal(fs.statSync(file).mtimeMs, first.mtime);
    key.value = FAKE_KEY;
    fake.deleteReplies = [{ status: 204, body: "" }];
    await service.runRemoteDeletions();
    const d = service.registry.read(id).remoteDeletion!;
    assert.equal(d.state, "done");
    assert.equal(d.waitingForKey, undefined);
    assert.doesNotMatch(badgeText(service.registry.list().jobs) ?? "", /waiting for an API key/);
  }),
);

// ------------------------------------------------------------------ batches that end without retrieval

for (const status of ["cancelled", "failed", "expired"] as const) {
  test(
    `a zdr batch that ends ${status} at OpenRouter is DELETEd`,
    env("zdr", async ({ service, fake }) => {
      const m = await endsAs(service, fake, status);
      assert.equal(m.remoteDeletion?.state, "pending");
      fake.deleteReplies = [{ status: 204, body: "" }];
      await service.runRemoteDeletions();
      assert.equal(deletes(fake).length, 1);
      assert.ok(deletes(fake)[0]!.url.endsWith("/batches/batch_123"));
      assert.equal(service.registry.read(m.localId).remoteDeletion?.state, "done");
      assert.equal(service.registry.read(m.localId).localStatus, status);
    }),
  );
}

test(
  "a zdr batch cancelled through /batch cancel is DELETEd",
  env("zdr", async ({ service, fake }) => {
    fake.submitReplies = [accepted("batch_123")];
    const job = await service.createJob(await service.prepare(ASK), { previewOnly: false });
    fake.cancelReplies = [{ status: 200, body: batchObject({ id: "batch_123", status: "cancelling" }) }];
    fake.getReplies = [{ status: 200, body: batchObject({ id: "batch_123", status: "cancelled" }) }];
    const { job: after } = await service.cancel(job.localId);
    assert.equal(after.localStatus, "cancelled");
    assert.equal(after.remoteDeletion?.state, "pending");
    fake.deleteReplies = [{ status: 204, body: "" }];
    await service.runRemoteDeletions();
    assert.equal(deletes(fake).length, 1);
  }),
);

test(
  "a standard cancelled batch is not deleted",
  env("standard", async ({ service, fake }) => {
    const m = await endsAs(service, fake, "cancelled");
    assert.equal(m.remoteDeletion, undefined);
    await service.runRemoteDeletions();
    assert.equal(deletes(fake).length, 0);
  }),
);

test(
  "a batch OpenRouter reports gone (410) is not marked for deletion",
  env("zdr", async ({ service, fake }) => {
    fake.submitReplies = [accepted("batch_123")];
    const job = await service.createJob(await service.prepare(ASK), { previewOnly: false });
    fake.getReplies = [{ status: 410, body: { error: { code: 410, message: "gone" } } }];
    await service.reconcile(job.localId, { force: true });
    const m = service.registry.read(job.localId);
    assert.equal(m.localStatus, "failed");
    assert.equal(m.remoteDeletion, undefined);
    await service.runRemoteDeletions();
    assert.equal(deletes(fake).length, 0);
  }),
);

test(
  "retention line: a cancelled zdr batch is marked for deletion, a standard one is kept up to 30 days",
  env("zdr", async ({ service, fake, cfg }) => {
    fake.submitReplies = [accepted("batch_123")];
    const running = await service.createJob(await service.prepare(ASK), { previewOnly: false });
    assert.equal(retentionLine(running, true), RETENTION_DELETED);
    fake.getReplies = [{ status: 200, body: batchObject({ id: "batch_123", status: "cancelled" }) }];
    await service.reconcile(running.localId, { force: true });
    const zdrCancelled = service.registry.read(running.localId);
    assert.equal(retentionLine(zdrCancelled, true), undefined, "the Remote deletion row says what happens");
    assert.match(describeJob(zdrCancelled).join("\n"), /Remote deletion\s+pending/);

    cfg.privacy.level = "standard";
    const m = await endsAs(service, fake, "cancelled");
    assert.equal(m.privacy?.level, "standard");
    assert.equal(retentionLine(m, true), RETENTION_KEPT);
    assert.doesNotMatch(describeJob(m).join("\n"), /Remote deletion/);
    // An ended strict job that was never marked (deletion off when it ended) is kept too.
    assert.equal(retentionLine({ ...zdrCancelled, remoteDeletion: undefined }, true), RETENTION_KEPT);
  }),
);

test(
  "standard job after the project level is raised is never deleted",
  env("standard", async ({ service, fake, cfg }) => {
    fake.submitReplies = [accepted("batch_123")];
    const job = await service.createJob(await service.prepare(ASK), { previewOnly: false });
    cfg.privacy.level = "zdr";
    fake.getReplies = [{ status: 200, body: completed(job.customIds.map((c) => successItem(c)), { id: "batch_123" }) }];
    await service.reconcile(job.localId, { force: true });
    await service.runRemoteDeletions();
    assert.equal(deletes(fake).length, 0);
    assert.equal(service.registry.read(job.localId).remoteDeletion, undefined);
  }),
);

test(
  "deleteRemoteBatches false disables it",
  env("zdr", async ({ service, fake, cfg }) => {
    cfg.privacy.deleteRemoteBatches = false;
    const id = await settle(service, fake);
    await service.runRemoteDeletions();
    assert.equal(deletes(fake).length, 0);
    assert.equal(service.registry.read(id).remoteDeletion, undefined);
  }),
);
