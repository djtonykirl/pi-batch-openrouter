import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson, sha256Hex } from "../src/fsutil.js";
import { PROPOSAL_SCHEMA_V2, promptEvidence, proposalProblems, type TableEvidence } from "../src/metadata/contract.js";
import { portableSchema, renderMetadataPrompt } from "../src/metadata/plan.js";
import {
  columnCommentProblems,
  columnTagProblems,
  columnTagsFromProposal,
  deriveTableTags,
  descriptionProblems,
  isAuditColumn,
  medallionLayer,
  piiTextProblems,
  tableTagProblems,
} from "../src/metadata/standards.js";
import { formatMetadataPreview } from "../src/metadata-commands.js";
import type { BatchService } from "../src/service.js";
import { FakeOpenRouter, accepted, makeConfig, makeService } from "./fixtures/fake-openrouter.js";
import { metadataWorkspace } from "./fixtures/metadata.js";
import { completed, successItem } from "./fixtures/openrouter.js";
import { rm } from "./helpers.js";

/**
 * Standards mode (opt-in UC metadata standards) for `databricks-metadata`.
 * The §3.3 strings come verbatim from TDD_UC_Metadata_Enrichment.md v1.1.
 */

const STANDARDS = { domain: "pinpoint", ucPrefix: "PNPT_" };
const PNPT = "uc_dev_global_rnd_mdip_01.lighthouse_gold.PNPT_location_data";

const DESCRIPTION_33 =
  "GRAIN: One row per active PepsiCo manufacturing or bottling facility (pk_loc_id).\nPURPOSE: Master R&D facility location dimension combining organizational hierarchy, bottler legal entity ownership, R&D category, and physical coordinates for Pinpoint quality reporting.\nSOURCE: Teradata PQP_P and MDM_P tables via pl_Pinpoint (PinpointBronzeToSilver.py and PinpointSilverToGold.py).\nREFRESH: Daily at 13:00 UTC.\nOWNER: RND Data OPS Team (FQSA).\nCLASSIFICATION: Internal.";
const COMMENT_33 =
  "Unique Core Data View (CDV) identifier for the manufacturing or bottling location.\nTYPE: Key.\nVALUES: Positive integer facility identifier (or '-1' in reporting views for the default unmapped row).\nSYNONYMS: LOC_ID, LocationCDVID, Facility_ID, cdvid.\nJOIN: Joins to PNPT_plant_mpg_data.pk_loc_id, PNPT_location_data_history.LocationCDVID, and 3CXX_SP_list_dairy_plants.cdvid.\nNULL MEANS: Not nullable (enforced uniqueness check in PinpointBronzeToSilver).";
const ADDRESS_COMMENT = "First line of the facility street address.\nTYPE: Dimension.\nVALUES: Free text street address.\nSYNONYMS: address_line_1, street.\nNULL MEANS: Address not recorded.";
const APPROVED_TAGS_33 = { classification: "internal", data_domain: "pinpoint", uc_prefix: "PNPT_", medallion_layer: "gold", pii: "false" };

const evidence = (table = PNPT): TableEvidence => ({
  table,
  existing_description: null,
  existing_tags: {},
  columns: [
    { name: "pk_loc_id", data_type: "STRING", nullable: false, existing_comment: null, existing_tags: {}, sample_values: ["100452", "100819"] },
    { name: "Address1_ds", data_type: "STRING", nullable: true, existing_comment: null, existing_tags: {}, sample_values: ["[REDACTED_ADDRESS_1]", "[REDACTED_ADDRESS_2]"] },
    { name: "fw_ingestdate", data_type: "TIMESTAMP", nullable: true, existing_comment: null },
    { name: "FW_PIPELINEROWCHECKSUM", data_type: "STRING", nullable: true, existing_comment: null },
  ],
});

type Proposal = {
  table: string;
  classification: string;
  table_description: { comment: string | null; confidence: string; reason: string };
  columns: Array<{ name: string; comment: string | null; confidence: string; reason: string; pii_tags: null | Record<string, string> }>;
};
const proposal = (): Proposal => ({
  table: PNPT,
  classification: "internal",
  table_description: { comment: DESCRIPTION_33, confidence: "high", reason: "Pinpoint context and DDL." },
  columns: [
    { name: "pk_loc_id", comment: COMMENT_33, confidence: "high", reason: "DDL and parity rules.", pii_tags: null },
    { name: "Address1_ds", comment: ADDRESS_COMMENT, confidence: "medium", reason: "Column name and redacted samples.", pii_tags: null },
  ],
});

