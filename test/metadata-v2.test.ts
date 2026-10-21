import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { validateConfig } from "../src/config.js";
import { canonicalJson, sha256Hex } from "../src/fsutil.js";
import { TABLE_EVIDENCE_SCHEMA, evidenceHash, tableEvidenceProblems, usesV2Evidence, type TableEvidence } from "../src/metadata/contract.js";
import { METADATA_INSTRUCTIONS, METADATA_V2_INSTRUCTIONS, parseTables, renderMetadataPrompt } from "../src/metadata/plan.js";
import { metadataReviewMarkdown, type MetadataOutcome } from "../src/metadata/report.js";
import { formatPin, resolveRouting } from "../src/openrouter/routing.js";
import type { JobManifest } from "../src/types.js";
import { FakeOpenRouter, accepted, makeConfig, makeService } from "./fixtures/fake-openrouter.js";
import { CONTEXT_MD, TABLES, metadataWorkspace } from "./fixtures/metadata.js";
import { rm } from "./helpers.js";

/**
 * Contract v2 (Databricks profile evidence) and provider routing. The fixtures in
 * test/fixtures/contract/ are copied verbatim from the Databricks side's contract
 * (UC_Metadata_Governance/contract), synthetic data only.
 */

const fixture = (name: string): string => fs.readFileSync(path.resolve("test", "fixtures", "contract", name), "utf8");
const jsonl = (text: string): unknown[] => text.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l) as unknown);

test("v2 schema mirrors the Databricks contract file field for field", () => {
  const { $schema: _s, $id: _i, title: _t, description: _d, ...external } = JSON.parse(fixture("tables.v2.schema.json")) as Record<string, unknown>;
  assert.deepEqual(JSON.parse(JSON.stringify(TABLE_EVIDENCE_SCHEMA)), external);
});

test("v1 lines still validate and hash exactly as before (Databricks provenance depends on it)", () => {
  const v1 = fixture("tables.v1.valid.jsonl");
  const parsed = parseTables(v1);
  assert.deepEqual(parsed.problems, []);
  assert.equal(parsed.records.length, 3);
  for (const r of parsed.records) assert.equal(usesV2Evidence(r.evidence), false);
  // Pinned hashes computed by the Phase 1 code (JavaScript reference in canonical_hash_cases.json).
  assert.equal(evidenceHash(parsed.records[0]!.evidence), "1fcdbd3050cd340c72ced3a686f9ba5d4136e1154cb92385940486434dad106e");
  assert.equal(evidenceHash(parsed.records[1]!.evidence), "d6d52dce32b07ad29329e2398a90b25300cb17cdf43184f724403a9d54362df4");
  for (const c of JSON.parse(fixture("canonical_hash_cases.json")) as Array<{ name: string; source: string; canonical: string; sha256: string }>) {
    const value = JSON.parse(c.source) as unknown;
    assert.equal(canonicalJson(value), c.canonical, c.name);
    assert.equal(sha256Hex(canonicalJson(value)), c.sha256, c.name);
  }
});

test("v2 lines are accepted and recognised as v2", () => {
  const parsed = parseTables(fixture("tables.v2.valid.jsonl"));
  assert.deepEqual(parsed.problems, []);
  assert.equal(parsed.records.length, 3);
  for (const r of parsed.records) assert.equal(usesV2Evidence(r.evidence), true);
  assert.deepEqual(parsed.records.map((r) => r.evidence.layer), ["bronze", "silver", "gold"]);
});

test("invalid contract lines fail for the reasons the Databricks contract states", () => {
  const lines = jsonl(fixture("tables.invalid.jsonl"));
  const expect = JSON.parse(fixture("tables.invalid.expect.json")) as Array<{ line: number; v2: "pass" | "fail" }>;
  assert.equal(lines.length, expect.length);
  for (const e of expect) {
    const problems = tableEvidenceProblems(lines[e.line - 1]);
    if (e.v2 === "fail") assert.notDeepEqual(problems, [], `line ${e.line} should fail the schema`);
  }
  // Line 6 is schema-valid but has duplicate column names (case-insensitive): Pi rejects it.
  assert.match(tableEvidenceProblems(lines[5]).join("\n"), /duplicate column/);
});

