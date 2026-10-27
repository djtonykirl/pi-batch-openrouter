import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import type { TableEvidence } from "../src/metadata/contract.js";
import { writeApprovedDraft } from "../src/metadata/outputs.js";
import { hasUcPrefix, tableTagProblems } from "../src/metadata/standards.js";
import { artifactsFor } from "./fixtures/artifacts.js";
import { approvedDraftRows, metadataOutcome, metadataReviewMarkdown, metadataSummary, toApprovedJsonl, validateApprovedText } from "../src/metadata/report.js";
import type { BatchService } from "../src/service.js";
import { FakeOpenRouter, accepted, makeConfig, makeService } from "./fixtures/fake-openrouter.js";
import { TABLES, metadataWorkspace, proposalFor } from "./fixtures/metadata.js";
import { completed, failedItem, successItem } from "./fixtures/openrouter.js";
import { rm } from "./helpers.js";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const JOB_ID = /B-\d{8}-[0-9A-Z]{4,8}/g;

async function withWorkspace(fn: (root: string, service: BatchService, fake: FakeOpenRouter) => Promise<void>, files: Record<string, string> = {}, cfg = makeConfig()): Promise<void> {
  const root = metadataWorkspace(files);
  const fake = new FakeOpenRouter();
  try {
    await fn(root, makeService(root, fake, cfg), fake);
  } finally {
    rm(root);
  }
}

// ------------------------------------------------------------------ v1 byte identity

/** Every v1 output for one finished job, with job IDs and the workspace root normalised. */
async function v1Outputs(root: string, service: BatchService, fake: FakeOpenRouter, partial: boolean): Promise<Record<string, string>> {
  fake.submitReplies = [accepted("batch_v1")];
  const job = await service.createMetadataJob(await service.planMetadata({ context: "metadata/beverage/context.md", input: "metadata/beverage/tables.jsonl" }), { previewOnly: false });
  const results = job.customIds.map((c, i) => (partial && i === 1 ? failedItem(c) : successItem(c, JSON.stringify(proposalFor(TABLES[i]!.table)))));
  fake.getReplies = [{ status: 200, body: completed(results, { id: "batch_v1" }) }];
  await service.reconcile(job.localId, { force: true });
  const o = metadataOutcome(service, job.localId);
  const draft = toApprovedJsonl(approvedDraftRows(o));
  const rows = () => draft.trim().split("\n").map((l) => JSON.parse(l) as Record<string, any>);
  const mutated = (m: (r: Array<Record<string, any>>) => void) => {
    const r = rows();
    m(r);
    return r.map((x) => JSON.stringify(x)).join("\n");
  };
  const validations = {
    draft: validateApprovedText(draft, service),
    edited: validateApprovedText(mutated((r) => (r[1]!.columns[2].approved_comment = "Lifecycle status.")), service),
    extraKey: validateApprovedText(mutated((r) => (r[0]!.approved_tags = {})), service),
    missingCol: validateApprovedText(mutated((r) => r[1]!.columns.pop()), service),
    alteredExisting: validateApprovedText(mutated((r) => (r[1]!.columns[1].existing_comment = "changed")), service),
    empty: validateApprovedText("", service),
  };
  const norm = (s: string) => s.split(root).join("<ROOT>").replace(JOB_ID, "<JOB>");
  return {
    summary: norm(metadataSummary(o)),
    review: norm(metadataReviewMarkdown(o)),
    draft: norm(draft),
    validate: norm(JSON.stringify(validations)),
  };
}

/** sha256 of each normalised output, captured from HEAD 9949ec7 (before tags in the handoff). */
const V1_BASELINE: Record<"full" | "partial", Record<string, string>> = {
  full: {
    summary: "61de33d0c0f855d21093717454a6769e092c13dfb3f262150be715cc5d188a5a",
    review: "dad0411f2d3f7d9d5b9b346f5a62527d1c33082e27c551091181e7b4cf9b5d86",
    draft: "8d098824d5e38870dd9eeaf41c59870782adbc3796e8ed388def354c48043b6a",
    validate: "08e0b5cc0abdeb6dc9288d86e5df6f9272d0abb089f1f1b8bffc815ee385f24e",
  },
  partial: {
    summary: "e779262aefee8ccc62b25d2cd9d634291d10f51838e8e5da7d7cffb50036067a",
    review: "96dc349d797557f88bcddd4a10876c155ae391fc82659a782d4318ec926a245e",
    draft: "21546294cc2b0d6be17dd62c2cada67ffe4d2aad042c028e8af4db49f516301f",
    validate: "1be0cbd3f290853be9ff9d7b5be69fa9e42b5da9fa46603903a20cfdcf7005e9",
  },
};

