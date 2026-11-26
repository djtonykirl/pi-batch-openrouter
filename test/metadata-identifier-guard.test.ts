import assert from "node:assert/strict";
import test from "node:test";
import { forbiddenValues, isIdentifierValue, leaks } from "../src/metadata/identifier-guard.js";
import { writeApprovedDraft } from "../src/metadata/outputs.js";
import { METADATA_INSTRUCTIONS } from "../src/metadata/plan.js";
import { guardedDraft, metadataOutcome, toApprovedJsonl, validateApprovedText } from "../src/metadata/report.js";
import { artifactsFor } from "./fixtures/artifacts.js";
import { FakeOpenRouter, accepted, makeConfig, makeService } from "./fixtures/fake-openrouter.js";
import { metadataWorkspace } from "./fixtures/metadata.js";
import { completed, successItem } from "./fixtures/openrouter.js";
import { rm } from "./helpers.js";

const GUID = "3f2a9c1e-7b4d-4e8a-9c0f-1a2b3c4d5e6f";

test("guard: identifier columns by name, GUIDs by shape, short values ignored (mirrors Lighthouse test_identifier_guard.py)", () => {
  assert.ok(isIdentifierValue("CREAT_USR_ID", "MHUNT"));
  assert.ok(isIdentifierValue("owninguser", "anything-here"));
  assert.ok(isIdentifierValue("rnd_sectorteamid", "team-x"));
  assert.ok(isIdentifierValue("rnd_anything", GUID));
  assert.ok(!isIdentifierValue("LOC_SCTR_NM", "APAC"));
  assert.ok(!isIdentifierValue("owninguser", "Y"));
  const forbidden = forbiddenValues([
    { name: "owninguser", sample_values: [GUID, "Y"] },
    { name: "LOC_SCTR_NM", sample_values: ["APAC", "PBNA"] },
    { name: "CREAT_USR_ID", sample_values: ["MHUNT"] },
  ]);
  assert.deepEqual([...forbidden], [[GUID, "owninguser"], ["MHUNT", "CREAT_USR_ID"]]);
  assert.deepEqual(leaks(`VALUES: one owner (${GUID}).`, forbidden), ["owninguser"]);
  assert.deepEqual(leaks("Created by MHUNT or STGCDV.", forbidden), ["CREAT_USR_ID"]);
  assert.deepEqual(leaks("VALUES: APAC, PBNA.", forbidden), []);
  assert.deepEqual(leaks("XMHUNTX is not a match.", forbidden), []);
  assert.deepEqual(leaks(null, forbidden), []);
  assert.deepEqual(leaks("text", new Map()), []);
});

test("every Lighthouse name pattern matches (and a plain column does not)", () => {
  for (const n of ["usr", "user", "login", "account", "owner", "owning", "onbehalf", "createdby", "modifiedby", "created_by", "modified_by", "updated_by", "x_by", "x_by_id", "gpid", "employee", "emp", "member", "team", "assignee", "assigned_to", "approver", "requester", "submitter", "submitted_by", "inspector_id", "auditor_id"]) {
    assert.ok(isIdentifierValue(n, "abcd"), n);
  }
  assert.ok(isIdentifierValue("stand_by_code", "abcd")); // a "_by_" token
  assert.ok(!isIdentifierValue("status_cd", "ACTIVE"));
});

const TABLE = {
  table: "demo_catalog.ops.task",
  existing_description: null,
  columns: [
    { name: "created_by", data_type: "STRING", nullable: true, existing_comment: null, sample_values: ["jsmith01", "A1"] },
    { name: "ref_id", data_type: "STRING", nullable: true, existing_comment: "Keep me.", sample_values: [GUID] },
    { name: "status_cd", data_type: "STRING", nullable: true, existing_comment: null, sample_values: ["OPEN", "CLOSED"] },
  ],
};

test("approved writer reverts identifier values, reports table and column (never the value); validate rejects them", async () => {
  const root = metadataWorkspace({ "metadata/beverage/tables.jsonl": JSON.stringify(TABLE) + "\n" });
  const fake = new FakeOpenRouter();
  try {
    const service = makeService(root, fake, makeConfig());
    fake.submitReplies = [accepted("batch_ig")];
    const job = await service.createMetadataJob(await service.planMetadata({ context: "metadata/beverage/context.md", input: "metadata/beverage/tables.jsonl" }), { previewOnly: false });
    const proposal = {
      table: TABLE.table,
      table_description: { comment: "Tasks; the main author is jsmith01.", confidence: "medium", reason: "Domain context." },
      columns: [
        { name: "created_by", comment: "Who created the task, for example jsmith01.", confidence: "medium", reason: "Name." },
        { name: "ref_id", comment: `Reference ${GUID}.`, confidence: "medium", reason: "Name." },
        { name: "status_cd", comment: "Task status.\nVALUES: OPEN, CLOSED", confidence: "medium", reason: "Samples." },
      ],
    };
    fake.getReplies = [{ status: 200, body: completed([successItem(job.customIds[0]!, JSON.stringify(proposal))], { id: "batch_ig" }) }];
    await service.reconcile(job.localId, { force: true });

    const { rows, findings } = guardedDraft(metadataOutcome(service, job.localId));
    assert.equal(rows[0]!.approved_description, null);
    assert.equal(rows[0]!.columns[0]!.approved_comment, null);
    assert.equal(rows[0]!.columns[1]!.approved_comment, "Keep me.");
    assert.equal(rows[0]!.columns[2]!.approved_comment, "Task status.\nVALUES: OPEN, CLOSED");
    assert.deepEqual(findings, { [TABLE.table]: { "(table)": ["created_by"], created_by: ["created_by"] } });
    assert.ok(!JSON.stringify(findings).includes("jsmith01"));

    const out = await writeApprovedDraft(service, artifactsFor(root, service), job.localId, { out: "approved.jsonl" });
    assert.deepEqual(out.validation.problems, []);
    assert.deepEqual(Object.keys(out.identifierFindings), [TABLE.table]);

    // A reviewer who puts an identifier value back is rejected, naming the column and not the value.
    const edited = rows.map((r) => ({ ...r, columns: r.columns.map((c) => (c.name === "ref_id" ? { ...c, approved_comment: `Reference ${GUID}.` } : c)) }));
    const v = validateApprovedText(toApprovedJsonl(edited), service);
    assert.equal(v.problems.length, 1);
    assert.match(v.problems[0]!, /ref_id.*identifier column\(s\): ref_id/);
    assert.ok(!v.problems[0]!.includes(GUID));
    // Unchanged existing text is not rejected (same rule as Lighthouse ingest).
    const keptExisting = rows.map((r) => ({ ...r, existing_description: r.existing_description }));
    assert.deepEqual(validateApprovedText(toApprovedJsonl(keptExisting), service).problems, []);
  } finally {
    rm(root);
  }
});

test("prompt: the sample_values rule replaces the illustrative-only rule", () => {
  const text = METADATA_INSTRUCTIONS.join("\n");
  assert.ok(!text.includes("Sample values are illustrative"));
  assert.match(text, /sample_values are disclosed reference values, each seen in many rows and checked for personal data\. When they look like the column's full set of values \(a short list of codes, names or statuses\), list them in VALUES:; when the column has more values than were disclosed, give two or three as examples and say they are examples\. Never invent a value, never list values for a column that has no sample_values, and do not state what a code means unless the evidence says so\./);
});
