import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fetchCatalogData, loadBatchEndpoints, ModelCatalog, type CatalogModel } from "../src/models/catalog.js";
import { OpenRouterBatchClient, parseBatchEndpointTags } from "../src/openrouter/client.js";
import { pickerEntries } from "../src/privacy/commands.js";
import { resolveBatchProvider, type CatalogView, type ZdrEndpoint } from "../src/privacy/policy.js";
import { JobRegistry } from "../src/registry.js";
import { BatchService, SubmissionBlockedError, type AskOptions } from "../src/service.js";
import { BATCH_ENDPOINTS_RESPONSE } from "./fixtures/catalog.js";
import { FAKE_KEY, FakeOpenRouter, accepted, makeConfig } from "./fixtures/fake-openrouter.js";
import { rm, tempWorkspace, writeFiles } from "./helpers.js";

const CLAUDE = "anthropic/claude-opus-5.5";
const GEMINI = "google/gemini-3.8-flash";

/** Shapes seen live on 2026-10-28: Claude's ZDR endpoints are Bedrock and Vertex, but its only batch endpoint is Anthropic's. */
const ZDR: ZdrEndpoint[] = [
  { model: CLAUDE, provider: "amazon-bedrock/eu-west-1" },
  { model: CLAUDE, provider: "amazon-bedrock" },
  { model: CLAUDE, provider: "google-vertex/europe" },
  { model: GEMINI, provider: "google-vertex/global" },
  { model: GEMINI, provider: "google-vertex/us" },
];
const BATCH: Record<string, string[]> = { [CLAUDE]: ["anthropic"], [GEMINI]: ["google-vertex/global"] };
const catalog: CatalogView = { fresh: true, zdr: ZDR, batchEndpoints: BATCH };

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "zdr-batch-")), "models.json");
}

// ------------------------------------------------------------------ policy

test("zdr: a Claude-shaped model (no batch endpoint on the ZDR list) is refused", () => {
  const d = resolveBatchProvider({ level: "zdr", model: `${CLAUDE}:batch`, catalog, accountNoTraining: false });
  assert.deepEqual(d, {
    ok: false,
    reason:
      "Privacy level zdr: anthropic/claude-opus-5.5 has no batch endpoint on OpenRouter's ZDR list (its batch endpoints: anthropic; ZDR endpoints: amazon-bedrock, amazon-bedrock/eu-west-1, google-vertex/europe)",
  });
});

test("zdr: a model with batch endpoints but none on the ZDR list says 'none' for ZDR endpoints", () => {
  const d = resolveBatchProvider({ level: "zdr", model: "x/y", catalog: { ...catalog, batchEndpoints: { "x/y": ["p1"] } }, accountNoTraining: false });
  assert.equal(d.ok, false);
  if (!d.ok) assert.equal(d.reason, "Privacy level zdr: x/y has no batch endpoint on OpenRouter's ZDR list (its batch endpoints: p1; ZDR endpoints: none)");
});

test("zdr: a Gemini-shaped model pins to the batch endpoint that is on the ZDR list", () => {
  const d = resolveBatchProvider({ level: "zdr", model: GEMINI, catalog, accountNoTraining: false });
  assert.deepEqual(d, { ok: true, provider: { only: ["google-vertex/global"], allow_fallbacks: false }, enforcement: "pinned to ZDR providers: google-vertex/global" });
});

test("zdr: tags match exactly, not by base provider", () => {
  const d = resolveBatchProvider({ level: "zdr", model: "x/y", catalog: { fresh: true, zdr: [{ model: "x/y", provider: "azure/eu" }], batchEndpoints: { "x/y": ["azure"] } }, accountNoTraining: false });
  assert.equal(d.ok, false);
});

test("zdr: batch endpoints unknown for a fresh catalog is refused", () => {
  for (const c of [{ fresh: true, zdr: ZDR }, { fresh: true, zdr: ZDR, batchEndpoints: { [CLAUDE]: ["anthropic"] } }]) {
    const d = resolveBatchProvider({ level: "zdr", model: `${GEMINI}:batch`, catalog: c, accountNoTraining: false });
    assert.deepEqual(d, {
      ok: false,
      reason: "Privacy level zdr: the batch endpoints of google/gemini-3.8-flash could not be loaded this session (run /batch privacy refresh)",
    });
  }
  // A key inherited from Object.prototype is not an entry.
  const proto = resolveBatchProvider({ level: "zdr", model: "constructor", catalog: { fresh: true, zdr: [{ model: "constructor", provider: "p" }], batchEndpoints: {} }, accountNoTraining: false });
  assert.match(proto.ok ? "" : proto.reason, /could not be loaded this session/);
});

