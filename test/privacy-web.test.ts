import assert from "node:assert/strict";
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
import { pickerEntries, PRIVACY_NOTICE } from "../src/privacy/commands.js";
import type { ZdrEndpoint } from "../src/privacy/policy.js";
import { JobRegistry } from "../src/registry.js";
import { BatchService } from "../src/service.js";
import { BatchWebServer } from "../src/web/server.js";
import { FAKE_KEY, FakeOpenRouter, accepted, makeConfig } from "./fixtures/fake-openrouter.js";
import { rm, tempWorkspace } from "./helpers.js";
import { batchEndpointsMatchingZdr } from "./fixtures/catalog.js";

const ZDR: ZdrEndpoint[] = [{ model: "y/model", provider: "azure/eu" }];
const MODELS = [
  { id: "c/free-one:free", name: "Free One", free: true },
  { id: "d/free-two:free", name: "Free Two", free: true },
  // Free by pricing ("0"), without a ":free" suffix.
  { id: "z/zero-priced", name: "Zero Priced", free: true },
  { id: "z/other-free", name: "Other Free", free: true },
  { id: "p/paid", name: "Paid", free: false },
];

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
  "new privacy endpoints need a session and refuse a foreign origin",
  withWeb(async ({ chat, anon, post, get }) => {
    const t = chat.newThread();
    const routes: Array<[string, string]> = [
      ["GET", "/api/privacy"],
      ["POST", "/api/privacy"],
      ["POST", "/api/privacy/attest"],
      ["POST", "/api/models/refresh"],
      ["GET", "/api/models"],
      ["POST", `/api/threads/${t.id}/privacy`],
    ];
    for (const [method, path] of routes) {
      assert.equal((await anon(path, method)).status, 401, `${method} ${path} without a session`);
      const foreign = method === "GET" ? await get(path, { headers: { Origin: "http://evil.example" } }) : await post(path, {}, { Origin: "http://evil.example" });
      assert.equal(foreign.status, 403, `${method} ${path} foreign origin`);
    }
  }),
);

test(
  "GET/POST /api/privacy: level, notice once, attestation with time",
  withWeb(async ({ get, post, cfg }) => {
    const first = (await (await get("/api/privacy")).json()) as Record<string, any>;
    assert.equal(first.level, "standard");
    assert.equal(first.accountNoTraining, false);
    assert.equal(first.deleteRemoteBatches, true);
    assert.equal(first.noticeShown, false);
    assert.equal(first.catalog.state, "fresh");

    assert.equal((await post("/api/privacy", { level: "bogus" })).status, 400);

    const raised = (await (await post("/api/privacy", { level: "zdr" })).json()) as Record<string, any>;
    assert.equal(raised.level, "zdr");
    assert.equal(raised.notice, PRIVACY_NOTICE);
    assert.equal(cfg.privacy.level, "zdr");
    const again = (await (await post("/api/privacy", { level: "no-training" })).json()) as Record<string, any>;
    assert.equal(again.notice, undefined, "notice only once");

    const attested = (await (await post("/api/privacy/attest", { attested: true })).json()) as Record<string, any>;
    assert.equal(attested.accountNoTraining, true);
    assert.match(attested.attestedAt, /^\d{4}-\d\d-\d\dT/);
    assert.match(attested.attestNote, /cannot verify/);
    const status = (await (await get("/api/privacy")).json()) as Record<string, any>;
    assert.equal(status.attestedAt, attested.attestedAt);
    assert.equal(status.source, "project");

    const removed = (await (await post("/api/privacy/attest", { attested: false })).json()) as Record<string, any>;
    assert.equal(removed.accountNoTraining, false);
    assert.equal(removed.attestedAt, undefined);
    assert.equal((await post("/api/privacy/attest", { attested: "yes" })).status, 400);
  }),
);

test(
  "POST /api/models/refresh reloads the catalog",
  withWeb(async ({ post, loads }) => {
    const r = await post("/api/models/refresh");
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as any).catalog.state, "fresh");
    assert.equal(loads(), 1);
  }),
);

