import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { ChatService } from "../src/chat/service.js";
import { ThreadStore } from "../src/chat/store.js";
import { loadConfig, projectConfigPath, readPrivacyConfig, saveConfigUpdate } from "../src/config.js";
import { ModelCatalog } from "../src/models/catalog.js";
import { OpenRouterBatchClient } from "../src/openrouter/client.js";
import type { ZdrEndpoint } from "../src/privacy/policy.js";
import { JobRegistry } from "../src/registry.js";
import { BatchService, type AskOptions } from "../src/service.js";
import { FAKE_KEY, FakeOpenRouter, accepted, makeConfig, makeService } from "./fixtures/fake-openrouter.js";
import { chatCompletion } from "./fixtures/openrouter.js";
import { rm, tempWorkspace, writeFiles } from "./helpers.js";

const ASK: AskOptions = { objective: "Review the authentication design", files: ["src/auth.ts"], contexts: [], format: "markdown", includeInstructions: true };
const ZDR: ZdrEndpoint[] = [{ model: "anthropic/claude-opus-5.5", provider: "anthropic" }];
const FREE = "meta/llama-free:free";
const PER_MINUTE = { error: { code: 429, message: "Rate limit exceeded: free-models-per-min." } };

const chatPosts = (fake: FakeOpenRouter) => fake.requests.filter((r) => r.method === "POST" && r.url.endsWith("/chat/completions"));
const lastProvider = (fake: FakeOpenRouter) => (JSON.parse(chatPosts(fake).at(-1)!.body!) as { provider?: unknown }).provider;

/** One "process": its own config snapshot (loaded once), services and catalog, over a shared workspace. */
async function processFor(root: string, globalFile: string, fake: FakeOpenRouter): Promise<{ batch: BatchService; chat: ChatService }> {
  const snapshot = loadConfig(root, globalFile).config;
  const getPrivacy = () => readPrivacyConfig(root, globalFile);
  const catalog = new ModelCatalog({ fetch: async () => ({ models: [], zdr: ZDR }), file: path.join(root, "catalog.json") });
  await catalog.load();
  const batch = new BatchService({
    registry: new JobRegistry(path.join(root, ".pi", "batches")),
    workspaceRoot: root,
    getConfig: () => snapshot,
    getPrivacy,
    resolveApiKey: async () => FAKE_KEY,
    createClient: (apiKey, timeoutMs) => new OpenRouterBatchClient({ apiKey, fetchImpl: fake.fetch, timeoutMs }),
    gitIgnored: () => new Set(),
    catalog,
  });
  const chat = new ChatService({ store: new ThreadStore(path.join(root, ".pi/batches/threads")), batch, workspaceRoot: root, getConfig: () => snapshot, getPrivacy });
  return { batch, chat };
}

function withWorkspace(fn: (c: { root: string; globalFile: string; fake: FakeOpenRouter }) => Promise<void>): () => Promise<void> {
  return async () => {
    const root = tempWorkspace("pi batch fresh-");
    writeFiles(root, { "src/auth.ts": "export function login() { return true; }\r\n" });
    try {
      await fn({ root, globalFile: path.join(root, "no-global.json"), fake: new FakeOpenRouter() });
    } finally {
      rm(root);
    }
  };
}

// ------------------------------------------------------------------ 1. per-process snapshots

test(
  "two processes share a workspace: a level raised through one decides the other's next job",
  withWorkspace(async ({ root, globalFile, fake }) => {
    const a = await processFor(root, globalFile, fake);
    const b = await processFor(root, globalFile, fake);
    const earlier = await b.batch.createJob(await b.batch.prepare(ASK), { previewOnly: true });
    assert.equal(earlier.privacy?.level, "standard");
    const thread = b.chat.newThread();
    assert.equal(b.chat.effectiveLevel(thread.id), "standard");

    // Process A raises the level (what /batch privacy and the web UI do: write the project file, reload A's own snapshot).
    saveConfigUpdate({ privacy: { level: "zdr" } }, { cwd: root, global: false }, globalFile);
    assert.equal(a.batch.privacyConfig().level, "zdr");

    // Process B's snapshot still says standard; every decision reads the level fresh.
    const next = await b.batch.createJob(await b.batch.prepare(ASK), { previewOnly: true });
    assert.equal(next.privacy?.level, "zdr");
    assert.deepEqual(next.providerPin, { only: ["anthropic"], allow_fallbacks: false });
    assert.equal(b.chat.effectiveLevel(thread.id), "zdr");
    await assert.rejects(b.batch.submit(earlier.localId), /Privacy level zdr: .* was prepared at standard/);
    assert.equal(fake.requests.length, 0, "nothing was sent at the old level");
  }),
);

