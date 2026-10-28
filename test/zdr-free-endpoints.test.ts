import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { ChatService } from "../src/chat/service.js";
import { ThreadStore } from "../src/chat/store.js";
import { fetchCatalogData, loadVariantEndpoints, ModelCatalog, type CatalogModel } from "../src/models/catalog.js";
import { OpenRouterBatchClient } from "../src/openrouter/client.js";
import { pickerEntries } from "../src/privacy/commands.js";
import { freeZdrView, immediateZdrRefusal, variantEndpointsPath, type CatalogView, type ZdrEndpoint } from "../src/privacy/policy.js";
import { JobRegistry } from "../src/registry.js";
import { BatchService, decidePrivacyFor, previewPrivacy } from "../src/service.js";
import { FAKE_KEY, FakeOpenRouter, makeConfig } from "./fixtures/fake-openrouter.js";
import { rm, tempWorkspace } from "./helpers.js";

/** Shapes seen live on 2026-10-28 (GET /endpoints/zdr and GET /models/{id}:free/endpoints). */
const GEMMA = "google/gemma-4-31b-it";
const XING = "xingchen-agi/xing4.0-29b-a4b";
const ZDR: ZdrEndpoint[] = [
  { model: GEMMA, provider: "deepinfra/fp8" },
  { model: GEMMA, provider: "sambanova" },
  { model: XING, provider: "phala" },
];
const FREE: Record<string, string[]> = { [GEMMA]: ["google-ai-studio"], [XING]: ["phala"] };
const catalog: CatalogView = { fresh: true, zdr: ZDR, batchEndpoints: {}, freeEndpoints: FREE };
const MODELS: CatalogModel[] = [
  { id: `${GEMMA}:free`, name: "Gemma", free: true },
  { id: `${XING}:free`, name: "Xing", free: true },
];

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "zdr-free-")), "models.json");
}

// ------------------------------------------------------------------ policy

test("free zdr: a Gemma-shaped model (free endpoint not on the ZDR list) is refused with both endpoint lists", () => {
  assert.deepEqual(freeZdrView(catalog, `${GEMMA}:free`), { zdr: ["deepinfra/fp8", "sambanova"], free: ["google-ai-studio"], qualifying: [] });
  assert.equal(
    immediateZdrRefusal(catalog, `${GEMMA}:free`),
    "Privacy level zdr: google/gemma-4-31b-it:free has no free endpoint on OpenRouter's ZDR list (its free endpoints: google-ai-studio; ZDR endpoints: deepinfra/fp8, sambanova)",
  );
});

test("free zdr: a Xingchen-shaped model (free endpoint on the ZDR list) is allowed", () => {
  assert.equal(immediateZdrRefusal(catalog, `${XING}:free`), undefined);
});

test("free zdr: unknown free endpoints are refused; no catalog or a loading one is refused", () => {
  assert.equal(
    immediateZdrRefusal({ ...catalog, freeEndpoints: {} }, `${XING}:free`),
    "Privacy level zdr: the free endpoints of xingchen-agi/xing4.0-29b-a4b:free could not be loaded this session (run /batch privacy refresh)",
  );
  assert.equal(immediateZdrRefusal({ fresh: true, zdr: ZDR }, `${XING}:free`)?.includes("could not be loaded"), true);
  assert.match(immediateZdrRefusal({ fresh: true, zdr: [], freeEndpoints: {} }, "a/b:free") ?? "", /a\/b:free has no free endpoint .*its free endpoints: unknown; ZDR endpoints: none/);
  assert.match(immediateZdrRefusal(undefined, `${XING}:free`) ?? "", /not loaded this session/);
  assert.match(immediateZdrRefusal({ fresh: false, zdr: ZDR, freeEndpoints: FREE, loading: true }, `${XING}:free`) ?? "", /still loading/);
  // A key inherited from Object.prototype is not an entry.
  assert.match(immediateZdrRefusal({ fresh: true, zdr: [{ model: "constructor", provider: "p" }], freeEndpoints: {} }, "constructor:free") ?? "", /could not be loaded/);
});

test("free zdr: a free-by-price model without :free keeps the base model's ZDR rule", () => {
  assert.equal(immediateZdrRefusal(catalog, GEMMA), undefined);
  assert.equal(immediateZdrRefusal(catalog, "n/none"), "Privacy level zdr: no ZDR endpoint available for n/none");
});