test("zdr: the intersection is narrowed by routing.allowedProviders; empty gives the allow-list message", () => {
  const c: CatalogView = { fresh: true, zdr: [...ZDR, { model: "m/n", provider: "azure/eu" }, { model: "m/n", provider: "groq" }], batchEndpoints: { "m/n": ["azure/eu", "groq", "together"] } };
  const narrowed = resolveBatchProvider({ level: "zdr", model: "m/n", catalog: c, accountNoTraining: false, allowedProviders: ["azure"] });
  assert.deepEqual(narrowed, { ok: true, provider: { only: ["azure/eu"], allow_fallbacks: false }, enforcement: "pinned to ZDR providers: azure/eu" });
  const both = resolveBatchProvider({ level: "zdr", model: "m/n", catalog: c, accountNoTraining: false });
  assert.deepEqual(both.ok && both.provider, { only: ["azure/eu", "groq"], allow_fallbacks: false });
  const none = resolveBatchProvider({ level: "zdr", model: GEMINI, catalog, accountNoTraining: false, allowedProviders: ["anthropic"] });
  assert.deepEqual(none, { ok: false, reason: "Privacy level zdr: no ZDR provider for google/gemini-3.8-flash within routing.allowedProviders (anthropic)" });
});

// ------------------------------------------------------------------ labels

test("labels: a Claude-shaped batch model has no ZDR label and is blocked at zdr; a Gemini-shaped one has it", () => {
  const snap = { ...catalog, batchEndpoints: BATCH, models: [] as CatalogModel[], loadedAt: "2026-10-28T09:00:00.000Z" };
  const e = pickerEntries(snap, [CLAUDE, `${GEMINI}:batch`], "zdr", false);
  const claude = e.find((x) => x.id === CLAUDE)!;
  const gemini = e.find((x) => x.id === `${GEMINI}:batch`)!;
  assert.deepEqual(claude.labels, ["batch"]);
  const refusal = resolveBatchProvider({ level: "zdr", model: CLAUDE, catalog, accountNoTraining: false });
  assert.equal(refusal.ok, false);
  assert.equal(claude.blocked, refusal.ok ? undefined : refusal.reason, "the picker reuses the policy's refusal text");
  assert.deepEqual(gemini.labels, ["batch", "ZDR"]);
  assert.equal(gemini.blocked, undefined);
  // At standard the labels are the same and nothing is blocked.
  const std = pickerEntries(snap, [CLAUDE], "standard", false);
  assert.deepEqual(std.find((x) => x.id === CLAUDE), { id: CLAUDE, route: "batch", labels: ["batch"] });
  // Unknown batch endpoints: no ZDR label, blocked with the unknown refusal.
  const unknown = pickerEntries({ ...snap, batchEndpoints: {} }, [GEMINI], "zdr", false).find((x) => x.id === GEMINI)!;
  assert.deepEqual(unknown.labels, ["batch"]);
  assert.match(unknown.blocked ?? "", /could not be loaded this session/);
});

test("labels: an immediate-route (free) model keeps the sync ZDR rule", () => {
  const snap = { fresh: true, zdr: [{ model: "f/free", provider: "p" }], batchEndpoints: {}, models: [{ id: "f/free:free", name: "F", free: true }], loadedAt: "2026-10-28T09:00:00.000Z" };
  const e = pickerEntries(snap, [], "zdr", false).find((x) => x.id === "f/free:free")!;
  assert.deepEqual(e.labels, ["free", "ZDR"]);
  assert.equal(e.blocked, undefined);
});

test("ModelCatalog.labels uses the batch intersection for batch-route models", async () => {
  const cat = new ModelCatalog({ file: tmpFile(), fetch: async () => ({ models: [], zdr: ZDR, batchEndpoints: BATCH }) });
  await cat.load();
  assert.deepEqual(cat.labels(`${CLAUDE}:batch`), { free: false, zdr: false });
  assert.deepEqual(cat.labels(CLAUDE), { free: false, zdr: false });
  assert.deepEqual(cat.labels(`${GEMINI}:batch`), { free: false, zdr: true });
});

// ------------------------------------------------------------------ catalog loading

