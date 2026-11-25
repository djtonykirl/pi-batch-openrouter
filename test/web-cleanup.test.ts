import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ArtifactService } from "../src/artifacts/service.js";
import { ArtifactStore } from "../src/artifacts/store.js";
import { ChatService } from "../src/chat/service.js";
import { ThreadStore } from "../src/chat/store.js";
import { loadConfig, type BatchConfig } from "../src/config.js";
import { ModelCatalog } from "../src/models/catalog.js";
import { OpenRouterBatchClient } from "../src/openrouter/client.js";
import { BatchPoller } from "../src/poller.js";
import type { ZdrEndpoint } from "../src/privacy/policy.js";
import { JobRegistry } from "../src/registry.js";
import { BatchService } from "../src/service.js";
import { BatchWebServer } from "../src/web/server.js";
import { FAKE_KEY, FakeOpenRouter, accepted, makeConfig } from "./fixtures/fake-openrouter.js";
import { mkJob } from "./fixtures/cleanup.js";
import { rm, tempWorkspace } from "./helpers.js";
import { batchEndpointsMatchingZdr } from "./fixtures/catalog.js";

const ZDR: ZdrEndpoint[] = [{ model: "y/model", provider: "azure/eu" }];
const MODELS = [{ id: "p/paid", name: "Paid", free: false }];

interface Env {
  root: string;
  cfg: BatchConfig;
  catalog: ModelCatalog;
  store: ThreadStore;
  chat: ChatService;
  batch: BatchService;
  get: (p: string, init?: RequestInit) => Promise<Response>;
  post: (p: string, body?: unknown, extra?: Record<string, string>) => Promise<Response>;
  anon: (p: string, method?: string) => Promise<Response>;
  loads: () => number;
}

function withWeb(fn: (e: Env) => Promise<void>): () => Promise<void> {
  return async () => {
    const root = tempWorkspace();
    let web: BatchWebServer | undefined;
    try {
      const fake = new FakeOpenRouter();
      let n = 0;
      fake.submitReplies = [async () => accepted(`batch_${++n}`)];
      const cfg = makeConfig();
      let loadCount = 0;
      const catalog = new ModelCatalog({
        fetch: async () => {
          loadCount++;
          return { models: MODELS, zdr: ZDR, batchEndpoints: { ...batchEndpointsMatchingZdr(ZDR), "x/other": ["anthropic"] } };
        },
        file: join(root, "catalog.json"),
      });
      await catalog.load();
      loadCount = 0;
      const batch = new BatchService({
        registry: new JobRegistry(join(root, ".pi", "batches")),
        workspaceRoot: root,
        getConfig: () => cfg,
        resolveApiKey: async () => FAKE_KEY,
        createClient: (apiKey, timeoutMs) => new OpenRouterBatchClient({ apiKey, fetchImpl: fake.fetch, timeoutMs }),
        gitIgnored: () => new Set(),
        catalog,
      });
      const store = new ThreadStore(join(root, ".pi/batches/threads"));
      const chat = new ChatService({ store, batch, workspaceRoot: root, getConfig: () => cfg });
      const artifacts = new ArtifactService({ batch, workspaceRoot: root, getConfig: () => cfg, store: new ArtifactStore(join(root, ".pi/batches/artifacts")) });
      const poller = new BatchPoller(() => batch, () => true);
      web = new BatchWebServer({
        workspaceRoot: root,
        service: batch,
        chat,
        chatStore: store,
        artifacts,
        poller,
        catalog,
        getConfig: () => cfg,
        getKnownModels: () => ["y/model", "x/other"],
        reloadConfig: () => {
          const fresh = loadConfig(root, join(root, "no-global.json")).config.privacy;
          cfg.privacy = { ...fresh };
        },
      });
      const base = await web.start(0, "127.0.0.1");
      const launch = await globalThis.fetch(web.createLaunchUrl()!, { redirect: "manual" });
      const cookie = (launch.headers.get("set-cookie") ?? "").split(";")[0]!;
      const get = (p: string, init: RequestInit = {}) =>
        globalThis.fetch(base + p, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), Cookie: cookie } });
      const post = (p: string, body: unknown = {}, extra: Record<string, string> = {}) =>
        globalThis.fetch(base + p, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Batch-Token": web!.csrfToken, Cookie: cookie, ...extra },
          body: JSON.stringify(body),
        });
      const anon = (p: string, method = "GET") => globalThis.fetch(base + p, { method, headers: { "X-Batch-Token": web!.csrfToken } });
      await fn({ root, cfg, catalog, store, chat, batch, get, post, anon, loads: () => loadCount });
    } finally {
      await web?.stop();
      rm(root);
    }
  };
}


test(
  "cleanup endpoints need a session and the CSRF token",
  withWeb(async ({ anon, post }) => {
    assert.equal((await anon("/api/cleanup/plan", "POST")).status, 401);
    assert.equal((await anon("/api/cleanup/apply", "POST")).status, 401);
    assert.equal((await post("/api/cleanup/plan", {}, { "X-Batch-Token": "wrong" })).status, 403);
  }),
);

test(
  "POST /api/cleanup/plan is read-only; /apply deletes exactly the plan; a plan is single use",
  withWeb(async ({ root, post }) => {
    const registry = new JobRegistry(join(root, ".pi", "batches"));
    const job = mkJob(registry);
    const keep = mkJob(registry);
    const planRes = await post("/api/cleanup/plan", { refs: [job.localId] });
    assert.equal(planRes.status, 200);
    const plan = (await planRes.json()) as { planId: string; items: Array<{ id: string }>; skipped: unknown[] };
    assert.deepEqual(plan.items.map((i) => i.id), [job.localId]);
    assert.equal(fs.existsSync(join(root, ".pi", "batches", job.localId)), true);
    const applied = await post("/api/cleanup/apply", { planId: plan.planId });
    assert.equal(applied.status, 200);
    const result = (await applied.json()) as { deleted: Array<{ id: string }>; skipped: unknown[]; freedBytes: number };
    assert.deepEqual(result.deleted.map((d) => d.id), [job.localId]);
    assert.equal(fs.existsSync(join(root, ".pi", "batches", job.localId)), false);
    assert.equal(fs.existsSync(join(root, ".pi", "batches", keep.localId)), true);
    const again = await post("/api/cleanup/apply", { planId: plan.planId });
    assert.equal(again.status, 400);
    assert.match(((await again.json()) as { error: string }).error, /re-plan/);
  }),
);

test(
  "POST /api/cleanup/plan: an age clean-up uses olderThan, a bad value is a 400, no refs and no olderThan means 7d",
  withWeb(async ({ root, post }) => {
    const registry = new JobRegistry(join(root, ".pi", "batches"));
    const old = mkJob(registry, { createdAt: new Date(Date.now() - 10 * 86_400_000).toISOString() });
    const young = mkJob(registry);
    const plan = (await (await post("/api/cleanup/plan", {})).json()) as { items: Array<{ id: string }> };
    assert.deepEqual(plan.items.map((i) => i.id), [old.localId]);
    const all = (await (await post("/api/cleanup/plan", { olderThan: "0", include: "jobs" })).json()) as { items: Array<{ id: string }> };
    assert.deepEqual(all.items.map((i) => i.id).sort(), [old.localId, young.localId].sort());
    const bad = await post("/api/cleanup/plan", { olderThan: "soon" });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: string }).error, /older-than/);
  }),
);