test("variantEndpointsPath builds the :free and :batch paths and refuses unsafe segments", () => {
  assert.equal(variantEndpointsPath(`${GEMMA}:free`, "free"), "/models/google/gemma-4-31b-it:free/endpoints");
  assert.equal(variantEndpointsPath(GEMMA, "batch"), "/models/google/gemma-4-31b-it:batch/endpoints");
  assert.equal(variantEndpointsPath("a/../b:free", "free"), undefined);
});

// ------------------------------------------------------------------ labels and picker

test("free zdr labels: Gemma-shaped has no ZDR label and is blocked at zdr; Xingchen-shaped is labelled and allowed", () => {
  const snap = { ...catalog, batchEndpoints: {}, freeEndpoints: FREE, models: MODELS, loadedAt: "2026-10-28T09:00:00.000Z" };
  const e = pickerEntries(snap, [], "zdr", false);
  const gemma = e.find((x) => x.id === `${GEMMA}:free`)!;
  const xing = e.find((x) => x.id === `${XING}:free`)!;
  assert.deepEqual(gemma.labels, ["free"]);
  assert.equal(gemma.blocked, immediateZdrRefusal(catalog, `${GEMMA}:free`));
  assert.deepEqual(xing.labels, ["free", "ZDR"]);
  assert.equal(xing.blocked, undefined);
});

test("ModelCatalog.labels uses the free endpoints for :free models", async () => {
  const cat = new ModelCatalog({ file: tmpFile(), fetch: async () => ({ models: MODELS, zdr: ZDR, batchEndpoints: {}, freeEndpoints: FREE }) });
  await cat.load();
  assert.deepEqual(cat.labels(`${GEMMA}:free`), { free: true, zdr: false });
  assert.deepEqual(cat.labels(`${XING}:free`), { free: true, zdr: true });
});

// ------------------------------------------------------------------ the decision persistJob makes

test("decidePrivacyFor / previewPrivacy refuse a zdr free chat on a Gemma-shaped model, and allow Xingchen", () => {
  const config = makeConfig();
  const privacy = { level: "zdr" as const, accountNoTraining: false };
  const refused = decidePrivacyFor({ config, privacy, draft: { kind: "chat", model: `${GEMMA}:free` }, catalog });
  assert.deepEqual(refused, { ok: false, reason: immediateZdrRefusal(catalog, `${GEMMA}:free`), refusal: "privacy" });
  assert.deepEqual(previewPrivacy({ config, privacy, draft: { kind: "chat", model: `${GEMMA}:free` }, catalog }), { ok: false, reason: immediateZdrRefusal(catalog, `${GEMMA}:free`) });
  const ok = decidePrivacyFor({ config, privacy, draft: { kind: "chat", model: `${XING}:free` }, catalog });
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.privacy.enforcement, "immediate: zdr=true");
  // No catalog at zdr: refused locally too.
  assert.equal(decidePrivacyFor({ config, privacy, draft: { kind: "chat", model: `${XING}:free` } }).ok, false);
  // Below zdr the catalog is not consulted.
  assert.equal(decidePrivacyFor({ config, privacy: { level: "no-training", accountNoTraining: false }, draft: { kind: "chat", model: `${GEMMA}:free` } }).ok, true);
});