// ------------------------------------------------------------------ v1 unchanged

/**
 * Captured from HEAD b9e1f96 (before standards mode) with the existing beverage
 * fixtures and the default test config, through BatchService.planMetadata.
 */
const V1_BASELINE = {
  planSha256: "0a839136f9938f697bd56d897e75b33cb4c1c75613f8233d12673f5fe151db97",
  contentSha256: "88be1041b5d30cb6d301a705d9f36072044ca7da731de280f5a7c978a57d63d3",
  requests: [
    "9bd88288620189bc23104df122c692fd979f1d59432870fba499a46a8b39cad1",
    "823d227d0588024a6fdd13da8e9c2d028804a4255c48e54130312ee085bc65f1",
    "a0bbde9746b9d048de0c0fc820c9b7be3cd84de664ff6a44bd71dcdfe1de9ac1",
  ],
  bodies: "cf8144d1fcaaf7b372bfd659d0e463e715d17ef9d415c43c288f8ddc2ffdc57a",
  inputs: [
    "1fcdbd3050cd340c72ced3a686f9ba5d4136e1154cb92385940486434dad106e",
    "d6d52dce32b07ad29329e2398a90b25300cb17cdf43184f724403a9d54362df4",
    "34baed037fc7dd71aaecd235ea5a38348294c822cb7294388bdf5652dd794fca",
  ],
};

async function withWorkspace(fn: (root: string, service: BatchService, fake: FakeOpenRouter) => Promise<void>, files: Record<string, string> = {}, cfg = makeConfig()): Promise<void> {
  const root = metadataWorkspace(files);
  const fake = new FakeOpenRouter();
  try {
    await fn(root, makeService(root, fake, cfg), fake);
  } finally {
    rm(root);
  }
}

test("v1 unchanged: without standards, request bodies, plan and content hashes are byte-identical to before", () =>
  withWorkspace(async (_root, service) => {
    const p = await service.planMetadata({ context: "metadata/beverage/context.md", input: "metadata/beverage/tables.jsonl" });
    assert.deepEqual(p.blockers, []);
    const plan = p.plan!;
    assert.deepEqual(
      { planSha256: plan.planSha256, contentSha256: p.contentSha256, requests: plan.items.map((i) => i.requestSha256), bodies: sha256Hex(canonicalJson(plan.items.map((i) => i.body))), inputs: plan.items.map((i) => i.inputSha256) },
      V1_BASELINE,
    );
    const job = await service.createMetadataJob(p, { previewOnly: true });
    assert.equal((job.workflow as { version: number }).version, 1);
    assert.equal("standards" in job.workflow!, false);
    assert.equal("standards" in service.metadataEvidence(job.localId), false);
    assert.match(formatMetadataPreview(p, true), /Standards:\s+off/);
  }));

// ------------------------------------------------------------------ options and blocking

const tablesFile = (...evs: TableEvidence[]) => evs.map((e) => JSON.stringify(e)).join("\n") + "\n";
const files = (...evs: TableEvidence[]) => ({ "metadata/pinpoint/context.md": "# Pinpoint\n\nFacility master data.\n", "metadata/pinpoint/tables.jsonl": tablesFile(...evs) });
const planPinpoint = (service: BatchService, extra: Record<string, string | undefined> = STANDARDS) =>
  service.planMetadata({ context: "metadata/pinpoint/context.md", input: "metadata/pinpoint/tables.jsonl", ...extra });

test("bad options: domain without ucPrefix (or the reverse, or bad formats) is an error mentioning both", () =>
  withWorkspace(async (_root, service) => {
    for (const opts of [{ domain: "pinpoint" }, { ucPrefix: "PNPT_" }]) {
      const p = await planPinpoint(service, opts);
      assert.match(p.blockers.join("\n"), /--domain[\s\S]*--uc-prefix|domain[\s\S]*ucPrefix/);
      assert.equal(p.plan, undefined);
    }
    assert.match((await planPinpoint(service, { domain: "Pinpoint", ucPrefix: "PNPT_" })).blockers.join("\n"), /domain/);
    assert.match((await planPinpoint(service, { domain: "pinpoint", ucPrefix: "pnpt" })).blockers.join("\n"), /uc-prefix|ucPrefix/);
  }, files(evidence())));