test("v2 tier rules and strictness", () => {
  const base = JSON.parse(fixture("tables.v2.valid.jsonl").split(/\r?\n/)[0]!) as TableEvidence & { columns: Array<Record<string, unknown>> };
  const withColumn = (patch: Record<string, unknown>): unknown => ({ ...base, columns: [{ ...base.columns[0], ...patch }, ...base.columns.slice(1)] });
  const profile = (p: Record<string, unknown>) => ({ profile: { disclosure_tier: 1, tier_reason: "test", ...p } });
  const fails = (v: unknown, re: RegExp) => assert.match(tableEvidenceProblems(v).join("\n"), re);
  fails(withColumn({ ...profile({ disclosure_tier: 2 }), sample_values: ["X"] }), /must NOT be valid|must match "then" schema/);
  fails(withColumn({ ...profile({ disclosure_tier: 1 }), sample_values: ["X"] }), /must NOT be valid|must match "then" schema/);
  fails(withColumn(profile({ disclosure_tier: 2, format_masks: [{ mask: "AA-9999", pct: 100 }] })), /must NOT be valid/);
  fails(withColumn(profile({ disclosure_tier: 3, magnitude_order: 3 })), /must NOT be valid/);
  fails(withColumn(profile({ disclosure_tier: 4 })), /disclosure_tier must be <= 3/);
  fails(withColumn(profile({ raw_values: ["leak"] })), /must NOT have additional properties \("raw_values"\)/);
  fails(withColumn(profile({ format_masks: [{ mask: "ab%c", pct: 1 }] })), /mask must match pattern/);
  fails({ ...base, contract_version: "3" }, /contract_version must be equal to constant/);
  // contract_version "2" requires a profile on every column.
  const { profile: _p, ...noProfile } = base.columns[0]!;
  fails({ ...base, columns: [noProfile, ...base.columns.slice(1)] }, /must have required property 'profile'/);
  // Tier 0 may carry samples.
  assert.deepEqual(tableEvidenceProblems(withColumn({ profile: { disclosure_tier: 0, tier_reason: "low cardinality" }, sample_values: ["A", "B"] })), []);
});

test("prompt: v1 evidence gets the Phase 1 instructions only; v2 evidence adds profile guidance", () => {
  const v1Prompt = renderMetadataPrompt(CONTEXT_MD, TABLES[1] as unknown as TableEvidence);
  for (const r of METADATA_INSTRUCTIONS) assert.ok(v1Prompt.includes(`- ${r}`));
  for (const r of METADATA_V2_INSTRUCTIONS) assert.ok(!v1Prompt.includes(r));
  const v2 = parseTables(fixture("tables.v2.valid.jsonl")).records[2]!.evidence;
  const v2Prompt = renderMetadataPrompt(CONTEXT_MD, v2);
  for (const r of [...METADATA_INSTRUCTIONS, ...METADATA_V2_INSTRUCTIONS]) assert.ok(v2Prompt.includes(`- ${r}`));
  // Guidance sits in the instructions section, before the quoted evidence.
  assert.ok(v2Prompt.indexOf(METADATA_V2_INSTRUCTIONS[0]!) < v2Prompt.indexOf("DOMAIN CONTEXT BEGIN"));
});

test("routing: allow-list becomes provider.only; explicit pins must be in the list; privacy needs attestation", () => {
  const cfg = (patch: Partial<ReturnType<typeof makeConfig>["routing"]>) => makeConfig((c) => Object.assign(c.routing, patch));
  assert.deepEqual(resolveRouting(cfg({})), { pin: undefined, blockers: [] });
  assert.deepEqual(resolveRouting(cfg({}), "deepinfra"), { pin: { only: ["deepinfra"], allow_fallbacks: false }, blockers: [] });
  assert.deepEqual(resolveRouting(cfg({ allowedProviders: ["deepinfra", " groq ", "deepinfra"] })), { pin: { only: ["deepinfra", "groq"], allow_fallbacks: true }, blockers: [] });
  assert.deepEqual(resolveRouting(cfg({ allowedProviders: ["deepinfra"], allowFallbacks: false })).pin, { only: ["deepinfra"], allow_fallbacks: false });
  assert.deepEqual(resolveRouting(cfg({ allowedProviders: ["deepinfra", "groq"] }), "groq").blockers, []);
  assert.match(resolveRouting(cfg({ allowedProviders: ["deepinfra"] }), "together").blockers.join(), /not in routing.allowedProviders/);
  assert.match(resolveRouting(cfg({ requireZdr: true })).blockers.join(), /zero data retention cannot be requested on a batch/);
  assert.deepEqual(resolveRouting(cfg({ requireZdr: true, accountZdrEnforced: true })).blockers, []);
  assert.match(resolveRouting(cfg({ requireNoDataCollection: true })).blockers.join(), /data-collection preferences cannot be sent/);
  assert.deepEqual(resolveRouting(cfg({ requireNoDataCollection: true, accountDataCollectionDenied: true })).blockers, []);
  assert.equal(formatPin(undefined), "none");
  assert.equal(formatPin({ only: ["a", "b"], allow_fallbacks: true }), "a,b (fallbacks within the list)");
  assert.equal(formatPin({ only: ["a"], allow_fallbacks: false }), "a (no fallbacks)");
});

