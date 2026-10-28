import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { OpenRouterBatchClient, parseModels, parseZdrEndpoints } from "../src/openrouter/client.js";
import { immediateRouteAllowed, immediateRouteRefusal, ModelCatalog, type CatalogModel } from "../src/models/catalog.js";
import { pickerEntries } from "../src/privacy/commands.js";
import type { ZdrEndpoint } from "../src/privacy/policy.js";
import { MODELS_RESPONSE, ZDR_RESPONSE } from "./fixtures/catalog.js";

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "catalog-")), "models.json");
}

const MODELS: CatalogModel[] = [
  { id: "a/b", name: "A: B", free: false },
  { id: "c/d:free", name: "C: D", free: true, contextLength: 1000 },
];
const ZDR: ZdrEndpoint[] = [{ model: "a/b", provider: "azure" }];

test("an explicit immediate route needs a :free ID or a catalog loaded this session that lists the model as free", () => {
  const snap = (fresh: boolean) => ({ fresh, zdr: [], batchEndpoints: {}, models: [{ id: "z/zero-priced", name: "Z", free: true }], loadedAt: "2026-10-28T09:00:00.000Z" });
  assert.equal(immediateRouteAllowed("c/one:free", undefined), true);
  assert.equal(immediateRouteAllowed("z/zero-priced", snap(true)), true);
  assert.equal(immediateRouteAllowed("z/zero-priced", snap(false)), false, "a copy read from disk may be out of date: never decides a route");
  assert.equal(immediateRouteAllowed("z/zero-priced", undefined), false);
  assert.equal(immediateRouteAllowed("a/paid", snap(true)), false);
  assert.match(immediateRouteRefusal("z/zero-priced"), /loaded this session/);
});

test("parseModels marks free", () => {
  const models = parseModels(JSON.stringify(MODELS_RESPONSE));
  assert.equal(models.length, MODELS_RESPONSE.data.length);
  const byId = new Map(models.map((m) => [m.id, m]));
  assert.equal(byId.get("openai/gpt-6.1-terra-pro")?.free, false);
  assert.equal(byId.get("openai/gpt-6.1-terra-pro:batch")?.free, false);
  assert.equal(byId.get("recursive/flint-v1.0:free")?.free, true);
  assert.equal(byId.get("recursive/flint-v1.0:free")?.contextLength, 262144);
  assert.equal(byId.get("google/lyria-3-pro-preview")?.free, true, "zero prompt and completion pricing is free");
  assert.equal(byId.get("openai/gpt-6.1-terra-pro")?.name, "OpenAI: GPT-6.1 Terra Pro");
});

test("parseZdrEndpoints normalises model slugs", () => {
  const eps = parseZdrEndpoints(JSON.stringify(ZDR_RESPONSE));
  assert.equal(eps.length, ZDR_RESPONSE.data.length);
  assert.deepEqual(eps.find((e) => e.provider === "baseten"), { model: "baseten/mammoth-1", provider: "baseten" });
  assert.deepEqual(eps[0], { model: "cloudflare/clef-flash", provider: "makora/bf16" }, "full tag is kept");
  assert.deepEqual(eps.find((e) => e.provider === "amazon-bedrock"), { model: "amazon/titan-embed-image-v1", provider: "amazon-bedrock" });
});

test("parseZdrEndpoints keeps full tags and drops duplicate pairs", () => {
  const e = (model_id: string, tag: string) => ({ model_id, tag });
  const eps = parseZdrEndpoints(JSON.stringify({ data: [e("x/y", "azure/eu"), e("x/y:free", "azure/eu"), e("x/y", "azure"), e("x/y", "azure/eu")] }));
  assert.deepEqual(eps, [{ model: "x/y", provider: "azure/eu" }, { model: "x/y", provider: "azure" }]);
});

test("parsers reject non-JSON and wrong shapes", () => {
  assert.throws(() => parseModels("nope"));
  assert.throws(() => parseModels("{}"));
  assert.throws(() => parseZdrEndpoints("{}"));
});

test("load is deduplicated", async () => {
  let calls = 0;
  const cat = new ModelCatalog({
    file: tmpFile(),
    fetch: async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return { models: MODELS, zdr: ZDR };
    },
  });
  const [a, b] = await Promise.all([cat.load(), cat.load()]);
  assert.equal(calls, 1);
  assert.equal(a, b);
});

