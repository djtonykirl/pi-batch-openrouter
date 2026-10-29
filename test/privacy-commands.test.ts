import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { loadConfig, projectConfigPath, readPrivacyConfig, saveConfigUpdate } from "../src/config.js";
import { describeJob } from "../src/dashboard.js";
import type { CatalogSnapshot } from "../src/models/catalog.js";
import { cmdPrivacy, formatPrivacyStatus, pickerEntries, PRIVACY_NOTICE } from "../src/privacy/commands.js";
import type { BatchRuntime } from "../src/runtime.js";
import type { JobManifest } from "../src/types.js";

const snap = (over: Partial<CatalogSnapshot> = {}): CatalogSnapshot => ({
  fresh: true,
  loadedAt: "2026-10-27T09:00:00.000Z",
  models: [
    { id: "a/batchy", name: "Batchy", free: false },
    { id: "b/zdrmodel", name: "Zdr", free: false },
    { id: "c/free-one:free", name: "Free", free: true },
    { id: "d/free-two:free", name: "Free2", free: true },
  ],
  zdr: [
    { model: "b/zdrmodel", provider: "p1" },
    { model: "c/free-one", provider: "p2" },
  ],
  // a/batchy's batch endpoint is not on the ZDR list; b/zdrmodel's is.
  batchEndpoints: { "a/batchy": ["p9"], "b/zdrmodel": ["p1"] },
  // c/free-one:free runs on p2, which is on the ZDR list; d/free-two:free runs on a host that is not.
  freeEndpoints: { "c/free-one": ["p2"], "d/free-two": ["px"] },
  ...over,
});

const byId = (entries: ReturnType<typeof pickerEntries>, id: string) => entries.find((e) => e.id === id);

test("pickerEntries at standard labels batch, free and ZDR and blocks nothing", () => {
  const e = pickerEntries(snap(), ["a/batchy", "b/zdrmodel"], "standard", false);
  assert.deepEqual(byId(e, "a/batchy"), { id: "a/batchy", route: "batch", labels: ["batch"] });
  assert.deepEqual(byId(e, "b/zdrmodel")?.labels, ["batch", "ZDR"]);
  assert.equal(byId(e, "c/free-one:free")?.route, "immediate");
  assert.deepEqual(byId(e, "c/free-one:free")?.labels, ["free", "ZDR"]);
  assert.deepEqual(byId(e, "d/free-two:free")?.labels, ["free"]);
  assert.ok(e.every((x) => !x.blocked));
});

test("pickerEntries at no-training blocks batch models until attested; free stay offered", () => {
  const e = pickerEntries(snap(), ["a/batchy"], "no-training", false);
  assert.match(byId(e, "a/batchy")?.blocked ?? "", /attest/);
  assert.equal(byId(e, "d/free-two:free")?.blocked, undefined);
  const ok = pickerEntries(snap(), ["a/batchy"], "no-training", true);
  assert.equal(byId(ok, "a/batchy")?.blocked, undefined);
});

test("pickerEntries at zdr blocks models without a ZDR endpoint, with a reason", () => {
  const e = pickerEntries(snap(), ["a/batchy", "b/zdrmodel"], "zdr", true);
  assert.equal(byId(e, "a/batchy")?.blocked, "Privacy level zdr: a/batchy has no batch endpoint on OpenRouter's ZDR list (its batch endpoints: p9; ZDR endpoints: none)");
  assert.equal(byId(e, "b/zdrmodel")?.blocked, undefined);
  assert.equal(byId(e, "c/free-one:free")?.blocked, undefined);
  assert.equal(byId(e, "d/free-two:free")?.blocked, "Privacy level zdr: d/free-two:free has no free endpoint on OpenRouter's ZDR list (its free endpoints: px; ZDR endpoints: none)");
});

test("pickerEntries at zdr blocks everything when the catalog is stale or missing", () => {
  const stale = pickerEntries(snap({ fresh: false }), ["b/zdrmodel"], "zdr", true);
  assert.ok(stale.length > 0 && stale.every((x) => /not loaded/.test(x.blocked ?? "")));
  const none = pickerEntries(undefined, ["b/zdrmodel"], "zdr", true);
  assert.match(byId(none, "b/zdrmodel")?.blocked ?? "", /not loaded/);
});

test("pickerEntries without a catalog still lists batch models", () => {
  const e = pickerEntries(undefined, ["a/batchy"], "standard", false);
  assert.deepEqual(e.map((x) => x.id), ["a/batchy"]);
});