test("a zdr free send on a Gemma-shaped model is refused before any request; setModel refuses it too", async () => {
  const root = tempWorkspace();
  try {
    const fake = new FakeOpenRouter();
    const cfg = makeConfig();
    const cat = new ModelCatalog({ file: path.join(root, "catalog.json"), fetch: async () => ({ models: MODELS, zdr: ZDR, batchEndpoints: {}, freeEndpoints: FREE }) });
    await cat.load();
    const batch = new BatchService({
      registry: new JobRegistry(path.join(root, ".pi", "batches")),
      workspaceRoot: root,
      getConfig: () => cfg,
      resolveApiKey: async () => FAKE_KEY,
      createClient: (apiKey, timeoutMs) => new OpenRouterBatchClient({ apiKey, fetchImpl: fake.fetch, timeoutMs }),
      gitIgnored: () => new Set(),
      catalog: cat,
    });
    const store = new ThreadStore(path.join(root, ".pi/batches/threads"));
    const chat = new ChatService({ store, batch, workspaceRoot: root, getConfig: () => cfg });
    const t = chat.newThread();
    await chat.setModel(t.id, `${GEMMA}:free`);
    cfg.privacy.level = "zdr";
    await assert.rejects(chat.setModel(t.id, `${GEMMA}:free`), /has no free endpoint on OpenRouter's ZDR list/);
    const r = await chat.send(t.id, "hello");
    assert.equal(r.jobId, undefined);
    assert.match(r.error ?? "", /has no free endpoint on OpenRouter.s ZDR list/);
    assert.equal(fake.chatBodies().length, 0, "nothing was sent");
    await chat.setModel(t.id, `${XING}:free`);
    assert.equal(store.read(t.id).model, `${XING}:free`);
  } finally {
    rm(root);
  }
});

// ------------------------------------------------------------------ catalog loading

test("loadVariantEndpoints('free') fetches only :free models; a failure leaves only that model unknown", async () => {
  const models: CatalogModel[] = [...MODELS, { id: "x/y:batch", name: "B", free: false }, { id: "x/bad:free", name: "Bad", free: true }, { id: "a/../b:free", name: "U", free: true }];
  const asked: string[] = [];
  const r = await loadVariantEndpoints(models, "free", async (id) => {
    asked.push(id);
    if (id === "x/bad:free") throw new Error("HTTP 500");
    return id.startsWith(GEMMA) ? ["google-ai-studio"] : ["phala"];
  });
  assert.deepEqual(asked.sort(), ["x/bad:free", `${GEMMA}:free`, `${XING}:free`].sort());
  assert.deepEqual(r.endpoints, FREE);
  assert.deepEqual(r.failed, ["a/../b:free", "x/bad:free"]);
});

test("fetchCatalogData loads free endpoints next to batch ones; ModelCatalog saves them and sanitises the disk copy", async () => {
  const logged: unknown[] = [];
  const data = await fetchCatalogData(
    {
      listModels: async () => ({ models: MODELS }),
      listZdrEndpoints: async () => ({ endpoints: ZDR }),
      listBatchEndpoints: async () => ({ tags: [] }),
      listFreeEndpoints: async (id) => {
        if (id.startsWith(XING)) throw new Error("HTTP 503");
        return { tags: ["google-ai-studio"] };
      },
    },
    { log: (...args: unknown[]) => logged.push(args) } as never,
  );
  assert.deepEqual(data.freeEndpoints, { [GEMMA]: ["google-ai-studio"] });
  assert.deepEqual(logged, [["warn", "catalog.free_endpoints_failed", { count: 1, models: [`${XING}:free`] }]]);

  const file = tmpFile();
  const snap = await new ModelCatalog({ file, fetch: async () => ({ models: MODELS, zdr: ZDR, batchEndpoints: {}, freeEndpoints: FREE }) }).load();
  assert.deepEqual(snap.freeEndpoints, FREE);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).freeEndpoints, FREE);
  const offline = async () => {
    throw new Error("offline");
  };
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
  onDisk.freeEndpoints = { "a/b": ["ok", 3, ""], "c/d": "nope", "": ["x"] };
  fs.writeFileSync(file, JSON.stringify(onDisk).replace('"freeEndpoints":{', '"freeEndpoints":{"__proto__":["polluted"],'));
  const reread = await new ModelCatalog({ file, fetch: offline }).load();
  assert.deepEqual(reread.freeEndpoints, { "a/b": ["ok"] });
  assert.equal(Object.getPrototypeOf(reread.freeEndpoints), Object.prototype);
});

test("client listFreeEndpoints calls the public per-model :free endpoints URL", async () => {
  const urls: string[] = [];
  const client = new OpenRouterBatchClient({
    apiKey: "sk-test",
    fetchImpl: async (url) => {
      urls.push(url);
      return { status: 200, text: async () => JSON.stringify({ data: { endpoints: [{ tag: "google-ai-studio" }] } }) };
    },
  });
  assert.deepEqual((await client.listFreeEndpoints(`${GEMMA}:free`)).tags, ["google-ai-studio"]);
  assert.deepEqual(urls, ["https://openrouter.ai/api/v1/models/google/gemma-4-31b-it:free/endpoints"]);
});
