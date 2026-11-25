import assert from "node:assert/strict";
import * as path from "node:path";
import test from "node:test";
import { OpenRouterBatchClient } from "../src/openrouter/client.js";
import { JobRegistry } from "../src/registry.js";
import { BatchService } from "../src/service.js";
import { FAKE_KEY, FakeOpenRouter, makeConfig } from "./fixtures/fake-openrouter.js";
import { mkJob } from "./fixtures/cleanup.js";
import { rm, tempWorkspace } from "./helpers.js";

function env(resolveApiKey: (account: string) => Promise<string>) {
  const root = tempWorkspace();
  const fake = new FakeOpenRouter();
  const registry = new JobRegistry(path.join(root, ".pi", "batches"));
  const cfg = makeConfig();
  const service = new BatchService({
    registry,
    workspaceRoot: root,
    getConfig: () => cfg,
    resolveApiKey,
    createClient: (apiKey, timeoutMs) => new OpenRouterBatchClient({ apiKey, fetchImpl: fake.fetch, timeoutMs }),
    gitIgnored: () => new Set(),
  });
  const job = mkJob(registry, { providerBatchId: "batch_1" });
  const deletes = () => fake.requests.filter((r) => r.method === "DELETE");
  return { root, fake, service, job, deletes };
}

test("deleteProviderBatch: an empty key is refused without any request", async () => {
  const e = env(async () => "");
  try {
    await assert.rejects(e.service.deleteProviderBatch(e.job), /no API key available for account/);
    assert.equal(e.deletes().length, 0);
  } finally {
    rm(e.root);
  }
});

test("deleteProviderBatch: a key lookup that throws is reported with its reason", async () => {
  const e = env(async () => {
    throw new Error("keychain locked");
  });
  try {
    await assert.rejects(e.service.deleteProviderBatch(e.job), /no API key available.*keychain locked/);
  } finally {
    rm(e.root);
  }
});

test("deleteProviderBatch: success, already gone (404) and not finished (409)", async () => {
  const e = env(async () => FAKE_KEY);
  try {
    e.fake.deleteReplies = [{ status: 204, body: "" }, { status: 404, body: { error: { message: "gone" } } }, { status: 409, body: { error: { message: "still running" } } }];
    await e.service.deleteProviderBatch(e.job);
    await e.service.deleteProviderBatch(e.job);
    await assert.rejects(e.service.deleteProviderBatch(e.job), /not finished yet.*still running/);
    assert.equal(e.deletes().length, 3);
    assert.match(e.deletes()[0]!.url, /batch_1/);
  } finally {
    rm(e.root);
  }
});