test("formatPrivacyStatus covers fresh, stale and loading catalogs", () => {
  const base = { level: "zdr" as const, source: "project", accountNoTraining: false };
  const fresh = formatPrivacyStatus({ ...base, snapshot: snap() });
  assert.match(fresh, /Privacy level: zdr \(project\)/);
  assert.match(fresh, /fresh at /);
  assert.match(fresh, /openrouter\.ai\/settings\/privacy/);
  assert.match(fresh, /not attested/);
  const stale = formatPrivacyStatus({ ...base, snapshot: snap({ fresh: false, error: "boom" }) });
  assert.match(stale, /from .*refresh failed/);
  const loading = formatPrivacyStatus({ ...base, snapshot: undefined });
  assert.match(loading, /loading/);
  assert.match(formatPrivacyStatus({ ...base, accountNoTraining: true, snapshot: undefined }), /attested/);
  const at = formatPrivacyStatus({ ...base, accountNoTraining: true, attestedAt: "2026-10-27T10:00:00.000Z", snapshot: undefined });
  assert.match(at, /attested .*2026-10-27/);
  assert.match(at, /cannot verify/);
});

function fakeRt(dir: string): { rt: BatchRuntime; notes: string[] } {
  const notes: string[] = [];
  const empty = path.join(dir, "no-global.json");
  const state = {
    cwd: dir,
    loaded: loadConfig(dir, empty),
    privacy: () => readPrivacyConfig(dir, empty, state.loaded.config.privacy),
    catalog: null,
    notify: (m: string) => notes.push(m),
    reloadConfig: () => {
      state.loaded = loadConfig(dir, empty);
    },
  };
  return { rt: state as unknown as BatchRuntime, notes };
}

test("cmdPrivacy sets the level and shows the account notice only once", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "privcmd-"));
  const { rt, notes } = fakeRt(dir);
  await cmdPrivacy(rt, ["no-training"], false);
  assert.equal(rt.loaded.config.privacy.level, "no-training");
  assert.equal(rt.loaded.config.privacy.noticeShown, true);
  assert.equal(notes.filter((n) => n.includes(PRIVACY_NOTICE)).length, 1);
  await cmdPrivacy(rt, ["zdr"], false);
  assert.equal(rt.loaded.config.privacy.level, "zdr");
  assert.equal(notes.filter((n) => n.includes(PRIVACY_NOTICE)).length, 1);
  assert.ok(fs.existsSync(projectConfigPath(dir)));
});

test("cmdPrivacy standard does not show the notice; attest and unattest toggle the flag", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "privcmd-"));
  const { rt, notes } = fakeRt(dir);
  await cmdPrivacy(rt, ["standard"], false);
  assert.equal(notes.some((n) => n.includes(PRIVACY_NOTICE)), false);
  assert.equal(rt.loaded.config.privacy.noticeShown, false);
  await cmdPrivacy(rt, ["attest"], false);
  assert.equal(rt.loaded.config.privacy.accountNoTraining, true);
  assert.match(rt.loaded.config.privacy.attestedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
  await cmdPrivacy(rt, ["unattest"], false);
  assert.equal(rt.loaded.config.privacy.accountNoTraining, false);
  assert.equal(rt.loaded.config.privacy.attestedAt, undefined);
  await assert.rejects(() => cmdPrivacy(rt, ["bogus"], false), /Usage/);
});

test("cmdPrivacy with no argument shows status; refresh without a catalog explains", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "privcmd-"));
  const { rt, notes } = fakeRt(dir);
  await cmdPrivacy(rt, [], false);
  assert.match(notes.at(-1) ?? "", /Privacy level: standard/);
  await assert.rejects(() => cmdPrivacy(rt, ["refresh"], false), /catalog/i);
});

test("cmdPrivacy shows the level as it is now, including a change made by another process", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "privcmd-"));
  const { rt, notes } = fakeRt(dir);
  saveConfigUpdate({ privacy: { level: "zdr" } }, { cwd: dir, global: false }); // another Pi session or the web UI
  assert.equal(rt.loaded.config.privacy.level, "standard", "this process's snapshot is stale");
  await cmdPrivacy(rt, [], false);
  assert.match(notes.at(-1) ?? "", /Privacy level: zdr/);
});

test("describeJob shows privacy, route, enforcement and deletion; immediate jobs have no batch ID", () => {
  const job = {
    localId: "B-1",
    objective: "x",
    model: "c/free-one:free",
    route: "immediate",
    privacy: { level: "zdr", route: "immediate", enforcement: "provider.zdr: true" },
    remoteDeletion: { state: "pending", attempts: 1 },
    context: { fileCount: 0, characters: 0, excludedCount: 0 },
    warnings: [],
  } as unknown as JobManifest;
  const text = describeJob(job).join("\n");
  assert.match(text, /Route\s+immediate/);
  assert.match(text, /Privacy\s+zdr/);
  assert.match(text, /provider\.zdr: true/);
  assert.match(text, /Remote deletion\s+pending/);
  assert.match(text, /Provider batch ID\s+none/);
  assert.doesNotMatch(text, /undefined/);
  const legacy = describeJob({ ...job, route: undefined, privacy: undefined, remoteDeletion: undefined, providerBatchId: "bt_1" } as unknown as JobManifest).join("\n");
  assert.match(legacy, /Provider batch ID\s+bt_1/);
  assert.doesNotMatch(legacy, /Privacy\s/);
});