test("v1 job: summary, review, approved draft and validate-approved are byte-identical to before", async () => {
  const actual: Record<string, Record<string, string>> = {};
  for (const partial of [false, true]) {
    await withWorkspace(async (root, service, fake) => {
      const out = await v1Outputs(root, service, fake, partial);
      actual[partial ? "partial" : "full"] = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, sha(v)]));
      if (process.env.PRINT_V1_BASELINE) console.log(JSON.stringify({ partial, out }, null, 2));
    });
  }
  if (process.env.PRINT_V1_BASELINE) console.log(JSON.stringify(actual, null, 2));
  assert.deepEqual(actual, V1_BASELINE);
});

// ------------------------------------------------------------------ standards mode

const STANDARDS = { domain: "pinpoint", ucPrefix: "PNPT_" };
const DESCRIPTION_33 =
  "GRAIN: One row per active PepsiCo manufacturing or bottling facility (pk_loc_id).\nPURPOSE: Master R&D facility location dimension combining organizational hierarchy, bottler legal entity ownership, R&D category, and physical coordinates for Pinpoint quality reporting.\nSOURCE: Teradata PQP_P and MDM_P tables via pl_Pinpoint (PinpointBronzeToSilver.py and PinpointSilverToGold.py).\nREFRESH: Daily at 13:00 UTC.\nOWNER: RND Data OPS Team (FQSA).\nCLASSIFICATION: Internal.";
const COMMENT_33 =
  "Unique Core Data View (CDV) identifier for the manufacturing or bottling location.\nTYPE: Key.\nVALUES: Positive integer facility identifier (or '-1' in reporting views for the default unmapped row).\nSYNONYMS: LOC_ID, LocationCDVID, Facility_ID, cdvid.\nJOIN: Joins to PNPT_plant_mpg_data.pk_loc_id, PNPT_location_data_history.LocationCDVID, and 3CXX_SP_list_dairy_plants.cdvid.\nNULL MEANS: Not nullable (enforced uniqueness check in PinpointBronzeToSilver).";
const ADDRESS_COMMENT = "First line of the facility street address.\nTYPE: Dimension.\nVALUES: Free text street address.\nSYNONYMS: address_line_1, street.\nNULL MEANS: Address not recorded.";
const PLANT_COMMENT = "Identifier of the bottling plant in the source system.\nTYPE: Key.\nVALUES: Six-digit plant code.\nSYNONYMS: plant_cd.\nNULL MEANS: Not nullable.";
const PII_ADDRESS = { pii_type: "address", sensitivity: "medium", requires_masking: "true" };

const LOCATION = "uc_dev_global_rnd_mdip_01.lighthouse_gold.PNPT_location_data";
const AUDIT_ONLY = "c.lighthouse_silver.pnpt_audit_only"; // lowercase, as UC information_schema exports it
const PLANT = "uc_dev.lighthouse_bronze.PNPT_plant";

const SP_TABLES: TableEvidence[] = [
  {
    table: LOCATION,
    existing_description: null,
    existing_tags: {},
    columns: [
      { name: "pk_loc_id", data_type: "STRING", nullable: false, existing_comment: "Location id", existing_tags: {} },
      { name: "Address1_ds", data_type: "STRING", nullable: true, existing_comment: null },
      { name: "fw_ingestdate", data_type: "TIMESTAMP", nullable: true, existing_comment: "Ingest date", existing_tags: { legacy: "yes" } },
    ],
  },
  {
    table: AUDIT_ONLY,
    existing_description: null,
    columns: [
      { name: "FW_INGESTDATE", data_type: "TIMESTAMP", nullable: true, existing_comment: "legacy" },
      { name: "pipeline_timestamp", data_type: "TIMESTAMP", nullable: true, existing_comment: null },
    ],
  },
  {
    table: PLANT,
    existing_description: "Plants.",
    existing_tags: { owner: "legacy" },
    columns: [
      { name: "plant_id", data_type: "STRING", nullable: false, existing_comment: PLANT_COMMENT, existing_tags: {} },
      { name: "plant_nm", data_type: "STRING", nullable: true, existing_comment: null, existing_tags: { note: "x" } },
    ],
  },
];