test("a successful load is fresh and saved to disk", async () => {
  const file = tmpFile();
  const cat = new ModelCatalog({ file, fetch: async () => ({ models: MODELS, zdr: ZDR, batchEndpoints: { "a/b": ["azure"] } }), now: () => new Date("2026-10-27T00:00:00Z") });
  const snap = await cat.load();
  assert.equal(snap.fresh, true);
  assert.equal(snap.error, undefined);
  assert.equal(snap.loadedAt, "2026-10-27T00:00:00.000Z");
  assert.deepEqual(cat.snapshot(), snap);
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(onDisk.models, MODELS);
  assert.deepEqual(onDisk.zdr, ZDR);
  assert.deepEqual(onDisk.batchEndpoints, { "a/b": ["azure"] });
  assert.deepEqual(cat.labels("c/d:free"), { free: true, zdr: false });
  assert.deepEqual(cat.labels("a/b:batch"), { free: false, zdr: true });
  assert.deepEqual(cat.labels("unknown/x"), { free: false, zdr: false });
});

test("failed load falls back to last-known with fresh=false", async () => {
  const file = tmpFile();
  await new ModelCatalog({ file, fetch: async () => ({ models: MODELS, zdr: ZDR }) }).load();
  const cat = new ModelCatalog({ file, fetch: async () => { throw new Error("offline"); } });
  const snap = await cat.load();
  assert.equal(snap.fresh, false);
  assert.match(snap.error ?? "", /offline/);
  assert.deepEqual(snap.models, MODELS);
  assert.deepEqual(cat.snapshot(), snap);
});

test("a corrupt disk copy: malformed models and zdr elements are dropped, so pickerEntries can't throw", async () => {
  const file = tmpFile();
  fs.writeFileSync(
    file,
    JSON.stringify({
      models: [null, 42, "x", { id: 7, name: "bad", free: true }, { name: "no id", free: true }, { id: "e/f:free", name: "E", free: "yes" }, ...MODELS],
      zdr: [null, { model: 1, provider: "p" }, { model: "a/b" }, [], ...ZDR],
      batchEndpoints: { "a/b": ["azure", 5], "x/y": "bad" },
      loadedAt: "2026-10-27T09:00:00.000Z",
    }),
  );
  const cat = new ModelCatalog({ file, fetch: async () => { throw new Error("offline"); } });
  const snap = await cat.load();
  assert.equal(snap.fresh, false);
  assert.deepEqual(snap.models, MODELS);
  assert.deepEqual(snap.zdr, ZDR);
  assert.deepEqual(snap.batchEndpoints, { "a/b": ["azure"] });
  for (const level of ["standard", "no-training", "zdr"] as const) {
    const entries = pickerEntries(snap, ["a/b", "x/y"], level, false);
    assert.ok(entries.some((e) => e.id === "c/d:free"));
  }
  assert.deepEqual(cat.labels("a/b"), { free: false, zdr: true });
});

test("failed load with no disk copy yields an empty non-fresh snapshot", async () => {
  const cat = new ModelCatalog({ file: tmpFile(), fetch: async () => { throw new Error("offline"); } });
  const snap = await cat.load();
  assert.equal(snap.fresh, false);
  assert.deepEqual(snap.models, []);
  assert.deepEqual(snap.zdr, []);
  assert.deepEqual(snap.batchEndpoints, {});
  assert.ok(snap.error);
});

test("refresh after failure becomes fresh", async () => {
  let n = 0;
  const cat = new ModelCatalog({
    file: tmpFile(),
    fetch: async () => {
      if (n++ === 0) throw new Error("boom");
      return { models: MODELS, zdr: ZDR };
    },
  });
  assert.equal((await cat.load()).fresh, false);
  assert.equal(cat.snapshot()?.fresh, false);
  await cat.load();
  assert.equal(cat.snapshot()?.fresh, true);
  assert.equal(cat.snapshot()?.error, undefined);
});

test("whenLoaded times out", async () => {
  const cat = new ModelCatalog({ file: tmpFile(), fetch: () => new Promise(() => {}) });
  void cat.load();
  const started = Date.now();
  assert.equal(await cat.whenLoaded(30), undefined);
  assert.ok(Date.now() - started < 1000);
});

test("whenLoaded resolves with the snapshot once loaded", async () => {
  const cat = new ModelCatalog({ file: tmpFile(), fetch: async () => ({ models: MODELS, zdr: ZDR }) });
  void cat.load();
  assert.equal((await cat.whenLoaded(1000))?.fresh, true);
});

test("client listModels and listZdrEndpoints call the public endpoints", async () => {
  const urls: string[] = [];
  const client = new OpenRouterBatchClient({
    apiKey: "sk-test",
    fetchImpl: async (url) => {
      urls.push(url);
      const body = url.endsWith("/models") ? MODELS_RESPONSE : ZDR_RESPONSE;
      return { status: 200, text: async () => JSON.stringify(body) };
    },
  });
  const m = await client.listModels();
  const z = await client.listZdrEndpoints();
  assert.deepEqual(urls, ["https://openrouter.ai/api/v1/models", "https://openrouter.ai/api/v1/endpoints/zdr"]);
  assert.equal(m.models.length, MODELS_RESPONSE.data.length);
  assert.equal(z.endpoints.length, ZDR_RESPONSE.data.length);
  assert.equal(m.raw.status, 200);
});
