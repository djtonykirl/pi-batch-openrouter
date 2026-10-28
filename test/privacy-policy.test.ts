import { test } from "node:test";
import * as assert from "node:assert/strict";
import { DEFAULT_CONFIG, validateConfig } from "../src/config.js";
import {
  effectiveLevel,
  immediateProviderFields,
  normaliseModelSlug,
  resolveBatchProvider,
  routeForModel,
  stricter,
  type CatalogView,
} from "../src/privacy/policy.js";

const catalog: CatalogView = {
  fresh: true,
  zdr: [
    { model: "a/b", provider: "p2" },
    { model: "a/b", provider: "p1" },
    { model: "a/b", provider: "p1" },
    { model: "c/d", provider: "p3" },
  ],
};

test("levels order and stricter", () => {
  assert.equal(stricter("zdr", "standard"), "zdr");
  assert.equal(stricter("standard", "no-training"), "no-training");
  assert.equal(effectiveLevel("no-training", undefined), "no-training");
  assert.equal(effectiveLevel("standard", "zdr"), "zdr");
  assert.equal(effectiveLevel("zdr", "standard"), "zdr");
});

test("normaliseModelSlug", () => {
  assert.equal(normaliseModelSlug("a/b:free"), "a/b");
  assert.equal(normaliseModelSlug("a/b:batch"), "a/b");
  assert.equal(normaliseModelSlug("a/b"), "a/b");
});

test("routeForModel", () => {
  assert.equal(routeForModel("a/b:free"), "immediate");
  assert.equal(routeForModel("a/b"), "batch");
  assert.equal(routeForModel("a/b:free", "batch"), "batch");
  assert.equal(routeForModel("a/b", "immediate"), "immediate");
});

test("standard keeps the user pin unchanged", () => {
  const userPin = { only: ["x"], allow_fallbacks: true };
  const withPin = resolveBatchProvider({ level: "standard", model: "a/b", userPin, accountNoTraining: false });
  assert.deepEqual(withPin, { ok: true, provider: userPin, enforcement: "none" });
  const without = resolveBatchProvider({ level: "standard", model: "a/b", accountNoTraining: false });
  assert.equal(without.ok && without.provider, undefined);
});

test("no-training on batch", () => {
  const refused = resolveBatchProvider({ level: "no-training", model: "a/b", accountNoTraining: false });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.ok(refused.reason.startsWith("Privacy level no-training: "));
  const userPin = { only: ["x"] };
  const allowed = resolveBatchProvider({ level: "no-training", model: "a/b", userPin, accountNoTraining: true });
  assert.deepEqual(allowed, { ok: true, provider: userPin, enforcement: "account attested no-training" });
});

test("zdr pins to ZDR providers", () => {
  const d = resolveBatchProvider({ level: "zdr", model: "a/b:batch", catalog, accountNoTraining: false });
  assert.deepEqual(d, {
    ok: true,
    provider: { only: ["p1", "p2"], allow_fallbacks: false },
    enforcement: "pinned to ZDR providers: p1, p2",
  });
});

test("zdr intersects with the user pin and refuses when nothing remains", () => {
  const some = resolveBatchProvider({ level: "zdr", model: "a/b", userPin: { only: ["p2", "zz"] }, catalog, accountNoTraining: false });
  assert.ok(some.ok && JSON.stringify(some.provider) === JSON.stringify({ only: ["p2"], allow_fallbacks: false }));
  const none = resolveBatchProvider({ level: "zdr", model: "a/b", userPin: { only: ["zz"] }, catalog, accountNoTraining: false });
  assert.equal(none.ok, false);
  if (!none.ok) assert.match(none.reason, /no ZDR provider/);
});

test("zdr refuses without a fresh catalog", () => {
  for (const c of [undefined, { ...catalog, fresh: false }]) {
    const d = resolveBatchProvider({ level: "zdr", model: "a/b", catalog: c, accountNoTraining: false });
    assert.equal(d.ok, false);
    if (!d.ok) {
      assert.ok(d.reason.startsWith("Privacy level zdr: "));
      assert.match(d.reason, /model catalog not loaded this session/);
    }
  }
});

test("zdr refuses when the model has no ZDR provider", () => {
  const d = resolveBatchProvider({ level: "zdr", model: "e/f:free", catalog, accountNoTraining: false });
  assert.equal(d.ok, false);
  if (!d.ok) {
    assert.ok(d.reason.startsWith("Privacy level zdr: "));
    assert.match(d.reason, /no ZDR provider/);
  }
});

test("immediateProviderFields", () => {
  assert.deepEqual(immediateProviderFields("standard"), {});
  assert.deepEqual(immediateProviderFields("no-training"), { data_collection: "deny" });
  assert.deepEqual(immediateProviderFields("zdr"), { zdr: true });
});

test("config defaults and validation", () => {
  assert.deepEqual(DEFAULT_CONFIG.privacy, {
    level: "standard",
    accountNoTraining: false,
    deleteRemoteBatches: true,
    noticeShown: false,
  });
  const r = validateConfig({ privacy: { level: "bogus" } });
  assert.equal(r.config.privacy.level, "standard");
  assert.equal(r.errors.length, 1);
  const ok = validateConfig({ privacy: { level: "zdr", accountNoTraining: true } });
  assert.equal(ok.config.privacy.level, "zdr");
  assert.equal(ok.config.privacy.accountNoTraining, true);
  assert.deepEqual(ok.errors, []);
});
