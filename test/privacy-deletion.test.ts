import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import type { BatchConfig } from "../src/config.js";
import { ModelCatalog } from "../src/models/catalog.js";
import { OpenRouterBatchClient } from "../src/openrouter/client.js";
import type { ZdrEndpoint } from "../src/privacy/policy.js";
import { JobRegistry } from "../src/registry.js";
import { BatchService, type AskOptions } from "../src/service.js";
import { FAKE_KEY, FakeOpenRouter, accepted, makeConfig } from "./fixtures/fake-openrouter.js";
import { completed, successItem } from "./fixtures/openrouter.js";
import { rm, tempWorkspace, writeFiles } from "./helpers.js";

const ASK: AskOptions = { objective: "Review the authentication design", files: ["src/auth.ts"], contexts: [], format: "markdown", includeInstructions: true };
const ZDR: ZdrEndpoint[] = [{ model: "anthropic/claude-opus-5.5", provider: "anthropic" }];

function env(level: BatchConfig["privacy"]["level"], fn: (c: { service: BatchService; fake: FakeOpenRouter; cfg: BatchConfig; root: string }) => Promise<void>): () => Promise<void> {
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
      const service = new BatchService({
        registry: new JobRegistry(path.join(root, ".pi", "batches")),
        workspaceRoot: root,
        getConfig: () => cfg,
        resolveApiKey: async () => FAKE_KEY,
        createClient: (apiKey, timeoutMs) => new OpenRouterBatchClient({ apiKey, fetchImpl: fake.fetch, timeoutMs }),
        gitIgnored: () => new Set(),
        catalog,
      });
      await fn({ service, fake, cfg, root });
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
  "gives up as failed after 10 attempts",
  env("zdr", async ({ service, fake }) => {
    const id = await settle(service, fake);
    fake.deleteReplies = [{ status: 500, body: "x" }];
    for (let i = 0; i < 12; i++) await service.runRemoteDeletions();
    const m = service.registry.read(id);
    assert.equal(m.remoteDeletion?.state, "failed");
    assert.equal(m.remoteDeletion?.attempts, 10);
    assert.equal(deletes(fake).length, 10);
    assert.equal(m.localStatus, "ready");
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