test("parseBatchEndpointTags reads data.endpoints[].tag from the real shape", () => {
  assert.deepEqual(parseBatchEndpointTags(JSON.stringify(BATCH_ENDPOINTS_RESPONSE)), ["google-vertex/global"]);
  assert.deepEqual(parseBatchEndpointTags(JSON.stringify({ data: { endpoints: [{ tag: "a" }, { tag: "a" }, { tag: 3 }, null, { tag: "" }, { tag: "b/c" }] } })), ["a", "b/c"]);
  assert.deepEqual(parseBatchEndpointTags(JSON.stringify({ data: { endpoints: [] } })), []);
  assert.throws(() => parseBatchEndpointTags("{}"));
  assert.throws(() => parseBatchEndpointTags(JSON.stringify({ data: {} })));
  assert.throws(() => parseBatchEndpointTags("nope"));
});

test("client listBatchEndpoints calls the public per-model :batch endpoints URL", async () => {
  const urls: string[] = [];
  const client = new OpenRouterBatchClient({
    apiKey: "sk-test",
    fetchImpl: async (url) => {
      urls.push(url);
      return { status: 200, text: async () => JSON.stringify(BATCH_ENDPOINTS_RESPONSE) };
    },
  });
  assert.deepEqual((await client.listBatchEndpoints("google/gemini-3.8-flash:batch")).tags, ["google-vertex/global"]);
  assert.deepEqual(await client.listBatchEndpoints("google/gemini-3.8-flash").then((r) => r.tags), ["google-vertex/global"]);
  assert.deepEqual(urls, [
    "https://openrouter.ai/api/v1/models/google/gemini-3.8-flash:batch/endpoints",
    "https://openrouter.ai/api/v1/models/google/gemini-3.8-flash:batch/endpoints",
  ]);
});

test("loadBatchEndpoints runs in parallel up to the limit, and a per-model failure leaves only that model unknown", async () => {
  const models: CatalogModel[] = [
    ...Array.from({ length: 12 }, (_, i) => ({ id: `m/model-${i}:batch`, name: `M${i}`, free: false })),
    { id: "m/sync-only", name: "Sync", free: false },
    { id: "m/free:free", name: "Free", free: true },
  ];
  let active = 0;
  let peak = 0;
  const asked: string[] = [];
  const result = await loadBatchEndpoints(
    models,
    async (id) => {
      asked.push(id);
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      if (id === "m/model-3:batch") throw new Error("HTTP 500");
      return [`tag-${id}`];
    },
    4,
  );
  assert.equal(asked.length, 12, "only :batch models are fetched");
  assert.equal(peak, 4, "parallel, capped at the limit");
  assert.deepEqual(result.failed, ["m/model-3:batch"]);
  assert.equal(Object.keys(result.endpoints).length, 11);
  assert.equal(Object.hasOwn(result.endpoints, "m/model-3"), false);
  assert.deepEqual(result.endpoints["m/model-0"], ["tag-m/model-0:batch"]);
});

test("fetchCatalogData loads the core lists, then each :batch model's endpoints; one failure is logged, not fatal", async () => {
  const logged: unknown[] = [];
  const asked: string[] = [];
  const data = await fetchCatalogData(
    {
      listModels: async () => ({ models: [{ id: `${GEMINI}:batch`, name: "G", free: false }, { id: `${CLAUDE}:batch`, name: "C", free: false }, { id: GEMINI, name: "G", free: false }] }),
      listZdrEndpoints: async () => ({ endpoints: ZDR }),
      listBatchEndpoints: async (id) => {
        asked.push(id);
        if (id.startsWith("anthropic/")) throw new Error("HTTP 503");
        return { tags: ["google-vertex/global"] };
      },
    },
    { log: (...args: unknown[]) => logged.push(args) } as never,
  );
  assert.deepEqual(asked.sort(), [`${CLAUDE}:batch`, `${GEMINI}:batch`]);
  assert.deepEqual(data.batchEndpoints, { [GEMINI]: ["google-vertex/global"] });
  assert.deepEqual(data.zdr, ZDR);
  assert.equal(data.models.length, 3);
  assert.deepEqual(logged, [["warn", "catalog.batch_endpoints_failed", { count: 1, models: [`${CLAUDE}:batch`] }]]);
  await assert.rejects(
    fetchCatalogData({ listModels: async () => ({ models: [] }), listZdrEndpoints: async () => Promise.reject(new Error("zdr down")), listBatchEndpoints: async () => ({ tags: [] }) }),
    /zdr down/,
  );
});