test("prefix and layer blocking: tables outside the prefix or without a medallion layer block the plan and are listed", async () => {
  await withWorkspace(async (_root, service) => {
    const ok = await planPinpoint(service);
    assert.deepEqual(ok.blockers, []);
    assert.deepEqual(ok.plan!.standards, STANDARDS);
  }, files(evidence()));
  await withWorkspace(async (_root, service) => {
    const p = await planPinpoint(service);
    const msg = p.blockers.join("\n");
    assert.match(msg, /uc_dev\.lighthouse_gold\.STRL_x/);
    assert.match(msg, /uc_dev\.misc\.PNPT_y/);
    assert.match(msg, /PNPT_/);
    assert.match(msg, /medallion/);
    assert.doesNotMatch(msg, /PNPT_location_data/);
  }, files(evidence("uc_dev.lighthouse_gold.PNPT_location_data"), evidence("uc_dev.lighthouse_gold.STRL_x"), evidence("uc_dev.misc.PNPT_y")));
  assert.equal(medallionLayer("uc_dev.lighthouse_bronze.PNPT_a"), "bronze");
  assert.equal(medallionLayer("c.LIGHTHOUSE_SILVER.x"), "silver");
  assert.equal(medallionLayer("c.misc.gold_x"), null);
});

test("notebooks: a .ipynb given as --context or --input blocks the plan (use the reviewed Pass 1 context)", () =>
  withWorkspace(async (_root, service) => {
    const nb = await service.planMetadata({ context: "metadata/pinpoint/Pinpoint.ipynb", input: "metadata/pinpoint/tables.jsonl" });
    assert.match(nb.blockers.join("\n"), /metadata\/pinpoint\/Pinpoint\.ipynb is a notebook; use the reviewed <Domain>_context\.md \(Pass 1 output\), not a notebook/);
    assert.equal(nb.plan, undefined);
    const inp = await service.planMetadata({ context: "metadata/pinpoint/context.md", input: "metadata/pinpoint/Pinpoint.ipynb" });
    assert.match(inp.blockers.join("\n"), /Pinpoint\.ipynb is a notebook/);
  }, { ...files(evidence()), "metadata/pinpoint/Pinpoint.ipynb": JSON.stringify({ cells: [{ cell_type: "code", source: ["x = 1"], outputs: [{ text: "secret output" }] }] }) }));

// ------------------------------------------------------------------ audit columns

test("audit columns: never in the prompt; a proposal omitting them is valid and one including them is invented", () => {
  assert.ok(isAuditColumn("fw_ingestdate") && isAuditColumn("FW_PIPELINEROWCHECKSUM") && isAuditColumn("Pipeline_Timestamp"));
  assert.ok(!isAuditColumn("pk_loc_id"));
  const ev = evidence();
  const prompt = renderMetadataPrompt("# Pinpoint", ev, STANDARDS);
  assert.doesNotMatch(prompt, /fw_ingestdate|FW_PIPELINEROWCHECKSUM/i);
  assert.match(prompt, /pk_loc_id/);
  assert.match(prompt, /"pii_tags"/);
  assert.match(prompt, /GRAIN:/);
  const reduced = promptEvidence(ev, STANDARDS);
  assert.deepEqual(reduced.columns.map((c) => c.name), ["pk_loc_id", "Address1_ds"]);
  assert.deepEqual(promptEvidence(ev), ev);
  assert.deepEqual(proposalProblems(proposal(), reduced, STANDARDS), []);
  const p = proposal();
  p.columns.push({ name: "fw_ingestdate", comment: null, confidence: "insufficient", reason: "Framework column.", pii_tags: null });
  assert.match(proposalProblems(p, reduced, STANDARDS).join("\n"), /"fw_ingestdate" is not a column of the table \(invented column\)/);
});

test("audit columns: the preview counts them as not sent", () =>
  withWorkspace(async (_root, service) => {
    const p = await planPinpoint(service);
    assert.equal(p.plan!.auditColumns, 2);
    const text = formatMetadataPreview(p, true);
    assert.match(text, /Standards:\s+pinpoint \/ PNPT_/);
    assert.match(text, /Audit columns:\s+2 not sent/);
    assert.doesNotMatch(p.plan!.items[0]!.prompt, /fw_ingestdate/i);
  }, files(evidence())));