test(
  "POST /api/threads/:id/privacy raises, refuses lowering with the reason",
  withWeb(async ({ chat, post, store }) => {
    const t = chat.newThread();
    const up = await post(`/api/threads/${t.id}/privacy`, { level: "no-training" });
    assert.equal(up.status, 200);
    assert.equal(store.read(t.id).privacyLevel, "no-training");
    const down = await post(`/api/threads/${t.id}/privacy`, { level: "standard" });
    assert.equal(down.status, 400);
    assert.match(((await down.json()) as any).error, /can't lower a thread below its current level/);
    assert.equal((await post(`/api/threads/${t.id}/privacy`, { level: "nope" })).status, 400);
  }),
);

test(
  "a blocked model posted by the page gets 400 and creates no job or thread",
  withWeb(async ({ cfg, chat, post, store, batch }) => {
    cfg.privacy.level = "zdr";
    const t = chat.newThread();
    const r = await post(`/api/threads/${t.id}/model`, { model: "x/other" });
    assert.equal(r.status, 400);
    assert.match(((await r.json()) as any).error, /^Privacy level zdr: /);
    assert.notEqual(store.read(t.id).model, "x/other");

    const before = store.list().length;
    const created = await post("/api/threads", { model: "x/other" });
    assert.equal(created.status, 400);
    assert.match(((await created.json()) as any).error, /^Privacy level zdr: /);
    assert.equal(store.list().length, before, "a refused create leaves no thread");
    assert.equal(batch.registry.list().jobs.length, 0);

    const ok = await post("/api/threads", { model: "y/model", title: "Allowed" });
    assert.equal(ok.status, 201);
  }),
);

test(
  "GET /api/models matches pickerEntries for the project level and for a thread",
  withWeb(async ({ cfg, chat, get, catalog }) => {
    cfg.privacy.level = "zdr";
    const proj = (await (await get("/api/models")).json()) as { entries: unknown[]; catalog: { state: string } };
    assert.deepEqual(proj.entries, pickerEntries(catalog.snapshot(), ["y/model", "x/other"], "zdr", false));
    assert.equal(proj.catalog.state, "fresh");

    cfg.privacy.level = "standard";
    const t = chat.newThread();
    chat.raisePrivacy(t.id, "no-training");
    const thread = (await (await get(`/api/models?threadId=${t.id}`)).json()) as { entries: unknown[]; level: string };
    assert.equal(thread.level, "no-training");
    assert.deepEqual(thread.entries, pickerEntries(catalog.snapshot(), ["y/model", "x/other"], "no-training", false));
    assert.equal((await get("/api/models?threadId=nope")).status, 400);
  }),
);

test(
  "the page has no inline handlers and carries the privacy controls",
  withWeb(async ({ get }) => {
    const html = await (await get("/")).text();
    assert.equal(/onclick\s*=/i.test(html), false);
    assert.equal(/\son(click|change|input|submit|load|error)\s*=/i.test(html), false);
    for (const needle of ["privacy-level", "refresh-models", "show-blocked", "attest-privacy", "openrouter.ai/settings/privacy"]) {
      assert.ok(html.includes(needle), `page mentions ${needle}`);
    }
  }),
);

test(
  "the picker's chosen route is stored; the page sends it with Set",
  withWeb(async ({ post, get, store, chat }) => {
    const t = chat.newThread();
    const r = await post(`/api/threads/${t.id}/model`, { model: "z/zero-priced", route: "immediate" });
    assert.equal(r.status, 200);
    assert.equal(store.read(t.id).route, "immediate");
    assert.equal(store.read(t.id).model, "z/zero-priced");
    assert.equal((await post(`/api/threads/${t.id}/model`, { model: "z/zero-priced", route: "bogus" })).status, 400);

    const created = await post("/api/threads", { model: "z/other-free", route: "immediate" });
    assert.equal(created.status, 201);
    assert.equal(((await created.json()) as any).thread.route, "immediate");

    const html = await (await get("/")).text();
    assert.ok(html.includes('data-route="'), "picker options carry the route");
    assert.ok(html.includes("route: pickedRouteFor(slug)"), "Set posts the picked route");
    assert.ok(html.includes("state.pickedRoute = null"), "editing the box clears the route");
  }),
);

test(
  "route immediate is accepted only for a free model; anything else is 400 and leaves nothing behind",
  withWeb(async ({ post, store, chat }) => {
    const t = chat.newThread();
    for (const model of ["p/paid", "y/model", "q/unknown", ""]) {
      const r = await post(`/api/threads/${t.id}/model`, { model, route: "immediate" });
      assert.equal(r.status, 400, model);
      assert.match(((await r.json()) as { error: string }).error, /Route immediate is only for free models/);
    }
    assert.notEqual(store.read(t.id).route, "immediate");
    assert.equal((await post(`/api/threads/${t.id}/model`, { model: "c/free-one:free", route: "immediate" })).status, 200);
    assert.equal(store.read(t.id).route, "immediate");
    // Batch stays allowed for any model.
    assert.equal((await post(`/api/threads/${t.id}/model`, { model: "p/paid", route: "batch" })).status, 200);
    assert.equal(store.read(t.id).route, "batch");

    const before = store.list().length;
    const refused = await post("/api/threads", { model: "p/paid", route: "immediate" });
    assert.equal(refused.status, 400);
    assert.equal(store.list().length, before, "no orphan thread");
  }),
);

test(
  "ChatService.setModel refuses an explicit immediate route for a model that is not free",
  withWeb(async ({ chat, store }) => {
    const t = chat.newThread();
    await assert.rejects(chat.setModel(t.id, "p/paid", { route: "immediate" }), /Route immediate is only for free models .*; p\/paid is not one/);
    await assert.rejects(chat.setModel(t.id, "q/unknown", { route: "immediate" }), /Route immediate is only for free models/);
    assert.notEqual(store.read(t.id).model, "p/paid");
    await chat.setModel(t.id, "z/zero-priced", { route: "immediate" });
    assert.equal(store.read(t.id).route, "immediate");
    await chat.setModel(t.id, "q/unknown:free", { route: "immediate" });
    assert.equal(store.read(t.id).route, "immediate");
    await chat.setModel(t.id, "p/paid");
    assert.equal(store.read(t.id).route, "batch");
  }),
);


test(
  "send at zdr for a batch model with no ZDR provider: no job, refusal recorded",
  withWeb(async ({ cfg, chat, post, batch, store }) => {
    const t = chat.newThread();
    await chat.setModel(t.id, "x/other");
    cfg.privacy.level = "zdr";
    const r = await post(`/api/threads/${t.id}/send`, { text: "hello" });
    // Chat keeps the user's message and records the refusal on the thread (it is not an HTTP error), so nothing is lost.
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as any).jobId, undefined);
    const failure = store.read(t.id).lastFailure;
    assert.match(failure?.message ?? "", /Privacy level zdr: x\/other has no batch endpoint on OpenRouter's ZDR list \(its batch endpoints: anthropic; ZDR endpoints: none\)/);
    assert.equal(store.read(t.id).pending, undefined);
    assert.equal(batch.registry.list().jobs.length, 0);
  }),
);