const spProposal = (table: string): Record<string, unknown> => {
  if (table === LOCATION)
    return {
      table,
      classification: "internal",
      table_description: { comment: DESCRIPTION_33, confidence: "high", reason: "Context." },
      columns: [
        { name: "pk_loc_id", comment: COMMENT_33, confidence: "high", reason: "DDL.", pii_tags: null },
        { name: "Address1_ds", comment: ADDRESS_COMMENT, confidence: "medium", reason: "Name.", pii_tags: PII_ADDRESS },
      ],
    };
  if (table === AUDIT_ONLY) return { table, classification: "internal", table_description: { comment: DESCRIPTION_33, confidence: "medium", reason: "Context." }, columns: [] };
  return {
    table,
    classification: "confidential",
    table_description: { comment: DESCRIPTION_33.replace("CLASSIFICATION: Internal.", "CLASSIFICATION: Confidential."), confidence: "medium", reason: "Context." },
    columns: [
      { name: "plant_id", comment: PLANT_COMMENT.replace("Six-digit", "6-digit"), confidence: "high", reason: "DDL.", pii_tags: null },
      { name: "plant_nm", comment: null, confidence: "insufficient", reason: "No evidence.", pii_tags: null },
    ],
  };
};

const spFiles = { "metadata/pinpoint/context.md": "# Pinpoint\n\nFacility master data.\n", "metadata/pinpoint/tables.jsonl": SP_TABLES.map((t) => JSON.stringify(t)).join("\n") + "\n" };

/** A finished standards job; `fail` lists table ordinals (0-based) whose item fails. */
async function standardsJob(service: BatchService, fake: FakeOpenRouter, fail: number[] = []) {
  const prepared = await service.planMetadata({ context: "metadata/pinpoint/context.md", input: "metadata/pinpoint/tables.jsonl", ...STANDARDS });
  assert.deepEqual(prepared.blockers, []); // includes the lowercase pnpt_audit_only table
  fake.submitReplies = [accepted("batch_sp")];
  const job = await service.createMetadataJob(prepared, { previewOnly: false });
  assert.equal(job.localStatus, "submitted", job.error?.message);
  const results = job.customIds.map((c, i) => (fail.includes(i) ? failedItem(c) : successItem(c, JSON.stringify(spProposal(SP_TABLES[i]!.table)))));
  fake.getReplies = [{ status: 200, body: completed(results, { id: "batch_sp" }) }];
  await service.reconcile(job.localId, { force: true });
  return metadataOutcome(service, job.localId);
}

type Row = Record<string, any>;
const parseRows = (jsonl: string): Row[] => jsonl.trim().split("\n").map((l) => JSON.parse(l) as Row);
const joinRows = (rows: Row[]) => rows.map((r) => JSON.stringify(r)).join("\n");
const col = (row: Row, name: string) => (row.columns as Row[]).find((c) => c.name === name)!;

test("standards draft: a legacy comment takes the proposal; validate-approved passes and counts replacedNonStandard", () =>
  withWorkspace(async (_root, service, fake) => {
    const o = await standardsJob(service, fake);
    const draft = toApprovedJsonl(approvedDraftRows(o));
    const rows = parseRows(draft);
    assert.equal(col(rows[0]!, "pk_loc_id").approved_comment, COMMENT_33);
    assert.equal(col(rows[2]!, "plant_id").approved_comment, PLANT_COMMENT); // a standard existing value is kept
    assert.equal(rows[2]!.approved_description, DESCRIPTION_33.replace("CLASSIFICATION: Internal.", "CLASSIFICATION: Confidential.")); // "Plants." is not standard
    const v = validateApprovedText(draft, service);
    assert.deepEqual(v.problems, []);
    assert.equal(v.counts.replacedNonStandard, 2);
    assert.deepEqual(v.nullValues, [`${PLANT} column "plant_nm"`]);
  }, spFiles));