// ------------------------------------------------------------------ corrupt and valid proposals

test("corrupt proposals: PII under public, unknown pii_type, bad headers, classification mismatch, missing NULL MEANS, PII text", () => {
  const reduced = promptEvidence(evidence(), STANDARDS);
  const check = (mutate: (p: Proposal) => void) => {
    const p = proposal();
    mutate(p);
    return proposalProblems(p, reduced, STANDARDS).join("\n");
  };
  const pii = { pii_type: "address", sensitivity: "medium", requires_masking: "true" };
  assert.match(
    check((p) => {
      p.classification = "public";
      p.table_description.comment = DESCRIPTION_33.replace("CLASSIFICATION: Internal.", "CLASSIFICATION: Public.");
      p.columns[1]!.pii_tags = pii;
    }),
    /public/,
  );
  assert.equal(check((p) => (p.columns[1]!.pii_tags = pii)), "");
  assert.match(check((p) => (p.columns[1]!.pii_tags = { ...pii, pii_type: "postcode" })), /pii_type must be equal to one of the allowed values/);
  assert.match(check((p) => (p.columns[1]!.pii_tags = { pii: "false", ...pii })), /must NOT have additional properties/);
  assert.match(check((p) => (p.table_description.comment = DESCRIPTION_33.replace("OWNER: RND Data OPS Team (FQSA).\n", ""))), /OWNER:/);
  assert.match(check((p) => (p.table_description.comment = DESCRIPTION_33.replace("CLASSIFICATION: Internal.", "CLASSIFICATION: Restricted."))), /CLASSIFICATION/);
  assert.match(check((p) => (p.columns[0]!.comment = COMMENT_33.replace(/\nNULL MEANS:.*$/, ""))), /NULL MEANS:/);
  const withEmail = check((p) => (p.columns[1]!.comment = ADDRESS_COMMENT.replace("Address not recorded.", "Address not recorded; ask jane@example.com.")));
  assert.match(withEmail, /email/);
  assert.doesNotMatch(withEmail, /jane@example\.com/);
  assert.match(check((p) => delete (p as Partial<Proposal>).classification), /required property 'classification'/);
  assert.match(check((p) => (p.classification = "secret")), /classification must be equal to one of the allowed values/);
  assert.match(check((p) => delete (p.columns[0] as Partial<Proposal["columns"][0]>).pii_tags), /required property 'pii_tags'/);
  // Without standards the v1 contract applies: the v2 fields are unknown.
  assert.match(proposalProblems(proposal(), reduced).join("\n"), /additional properties/);
});

test("valid proposal: the TDD §3.3 description and pk_loc_id comment pass every check", () => {
  assert.deepEqual(descriptionProblems(DESCRIPTION_33, "internal"), []);
  assert.deepEqual(columnCommentProblems(COMMENT_33), []);
  assert.deepEqual(piiTextProblems(DESCRIPTION_33), []);
  assert.deepEqual(piiTextProblems(COMMENT_33), []);
  const p = proposal();
  p.columns = [p.columns[0]!];
  const ev = evidence();
  ev.columns = [ev.columns[0]!];
  assert.deepEqual(proposalProblems(p, promptEvidence(ev, STANDARDS), STANDARDS), []);
  // A null (insufficient) comment is not format-checked.
  p.columns[0]!.comment = null;
  p.columns[0]!.confidence = "insufficient";
  assert.deepEqual(proposalProblems(p, promptEvidence(ev, STANDARDS), STANDARDS), []);
});