test("ModelCatalog: batch endpoints are kept in the snapshot, saved, and round-trip through the disk copy with malformed elements dropped", async () => {
  const file = tmpFile();
  const models: CatalogModel[] = [{ id: `${GEMINI}:batch`, name: "G", free: false }];
  const snap = await new ModelCatalog({ file, fetch: async () => ({ models, zdr: ZDR, batchEndpoints: BATCH }) }).load();
  assert.equal(snap.fresh, true);
  assert.deepEqual(snap.batchEndpoints, BATCH);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).batchEndpoints, BATCH);

  const offline = async () => {
    throw new Error("offline");
  };
  const reread = await new ModelCatalog({ file, fetch: offline }).load();
  assert.equal(reread.fresh, false);
  assert.deepEqual(reread.batchEndpoints, BATCH);

  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
  onDisk.batchEndpoints = { "a/b": ["ok", 3, "", null, "ok2"], "c/d": "nope", "e/f": null, "": ["x"], "g/h": [] };
  fs.writeFileSync(file, JSON.stringify(onDisk));
  assert.deepEqual((await new ModelCatalog({ file, fetch: offline }).load()).batchEndpoints, { "a/b": ["ok", "ok2"], "g/h": [] });

  fs.writeFileSync(file, JSON.stringify(onDisk).replace('"batchEndpoints":{', '"batchEndpoints":{"__proto__":["polluted"],'));
  const proto = (await new ModelCatalog({ file, fetch: offline }).load()).batchEndpoints;
  assert.deepEqual(proto, { "a/b": ["ok", "ok2"], "g/h": [] });
  assert.equal(Object.getPrototypeOf(proto), Object.prototype);

  for (const bad of [[1, 2], "x", null]) {
    onDisk.batchEndpoints = bad;
    fs.writeFileSync(file, JSON.stringify(onDisk));
    assert.deepEqual((await new ModelCatalog({ file, fetch: offline }).load()).batchEndpoints, {});
  }
  delete onDisk.batchEndpoints;
  fs.writeFileSync(file, JSON.stringify(onDisk));
  const old = await new ModelCatalog({ file, fetch: offline }).load();
  assert.deepEqual(old.batchEndpoints, {}, "a copy saved before batch endpoints existed reads as all unknown");
  assert.deepEqual(old.models, models);
});

test("ModelCatalog: a fetch without batch endpoints leaves every model unknown but the catalog fresh", async () => {
  const snap = await new ModelCatalog({ file: tmpFile(), fetch: async () => ({ models: [], zdr: ZDR }) }).load();
  assert.equal(snap.fresh, true);
  assert.deepEqual(snap.batchEndpoints, {});
});

// ------------------------------------------------------------------ service: nothing persisted or posted

const ASK: AskOptions = { objective: "Review the authentication design", files: ["src/auth.ts"], contexts: [], format: "markdown", includeInstructions: true };

test("a zdr /batch ask on a Claude-shaped model is refused before anything is persisted or posted", async () => {
  const root = tempWorkspace("pi batch zdr-batch-");
  writeFiles(root, { "src/auth.ts": "export function login() { return true; }\r\n" });
  try {
    const fake = new FakeOpenRouter();
    fake.submitReplies = [accepted()];
    const cfg = makeConfig((c) => {
      c.privacy.level = "zdr";
      c.defaultModel = CLAUDE;
    });
    const cat = new ModelCatalog({ file: path.join(root, "catalog.json"), fetch: async () => ({ models: [], zdr: ZDR, batchEndpoints: BATCH }) });
    await cat.load();
    const jobsDir = path.join(root, ".pi", "batches");
    const service = new BatchService({
      registry: new JobRegistry(jobsDir),
      workspaceRoot: root,
      getConfig: () => cfg,
      resolveApiKey: async () => FAKE_KEY,
      createClient: (apiKey, timeoutMs) => new OpenRouterBatchClient({ apiKey, fetchImpl: fake.fetch, timeoutMs }),
      gitIgnored: () => new Set(),
      catalog: cat,
    });
    await assert.rejects(service.createJob(await service.prepare(ASK), { previewOnly: false }), (err: unknown) => {
      assert.ok(err instanceof SubmissionBlockedError);
      assert.match(err.message, /^Privacy level zdr: anthropic\/claude-opus-5\.5 has no batch endpoint on OpenRouter's ZDR list \(its batch endpoints: anthropic;/);
      return true;
    });
    const dirs = fs.existsSync(jobsDir) ? fs.readdirSync(jobsDir, { withFileTypes: true }).filter((e) => e.isDirectory()) : [];
    assert.deepEqual(dirs, []);
    assert.equal(fake.requests.filter((r) => r.method === "POST").length, 0);
  } finally {
    rm(root);
  }
});