test("ThreadStore.remove only removes an untouched thread", async () => {
  const root = tempWorkspace();
  try {
    const store = new ThreadStore(join(root, "threads"));
    const fresh = store.create({ model: "a/b", account: "default" });
    store.remove(fresh.id);
    assert.equal(store.list().length, 0);
    const used = store.create({ model: "a/b", account: "default" });
    store.update(used.id, (_t, append) => append({ type: "status", text: "hi" }));
    assert.throws(() => store.remove(used.id), /in use/);
    assert.equal(store.list().length, 1);
  } finally {
    rm(root);
  }
});

test(
  "GET /api/privacy shows the routing policy; GET /api/models blocks a zdr batch model with no ZDR endpoint in the allow-list",
  withWeb(async ({ get, cfg }) => {
    Object.assign(cfg.routing, { allowedProviders: ["groq"], allowFallbacks: false, requireZdr: true });
    const p = (await (await get("/api/privacy")).json()) as Record<string, any>;
    assert.deepEqual(p.routing.allowedProviders, ["groq"]);
    assert.equal(p.routing.pin, "groq (no fallbacks)");
    assert.equal(p.routing.policy, "routing.requireZdr: on (NOT attested); routing.requireNoDataCollection: off");
    assert.match(p.routing.summary, /^Provider allow-list: groq \(no fallbacks\); routing.requireZdr: on/);
    cfg.privacy.level = "zdr";
    const m = (await (await get("/api/models")).json()) as { entries: Array<{ id: string; blocked?: string }> };
    assert.equal(m.entries.find((e) => e.id === "y/model")!.blocked, "Privacy level zdr: no ZDR provider for y/model within routing.allowedProviders (groq)");
    cfg.routing.allowedProviders = ["azure"];
    const ok = (await (await get("/api/models")).json()) as { entries: Array<{ id: string; blocked?: string }> };
    assert.equal(ok.entries.find((e) => e.id === "y/model")!.blocked, undefined);
  }),
);