test("format checks: order, length, column TYPE values and PII-looking text", () => {
  assert.match(descriptionProblems("GRAIN: x").join("\n"), /30 characters/);
  const swapped = DESCRIPTION_33.replace(/^GRAIN:(.*)\nPURPOSE:(.*)$/m, "PURPOSE:$2\nGRAIN:$1");
  assert.match(descriptionProblems(swapped, "internal").join("\n"), /order/);
  assert.deepEqual(descriptionProblems(DESCRIPTION_33.replace("CLASSIFICATION: Internal.", "CLASSIFICATION: PII scan required."), "pii_scan_required"), []);
  assert.match(columnCommentProblems(COMMENT_33.replace("TYPE: Key.", "TYPE: Identifier.")).join("\n"), /TYPE:/);
  assert.match(columnCommentProblems("TYPE: Key.\nVALUES: x.\nSYNONYMS: y.\nNULL MEANS: none.").join("\n"), /definition/);
  assert.deepEqual(columnCommentProblems(COMMENT_33.replace("JOIN:", "UNIT: Count.\nFORMULA: a - b.\nJOIN:")), []);
  assert.match(piiTextProblems("Call 555-123-4567 for help").join(), /phone/);
  assert.match(piiTextProblems("SSN 123-45-6789 here").join(), /SSN/);
  assert.deepEqual(piiTextProblems("Daily at 13:00 UTC; ids 100452 and 2024-01-15."), []);
});

// ------------------------------------------------------------------ tags

test("deriveTableTags: equals the §3.3 table approved_tags, key order included", () => {
  const tags = deriveTableTags("internal", STANDARDS, "gold", false);
  assert.deepEqual(tags, APPROVED_TAGS_33);
  assert.equal(JSON.stringify(tags), JSON.stringify(APPROVED_TAGS_33));
  assert.equal(deriveTableTags("restricted", STANDARDS, "bronze", true).pii, "true");
  assert.deepEqual(tableTagProblems(APPROVED_TAGS_33, { ...STANDARDS, layer: "gold" }, false), []);
  assert.match(tableTagProblems(APPROVED_TAGS_33, { ...STANDARDS, layer: "gold" }, true).join(), /pii/);
  assert.match(tableTagProblems({ ...APPROVED_TAGS_33, owner: "x" }, { ...STANDARDS, layer: "gold" }, false).join(), /owner/);
  assert.match(tableTagProblems({ ...APPROVED_TAGS_33, medallion_layer: "silver" }, { ...STANDARDS, layer: "gold" }, false).join(), /medallion_layer/);
  const { pii: _omit, ...missing } = APPROVED_TAGS_33;
  assert.match(tableTagProblems(missing, { ...STANDARDS, layer: "gold" }, false).join(), /pii/);
});

test("column tags: sparse PII only, key order, pii false never emitted", () => {
  assert.deepEqual(columnTagsFromProposal(null), {});
  const t = columnTagsFromProposal({ requires_masking: "true", sensitivity: "high", pii_type: "email" });
  assert.equal(JSON.stringify(t), JSON.stringify({ pii: "true", pii_type: "email", sensitivity: "high", requires_masking: "true" }));
  assert.deepEqual(columnTagProblems({}), []);
  assert.deepEqual(columnTagProblems(t), []);
  assert.match(columnTagProblems({ pii: "false" }).join(), /pii/);
  assert.match(columnTagProblems({ ...t, pii_type: "postcode" }).join(), /pii_type/);
  assert.match(columnTagProblems({ pii: "true", pii_type: "email" }).join(), /sensitivity/);
});

// ------------------------------------------------------------------ R7 and lifecycle

test("R7: the preview warns about sample values at privacy level standard, not at zdr", async () => {
  const warning = /sample values will be sent at privacy level standard; consider \/batch privacy zdr/;
  await withWorkspace(async (_root, service) => {
    assert.match(formatMetadataPreview(await planPinpoint(service), true), warning);
  }, files(evidence()));
  await withWorkspace(
    async (_root, service) => {
      assert.doesNotMatch(formatMetadataPreview(await planPinpoint(service), true), warning);
    },
    files(evidence()),
    makeConfig((c) => (c.privacy.level = "zdr")),
  );
});

