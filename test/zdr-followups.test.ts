import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { loadBatchEndpoints, ModelCatalog, type CatalogModel, type CatalogSnapshot } from "../src/models/catalog.js";
import { catalogStateLine } from "../src/privacy/commands.js";
import { batchEndpointsPath, resolveBatchProvider } from "../src/privacy/policy.js";

const GEMINI = "google/gemini-3.8-flash";

test("a model with no ZDR endpoint at all gets the definitive refusal, not a refresh hint", () => {
  const d = resolveBatchProvider({ level: "zdr", model: "x/no-zdr", catalog: { fresh: true, zdr: [], batchEndpoints: {} }, accountNoTraining: false });
  assert.equal(d.ok ? "" : d.reason, "Privacy level zdr: x/no-zdr has no batch endpoint on OpenRouter's ZDR list (its batch endpoints: unknown; ZDR endpoints: none)");
});

test("a model with ZDR endpoints but unknown batch endpoints still suggests a refresh", () => {
  const d = resolveBatchProvider({ level: "zdr", model: GEMINI, catalog: { fresh: true, zdr: [{ model: GEMINI, provider: "google-vertex/global" }], batchEndpoints: {} }, accountNoTraining: false });
  assert.match(d.ok ? "" : d.reason, /could not be loaded this session \(run \/batch privacy refresh\)/);
});

test("a zdr decision while the catalog is still loading says so", () => {
  const d = resolveBatchProvider({ level: "zdr", model: GEMINI, catalog: { fresh: false, zdr: [], loading: true }, accountNoTraining: false });
  assert.equal(d.ok ? "" : d.reason, "Privacy level zdr: the model catalog is still loading; try again in a moment");
});

test("ModelCatalog.view() marks a load still in flight", async () => {
  let release!: () => void;
  const catalog = new ModelCatalog({
    file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "zdr-view-")), "catalog.json"),
    fetch: () => new Promise((resolve) => (release = () => resolve({ models: [], zdr: [], batchEndpoints: {} }))),
  });
  const pending = catalog.load();
  assert.equal(await catalog.whenLoaded(10), undefined, "the wait times out while the load is in flight");
  assert.equal(catalog.view()?.loading, true);
  assert.equal(catalog.view()?.fresh, false);
  release();
  await pending;
  assert.equal(catalog.view()?.loading, undefined);
  assert.equal(catalog.view()?.fresh, true);
});

test("loadBatchEndpoints stops at its deadline: slow models are unknown, finished ones are kept", async () => {
  const models: CatalogModel[] = [
    { id: "m/fast:batch", name: "F", free: false },
    { id: "m/slow:batch", name: "S", free: false },
  ];
  const started = Date.now();
  const result = await loadBatchEndpoints(models, (id) => (id === "m/fast:batch" ? Promise.resolve(["fast-tag"]) : new Promise<string[]>(() => {})), 8, 50);
  assert.ok(Date.now() - started < 1000, "returns at the deadline, not when the slow request ends");
  assert.deepEqual(result.endpoints, { "m/fast": ["fast-tag"] });
  assert.deepEqual(result.failed, ["m/slow:batch"]);
});

test("model IDs with empty, '.' or '..' path segments are never fetched", async () => {
  assert.equal(batchEndpointsPath("a/../b"), undefined);
  assert.equal(batchEndpointsPath("a/./b:batch"), undefined);
  assert.equal(batchEndpointsPath("a//b"), undefined);
  assert.equal(batchEndpointsPath(GEMINI), "/models/google/gemini-3.8-flash:batch/endpoints");
  assert.equal(batchEndpointsPath("a b/c?d"), "/models/a%20b/c%3Fd:batch/endpoints");
  const asked: string[] = [];
  const result = await loadBatchEndpoints([{ id: "a/../b:batch", name: "x", free: false }, { id: `${GEMINI}:batch`, name: "g", free: false }], async (id) => (asked.push(id), ["t"]));
  assert.deepEqual(asked, [`${GEMINI}:batch`]);
  assert.deepEqual(result.failed, ["a/../b:batch"]);
});

test("the catalog status line counts batch models whose endpoints are unknown", () => {
  const snap: CatalogSnapshot = {
    fresh: true,
    zdr: [],
    models: [
      { id: "a/one:batch", name: "1", free: false },
      { id: "a/two:batch", name: "2", free: false },
      { id: "a/three:batch", name: "3", free: false },
      { id: "a/sync", name: "s", free: false },
    ],
    batchEndpoints: { "a/one": ["x"] },
    loadedAt: "2026-10-28T09:00:00.000Z",
  };
  assert.match(catalogStateLine(snap), /^fresh at .* \(batch endpoints unknown for 2 models; \/batch privacy refresh retries\)$/);
  assert.doesNotMatch(catalogStateLine({ ...snap, batchEndpoints: { "a/one": [], "a/two": [], "a/three": [] } }), /unknown/);
});
