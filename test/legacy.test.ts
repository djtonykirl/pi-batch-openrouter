import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { sha256Hex } from "../src/fsutil.js";
import { formatLegacyInventory, inventoryLegacyJobs, resolveLegacyTimestamp } from "../src/legacy.js";
import { FakeOpenRouter, accepted, makeService } from "./fixtures/fake-openrouter.js";
import { rm, tempWorkspace, writeFiles } from "./helpers.js";

// Sanitised, synthetic fixture: no usernames, machine paths or real API data.
const MS = 1_792_074_000_000; // 2026-10-15T14:20:00Z in milliseconds (legacy createdAt: Date.now())
const S = 1_792_074_370; // provider finalized_at in seconds
const LEGACY = [
  { id: "batch_legacy_ok", title: "Review module", model: "m", provider: "openrouter", status: "completed", createdAt: MS, finalizedAt: S, totalRequests: 1, completedRequests: 1, failedRequests: 0, outputDir: "<redacted>", resultsSaved: true, items: [{ customId: "goal-1", prompt: "p", response: "r" }] },
  { id: "batch_legacy_s", title: "t", model: "m", provider: "openrouter", status: "in_progress", createdAt: 1_792_000_000, finalizedAt: null, totalRequests: 1, completedRequests: 0, failedRequests: 0, resultsSaved: false, items: [{ customId: "goal-1", prompt: "p" }] },
  { id: "batch_legacy_bad", title: "t", model: "m", provider: "openrouter", status: "completed", createdAt: 42, finalizedAt: "yesterday", resultsSaved: false, items: [] },
  { id: "batch_legacy_ok", title: "dup", model: "m", provider: "openrouter", status: "completed", createdAt: MS, items: [] },
  { id: "", status: "weird", createdAt: Number.MAX_SAFE_INTEGER, items: "nope" },
  "not an object",
];

test("legacy timestamps: seconds, milliseconds, mixed, null, implausible and malformed are resolved explicitly or left unresolved", () => {
  assert.deepEqual(resolveLegacyTimestamp(S), { state: "resolved", iso: "2026-10-15T14:26:10.000Z", unit: "seconds" });
  assert.deepEqual(resolveLegacyTimestamp(MS), { state: "resolved", iso: "2026-10-15T14:20:00.000Z", unit: "milliseconds" });
  assert.deepEqual(resolveLegacyTimestamp(null), { state: "missing" });
  assert.deepEqual(resolveLegacyTimestamp(undefined), { state: "missing" });
  assert.deepEqual(resolveLegacyTimestamp(42), { state: "unresolved", reason: "implausible" });
  assert.deepEqual(resolveLegacyTimestamp(5_000_000_000), { state: "unresolved", reason: "implausible" }); // year 2128 in s, 1970 in ms
  assert.deepEqual(resolveLegacyTimestamp(Number.MAX_SAFE_INTEGER), { state: "unresolved", reason: "implausible" });
  assert.deepEqual(resolveLegacyTimestamp("2026-10-15"), { state: "unresolved", reason: "not_a_number" });
  assert.deepEqual(resolveLegacyTimestamp(Number.NaN), { state: "unresolved", reason: "not_a_number" });
});

test("legacy inventory: per-record problems, duplicates, mixed units, never ready, no free text in the report", () => {
  const inv = inventoryLegacyJobs(JSON.stringify(LEGACY), new Map());
  assert.deepEqual(inv.fatal, []);
  assert.deepEqual(inv.counts, { records: 6, withProblems: 2, duplicates: 1, alreadyKnown: 0, timestampsUnresolved: 2 });
  const [ok, secs, bad, dup, weird, notObj] = inv.records;
  assert.equal(ok!.createdAt.state === "resolved" && ok!.createdAt.unit, "milliseconds");
  assert.equal(ok!.finalizedAt.state === "resolved" && ok!.finalizedAt.unit, "seconds"); // mixed units in one record
  assert.deepEqual([ok!.items, ok!.itemsWithResponse, ok!.problems], [1, 1, []]);
  assert.equal(secs!.createdAt.state === "resolved" && secs!.createdAt.unit, "seconds");
  assert.deepEqual(secs!.finalizedAt, { state: "missing" });
  assert.deepEqual([bad!.createdAt.state, bad!.finalizedAt.state], ["unresolved", "unresolved"]);
  assert.equal(dup!.duplicateOf, 1);
  assert.deepEqual(weird!.problems, ["missing or invalid provider batch id", "missing or unknown status", "items is not an array"]);
  assert.deepEqual(notObj!.problems, ["record is not an object"]);
  assert.ok(inv.records.every((r) => r.provenance === "legacy-unresolved"));
  const text = formatLegacyInventory(inv);
  assert.match(text, /nothing was imported, written or sent/);
  for (const secretish of ["Review module", "<redacted>", "goal-1", '"r"']) assert.ok(!text.includes(secretish), secretish);
  assert.match(inventoryLegacyJobs("{", new Map()).fatal.join(), /not valid JSON/);
  assert.match(inventoryLegacyJobs("{}", new Map()).fatal.join(), /expected a JSON array/);
});

test("legacy preview: source file untouched, idempotent, no network, already-known jobs detected", async () => {
  const root = tempWorkspace();
  try {
    writeFiles(root, { "legacy/jobs.json": JSON.stringify(LEGACY, null, 2), "src/a.ts": "export const a = 1;\n" });
    const file = path.join(root, "legacy/jobs.json");
    const before = { sha: sha256Hex(fs.readFileSync(file)), mtime: fs.statSync(file).mtimeMs };
    const fake = new FakeOpenRouter();
    const service = makeService(root, fake);
    const a = service.legacyInventory("legacy/jobs.json");
    const b = service.legacyInventory(file);
    assert.deepEqual(a, b);
    assert.equal(fake.requests.length, 0);
    assert.deepEqual({ sha: sha256Hex(fs.readFileSync(file)), mtime: fs.statSync(file).mtimeMs }, before);
    assert.equal(service.registry.list().jobs.length, 0);
    // A job already tracked locally under the same provider batch ID is reported as known.
    fake.submitReplies = [accepted("batch_legacy_s")];
    const job = await service.createJob(await service.prepare({ objective: "x", files: ["src/a.ts"], contexts: [], format: "markdown", includeInstructions: true }), { previewOnly: false });
    const c = service.legacyInventory(file);
    assert.equal(c.records[1]!.alreadyKnownAs, job.localId);
    assert.equal(c.counts.alreadyKnown, 1);
    assert.throws(() => service.legacyInventory("legacy/missing.json"), /not found/);
  } finally {
    rm(root);
  }
});