test("lifecycle: a standards job records v2 + standards; PII under a public classification is corrupt and can be retried", () =>
  withWorkspace(async (_root, service, fake) => {
    const prepared = await planPinpoint(service);
    assert.deepEqual(prepared.blockers, []);
    const preview = await service.createMetadataJob(prepared, { previewOnly: true });
    assert.deepEqual([(preview.workflow as { version: number }).version, (preview.workflow as { standards?: unknown }).standards], [2, STANDARDS]);
    assert.deepEqual(service.metadataEvidence(preview.localId).standards, STANDARDS);
    // Stored evidence is the full table (audit columns included); the request is the reduced one.
    assert.equal(service.metadataEvidence(preview.localId).tables[0]!.evidence.columns.length, 4);
    fake.submitReplies = [accepted()];
    const job = await service.submit(preview.localId);
    const bad = proposal();
    bad.classification = "public";
    bad.table_description.comment = DESCRIPTION_33.replace("CLASSIFICATION: Internal.", "CLASSIFICATION: Public.");
    bad.columns[1]!.pii_tags = { pii_type: "address", sensitivity: "medium", requires_masking: "true" };
    fake.getReplies = [{ status: 200, body: completed([successItem(job.customIds[0]!, JSON.stringify(bad))]) }];
    await service.reconcile(job.localId, { force: true });
    const done = service.registry.read(job.localId);
    assert.equal(done.items![0]!.status, "corrupt");
    assert.match(done.items![0]!.error!.message, /public/);
    assert.equal(done.items![0]!.error!.code, "schema_invalid");
    fake.submitReplies = [accepted("batch_456")];
    const retry = await service.retryItems(done.localId, { failed: true });
    assert.equal(retry.localStatus, "submitted");
    fake.getReplies = [{ status: 200, body: completed([successItem(retry.customIds[0]!, JSON.stringify(proposal()))], { id: "batch_456" }) }];
    await service.reconcile(retry.localId, { force: true });
    assert.equal(service.registry.read(retry.localId).items![0]!.status, "completed");
  }, files(evidence())));

// ------------------------------------------------------------------ prompt placement rule and structured output

test("standards prompt says where pii_tags and classification go; v1 prompt does not", () => {
  const std = renderMetadataPrompt("ctx", evidence(), STANDARDS);
  assert.match(std, /"pii_tags" belongs only on each entry of "columns"; never put it in "table_description"/);
  assert.match(std, /"classification" is a top-level field/);
  const v1 = renderMetadataPrompt("ctx", evidence());
  assert.doesNotMatch(v1, /pii_tags/);
  assert.doesNotMatch(v1, /classification/);
});

test("standards-mode request bodies carry the proposal schema as response_format; the flag turns it off", async () => {
  await withWorkspace(async (_root, service) => {
    const p = await planPinpoint(service);
    assert.deepEqual(p.blockers, []);
    for (const it of p.plan!.items) {
      assert.deepEqual(it.body.response_format, { type: "json_schema", json_schema: { name: "uc_metadata_proposal", strict: true, schema: portableSchema(PROPOSAL_SCHEMA_V2) } });
    }
  }, files(evidence()));
  const off = makeConfig((c) => {
    c.workflows.metadataStructuredOutput = false;
  });
  await withWorkspace(async (_root, service) => {
    const p = await planPinpoint(service);
    for (const it of p.plan!.items) assert.equal("response_format" in it.body, false);
  }, files(evidence()), off);
  // v1 never carries it (the byte-identical baseline above covers its hashes).
  await withWorkspace(async (_root, service) => {
    const p = await service.planMetadata({ context: "metadata/beverage/context.md", input: "metadata/beverage/tables.jsonl" });
    for (const it of p.plan!.items) assert.equal("response_format" in it.body, false);
  });
});

test("the response_format schema is portable: no length keywords, every enum typed; local validation keeps the full schema", () => {
  const portable = portableSchema(PROPOSAL_SCHEMA_V2);
  const text = JSON.stringify(portable);
  for (const k of ["minLength", "maxLength", "minItems", "maxItems"]) assert.equal(text.includes(`"${k}"`), false, k);
  const enums: Array<Record<string, unknown>> = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.enum)) enums.push(o);
    Object.values(o).forEach(walk);
  };
  walk(portable);
  assert.ok(enums.length >= 5);
  for (const e of enums) assert.equal(e.type, "string", JSON.stringify(e));
  // Same structure otherwise (required fields, additionalProperties), and the original is untouched.
  assert.deepEqual((portable as { required: string[] }).required, [...PROPOSAL_SCHEMA_V2.required]);
  assert.match(JSON.stringify(PROPOSAL_SCHEMA_V2), /"minLength":1/);
  // Local validation still enforces the lengths the portable copy leaves out.
  const p = proposal();
  p.columns[0]!.reason = "";
  assert.ok(proposalProblems(p, promptEvidence(evidence(), STANDARDS), STANDARDS).length > 0, "an empty reason is still rejected locally");
  assert.deepEqual(proposalProblems(proposal(), promptEvidence(evidence(), STANDARDS), STANDARDS), []);
});