test("routing config validates; bad values fall back to defaults", () => {
  const ok = validateConfig({ routing: { allowedProviders: ["deepinfra", "groq"], allowFallbacks: false, requireZdr: true, accountZdrEnforced: true } });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.config.routing.allowedProviders, ["deepinfra", "groq"]);
  assert.equal(ok.config.routing.requireNoDataCollection, false);
  const bad = validateConfig({ routing: { allowedProviders: ["bad slug!"], requireZdr: "yes", zdr: true } });
  assert.deepEqual(bad.config.routing.allowedProviders, []);
  assert.equal(bad.config.routing.requireZdr, false);
  assert.match(bad.errors.join("\n"), /routing.allowedProviders/);
  assert.match(bad.errors.join("\n"), /unknown config key "routing.zdr"/);
});

test("metadata plan applies the routing policy and the submitted body passes batch provider rules", async () => {
  const root = metadataWorkspace();
  const fake = new FakeOpenRouter();
  try {
    const service = makeService(root, fake, makeConfig((c) => Object.assign(c.routing, { allowedProviders: ["deepinfra", "groq"], requireZdr: true, accountZdrEnforced: true })));
    const p = await service.planMetadata({ context: "metadata/beverage/context.md", input: "metadata/beverage/tables.jsonl" });
    assert.deepEqual(p.blockers, []);
    assert.deepEqual(p.pin, { only: ["deepinfra", "groq"], allow_fallbacks: true });
    fake.submitReplies = [accepted("batch_route")];
    const job = await service.createMetadataJob(p, { previewOnly: false });
    assert.equal(job.localStatus, "submitted");
    const submitted = JSON.parse(fake.requests.find((r) => r.method === "POST")!.body!) as Record<string, unknown>;
    assert.deepEqual(submitted.provider, { only: ["deepinfra", "groq"], allow_fallbacks: true });
    assert.deepEqual(Object.keys(submitted), ["endpoint", "model", "provider", "completion_window", "requests"]);

    const blocked = makeService(root, fake, makeConfig((c) => Object.assign(c.routing, { requireZdr: true })));
    const b = await blocked.planMetadata({ context: "metadata/beverage/context.md", input: "metadata/beverage/tables.jsonl" });
    assert.match(b.blockers.join("\n"), /requireZdr/);
  } finally {
    rm(root);
  }
});

test("review shows layer, object type and per-column tier for v2 evidence only", () => {
  const v2 = parseTables(fixture("tables.v2.valid.jsonl")).records[2]!.evidence;
  const v1 = TABLES[0] as unknown as TableEvidence;
  const proposal = (t: TableEvidence) => ({
    table: t.table,
    table_description: { comment: "A description.", confidence: "medium" as const, reason: "test" },
    columns: t.columns.map((c) => ({ name: c.name, comment: "A comment.", confidence: "medium" as const, reason: "test" })),
  });
  const outcome = (t: TableEvidence): MetadataOutcome => ({
    job: { localId: "B-20261021-TEST", localStatus: "completed", model: "test/model" } as unknown as JobManifest,
    contextPath: "context.md",
    contextSha256: "0".repeat(64),
    inputPath: "tables.jsonl",
    inputSha256: "0".repeat(64),
    tables: [{ ordinal: 1, table: t.table, evidence: t, status: "completed", proposal: proposal(t), proposalSha256: "1".repeat(64), resultJobId: "B-20261021-TEST", resultCustomId: "x" }],
    retryJobIds: [],
  });
  const md2 = metadataReviewMarkdown(outcome(v2));
  assert.match(md2, /\*\*Layer:\*\* gold · \*\*Object:\*\* VIEW/);
  assert.match(md2, /\| Column \| Type \| Tier \| Existing \| Proposed \| Confidence \|/);
  const md1 = metadataReviewMarkdown(outcome(v1));
  assert.doesNotMatch(md1, /\*\*Layer:\*\*|\| Tier \|/);
  assert.match(md1, /\| Column \| Type \| Existing \| Proposed \| Confidence \|/);
});