test(
  "readPrivacyConfig keeps the last good section while a config file is unreadable",
  withWorkspace(async ({ root, globalFile }) => {
    saveConfigUpdate({ privacy: { level: "no-training" } }, { cwd: root, global: false }, globalFile);
    assert.equal(readPrivacyConfig(root, globalFile).level, "no-training");
    fs.writeFileSync(projectConfigPath(root), "{ half written");
    assert.equal(readPrivacyConfig(root, globalFile).level, "no-training", "a broken file never relaxes the level");
    fs.writeFileSync(projectConfigPath(root), JSON.stringify({ privacy: { level: "zdr" } }));
    assert.equal(readPrivacyConfig(root, globalFile).level, "zdr");
  }),
);

// ------------------------------------------------------------------ 2. immediate items sent later

test(
  "an immediate job at standard: after a 429 the level is raised, and the next send carries data_collection deny",
  withWorkspace(async ({ root, fake }) => {
    const cfg = makeConfig();
    const service = makeService(root, fake, cfg);
    fake.chatReplies = [{ status: 429, body: PER_MINUTE, headers: { "Retry-After": "1" } }];
    const job = await service.createChatJob({
      threadId: "T-20261026-ABCD",
      purpose: "turn",
      throughSeq: 1,
      model: FREE,
      account: "default",
      main: [{ role: "user", content: "hello there" }],
    });
    assert.equal(job.privacy?.level, "standard");
    assert.equal(lastProvider(fake), undefined);

    cfg.privacy.level = "no-training";
    fake.chatReplies = [{ status: 200, body: chatCompletion("Later.") }];
    const r = await service.reconcile(job.localId, { force: true });
    assert.equal(r.status, "ready");
    assert.deepEqual(lastProvider(fake), { data_collection: "deny" });
    const escalations = service.registry.events(job.localId).filter((e) => e.eventType === "privacy_escalated");
    assert.equal(escalations.length, 1);
    assert.deepEqual(escalations[0]!.details, { recorded: "standard", level: "no-training" });
    assert.equal(service.registry.read(job.localId).privacy?.level, "standard", "the recorded level is kept as evidence");
  }),
);

test(
  "an immediate chat turn: a thread level raised after a 429 applies to the next send",
  withWorkspace(async ({ root, globalFile, fake }) => {
    const { batch, chat } = await processFor(root, globalFile, fake);
    const t = chat.newThread();
    await chat.setModel(t.id, FREE);
    fake.chatReplies = [{ status: 429, body: PER_MINUTE, headers: { "Retry-After": "1" } }];
    const sent = await chat.send(t.id, "hello");
    const jobId = sent.jobId!;
    assert.equal(batch.registry.read(jobId).privacy?.level, "standard");
    chat.raisePrivacy(t.id, "zdr");
    fake.chatReplies = [{ status: 200, body: chatCompletion("Later.") }];
    await batch.reconcile(jobId, { force: true });
    assert.deepEqual(lastProvider(fake), { zdr: true });
    assert.ok(batch.registry.events(jobId).some((e) => e.eventType === "privacy_escalated" && e.details?.level === "zdr"));
  }),
);

// ------------------------------------------------------------------ 7. attestation re-checked at submit

test(
  "submit refuses a previewed no-training batch job once the attestation is removed",
  withWorkspace(async ({ root, globalFile, fake }) => {
    saveConfigUpdate({ privacy: { level: "no-training", accountNoTraining: true } }, { cwd: root, global: false }, globalFile);
    const { batch } = await processFor(root, globalFile, fake);
    const job = await batch.createJob(await batch.prepare(ASK), { previewOnly: true });
    assert.equal(job.privacy?.level, "no-training");
    saveConfigUpdate({ privacy: { accountNoTraining: false } }, { cwd: root, global: false }, globalFile);
    await assert.rejects(batch.submit(job.localId), /Privacy level no-training: .*attestation was removed; /);
    assert.equal(batch.registry.read(job.localId).localStatus, "previewed");
    assert.equal(fake.requests.length, 0);

    // Attesting again lets it go.
    saveConfigUpdate({ privacy: { accountNoTraining: true } }, { cwd: root, global: false }, globalFile);
    fake.submitReplies = [accepted()];
    assert.equal((await batch.submit(job.localId)).localStatus, "submitted");
  }),
);