test("standards validate: a reviewer reverting to the legacy comment gets a TYPE: problem", () =>
  withWorkspace(async (_root, service, fake) => {
    const rows = parseRows(toApprovedJsonl(approvedDraftRows(await standardsJob(service, fake))));
    col(rows[0]!, "pk_loc_id").approved_comment = "Location id";
    const v = validateApprovedText(joinRows(rows), service);
    assert.match(v.problems.join("\n"), /line 1: column "pk_loc_id" approved_comment: .*TYPE:/);
    assert.doesNotMatch(v.problems.join("\n"), /Location id/);
  }, spFiles));

test("standards draft tags: key order, sparse column PII, table pii derived from the columns", () =>
  withWorkspace(async (_root, service, fake) => {
    const rows = parseRows(toApprovedJsonl(approvedDraftRows(await standardsJob(service, fake))));
    for (const r of rows) {
      assert.deepEqual(Object.keys(r), ["table", "existing_description", "approved_description", "existing_tags", "approved_tags", "columns", "provenance"]);
      for (const c of r.columns as Row[]) assert.deepEqual(Object.keys(c), ["name", "existing_comment", "approved_comment", "existing_tags", "approved_tags"]);
    }
    // All non-PII.
    assert.equal(JSON.stringify(rows[2]!.approved_tags), JSON.stringify({ classification: "confidential", data_domain: "pinpoint", uc_prefix: "PNPT_", medallion_layer: "bronze", pii: "false" }));
    assert.deepEqual((rows[2]!.columns as Row[]).map((c) => c.approved_tags), [{}, {}]);
    assert.deepEqual(rows[2]!.existing_tags, { owner: "legacy" });
    assert.deepEqual(col(rows[2]!, "plant_nm").existing_tags, { note: "x" });
    // One PII column.
    assert.equal(JSON.stringify(col(rows[0]!, "Address1_ds").approved_tags), JSON.stringify({ pii: "true", pii_type: "address", sensitivity: "medium", requires_masking: "true" }));
    assert.deepEqual(col(rows[0]!, "Address1_ds").existing_tags, {});
    assert.deepEqual(col(rows[0]!, "pk_loc_id").approved_tags, {});
    assert.equal(rows[0]!.approved_tags.pii, "true");
    assert.equal(rows[0]!.approved_tags.medallion_layer, "gold");
  }, spFiles));

test("standards validate: hand-edited tags, public on a PII table, altered existing_tags and missing tag keys are rejected", () =>
  withWorkspace(async (_root, service, fake) => {
    const draft = toApprovedJsonl(approvedDraftRows(await standardsJob(service, fake)));
    const v = (m: (r: Row[]) => void) => {
      const r = parseRows(draft);
      m(r);
      return validateApprovedText(joinRows(r), service).problems.join("\n");
    };
    assert.match(v((r) => (col(r[2]!, "plant_id").approved_tags = { pii: "false" })), /line 3: column "plant_id" approved_tags: column tags pii "false" is never emitted/);
    assert.match(v((r) => delete r[0]!.approved_tags.uc_prefix), /line 1: approved_tags: table tags is missing the uc_prefix key/);
    assert.match(v((r) => (r[0]!.approved_tags.classification = "public")), /line 1: approved_tags: .*public/);
    assert.match(v((r) => (r[0]!.approved_tags.pii = "false")), /line 1: approved_tags: table tags pii must be "true"/);
    assert.match(v((r) => (r[2]!.existing_tags = {})), /line 3: existing_tags differs from the evidence/);
    assert.match(v((r) => (col(r[2]!, "plant_nm").existing_tags = {})), /line 3: existing_tags of "plant_nm" differs from the evidence/);
    assert.match(v((r) => delete r[0]!.approved_tags), /line 1: .*required property 'approved_tags'/);
    assert.match(v((r) => delete col(r[0]!, "pk_loc_id").existing_tags), /line 1: .*required property 'existing_tags'/);
    const pii = v((r) => (r[0]!.approved_description = "Facility locations, contact jane@example.com for access to this table."));
    assert.match(pii, /line 1: approved_description: .*GRAIN:/);
    assert.match(pii, /line 1: approved_description: .*email/);
    assert.doesNotMatch(pii, /jane@example\.com/);
    // Carried from Task 10: public together with pii "true" is a table tag problem in itself.
    assert.match(tableTagProblems({ classification: "public", data_domain: "pinpoint", uc_prefix: "PNPT_", medallion_layer: "gold", pii: "true" }, { ...STANDARDS, layer: "gold" }, true).join(), /public/);
    assert.deepEqual(tableTagProblems({ classification: "public", data_domain: "pinpoint", uc_prefix: "PNPT_", medallion_layer: "gold", pii: "false" }, { ...STANDARDS, layer: "gold" }, false), []);
  }, spFiles));

test("standards audit columns: they keep their existing values and tags and are not checked; an all-audit table passes", () =>
  withWorkspace(async (_root, service, fake) => {
    const draft = toApprovedJsonl(approvedDraftRows(await standardsJob(service, fake)));
    const rows = parseRows(draft);
    const audit = col(rows[0]!, "fw_ingestdate");
    assert.deepEqual([audit.approved_comment, audit.approved_tags], ["Ingest date", { legacy: "yes" }]);
    assert.deepEqual((rows[1]!.columns as Row[]).map((c) => [c.name, c.approved_comment, c.existing_tags, c.approved_tags]), [
      ["FW_INGESTDATE", "legacy", {}, {}],
      ["pipeline_timestamp", null, {}, {}],
    ]);
    assert.equal(rows[1]!.approved_description, DESCRIPTION_33);
    assert.equal(rows[1]!.approved_tags.pii, "false");
    assert.equal(rows[1]!.approved_tags.medallion_layer, "silver");
    assert.deepEqual(validateApprovedText(draft, service).problems, []);
    // A reviewer value on an audit column is not standards-checked either.
    audit.approved_comment = "short";
    assert.deepEqual(validateApprovedText(joinRows(rows), service).problems, []);
    // Lowercase UC names are in the prefix (information_schema exports lowercase).
    assert.ok(hasUcPrefix(AUDIT_ONLY, "PNPT_"));
  }, spFiles));

test("standards partial: --allow-partial keeps a table without a proposal at its existing values and tags", () =>
  withWorkspace(async (root, service, fake) => {
    const o = await standardsJob(service, fake, [2]);
    const art = artifactsFor(root, service);
    await assert.rejects(writeApprovedDraft(service, art, o.job.localId, { out: "metadata/pinpoint/approved.jsonl" }), /--allow-partial/);
    const res = await writeApprovedDraft(service, art, o.job.localId, { out: "metadata/pinpoint/approved.jsonl", allowPartial: true });
    assert.deepEqual(res.validation.problems, []);
    const rows = parseRows(fs.readFileSync(path.join(root, "metadata/pinpoint/approved.jsonl"), "utf8"));
    const plant = rows[2]!;
    assert.equal(plant.approved_description, "Plants.");
    assert.deepEqual(plant.approved_tags, { owner: "legacy" });
    assert.deepEqual((plant.columns as Row[]).map((c) => [c.approved_comment, c.approved_tags]), [[PLANT_COMMENT, {}], [null, { note: "x" }]]);
    // Changing a value of that table makes it subject to the standards again.
    plant.approved_description = "Plants of the bottling network.";
    assert.match(validateApprovedText(joinRows(rows), service).problems.join("\n"), /line 3: approved_description: .*GRAIN:/);
  }, spFiles));

test("standards review: tags line, PII column, audit rows and the non-standard replacement marker", () =>
  withWorkspace(async (_root, service, fake) => {
    const md = metadataReviewMarkdown(await standardsJob(service, fake));
    assert.match(md, /\*\*Tags:\*\* none → `classification=internal, data_domain=pinpoint, uc_prefix=PNPT_, medallion_layer=gold, pii=true`/);
    assert.match(md, /\*\*Tags:\*\* `owner=legacy` → `classification=confidential/);
    assert.match(md, /\| Column \| Type \| Existing \| Proposed \| Confidence \| PII \|/);
    assert.match(md, /\| pk_loc_id \| STRING \| Location id \| Unique Core .* _replaces a non-standard existing value_ \| high \| — \|/);
    assert.match(md, /\| Address1_ds \| STRING \| — \| First line .* \| medium \| address \(medium, masking true\) \|/);
    assert.match(md, /\| fw_ingestdate \| TIMESTAMP \| Ingest date \| — \| audit column \(not sent\) \| — \|/);
    assert.match(md, /CLASSIFICATION: Confidential\.\n\n_replaces a non-standard existing value_/);
  }, spFiles));
