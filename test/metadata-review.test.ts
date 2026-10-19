import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import type { TableEvidence } from "../src/metadata/contract.js";
import { writeApprovedDraft, writeMetadataReview } from "../src/metadata/outputs.js";
import { approvedDraftRows, metadataOutcome, toApprovedJsonl, validateApprovedText } from "../src/metadata/report.js";
import type { BatchService } from "../src/service.js";
import { artifactsFor } from "./fixtures/artifacts.js";
import { FAKE_KEY, FakeOpenRouter, accepted, makeConfig, makeService } from "./fixtures/fake-openrouter.js";
import { TABLES, metadataWorkspace, proposalFor } from "./fixtures/metadata.js";
import { completed, failedItem, successItem } from "./fixtures/openrouter.js";
import { rm } from "./helpers.js";

const T1 = TABLES[1] as unknown as TableEvidence; // formulation
const P1 = () => proposalFor(T1.table) as Record<string, unknown> & { columns: Array<Record<string, unknown>> };

async function withMetadata(fn: (root: string, service: BatchService, fake: FakeOpenRouter) => Promise<void>, files: Record<string, string> = {}, cfg = makeConfig()): Promise<void> {
  const root = metadataWorkspace(files);
  const fake = new FakeOpenRouter();
  try {
    await fn(root, makeService(root, fake, cfg), fake);
  } finally {
    rm(root);
  }
}

async function submitted(service: BatchService, fake: FakeOpenRouter, batchId = "batch_123") {
  fake.submitReplies = [accepted(batchId)];
  const job = await service.createMetadataJob(await service.planMetadata({ context: "metadata/beverage/context.md", input: "metadata/beverage/tables.jsonl" }), { previewOnly: false });
  assert.equal(job.localStatus, "submitted", job.error?.message);
  return job;
}

async function finish(service: BatchService, fake: FakeOpenRouter, jobId: string, results: unknown[], batchId = "batch_123") {
  fake.getReplies = [{ status: 200, body: completed(results, { id: batchId }) }];
  await service.reconcile(jobId, { force: true });
  return service.registry.read(jobId);
}



test(
  "retrieval: malformed and schema/consistency-invalid outputs are corrupt with raw output kept; the job is partial; retry-items revalidates per table",
  () =>
    withMetadata(async (root, service, fake) => {
      const job = await submitted(service, fake);
      const [c0, c1, c2] = job.customIds;
      const invented = { ...proposalFor(TABLES[2]!.table), columns: [...(proposalFor(TABLES[2]!.table).columns as unknown[]), { name: "made_up", comment: "x", confidence: "low", reason: "r" }] };
      const done = await finish(service, fake, job.localId, [successItem(c2!, JSON.stringify(invented)), successItem(c0!, JSON.stringify(proposalFor(TABLES[0]!.table))), successItem(c1!, "Here you go: {not json")]);
      assert.equal(done.localStatus, "partial");
      assert.deepEqual(done.items!.map((i) => [i.status, i.error?.code]), [["completed", undefined], ["corrupt", "invalid_json"], ["corrupt", "schema_invalid"]]);
      assert.match(done.items![2]!.error!.message, /"made_up" is not a column of the table/);
      assert.ok(fs.existsSync(service.registry.itemArtefact(done.localId, 2, "raw")));
      assert.ok(!fs.existsSync(service.registry.itemArtefact(done.localId, 3, "output")));

      // Review of a partial job lists the gaps; approved needs --allow-partial.
      const art = artifactsFor(root, service);
      const rev = await writeMetadataReview(service, art, done.localId, { out: "metadata/beverage/review.md" });
      assert.equal(rev.gaps, 2);
      const md = fs.readFileSync(path.join(root, "metadata/beverage/review.md"), "utf8");
      assert.match(md, /- Completed: 1\n- Failed\/corrupt\/missing: 2/);
      assert.match(md, /demo_catalog\.beverage\.formulation: corrupt — \[invalid_json\]/);
      await assert.rejects(writeApprovedDraft(service, art, done.localId, { out: "metadata/beverage/approved.jsonl" }), /2 of 3 table\(s\) have no usable proposal[\s\S]*--allow-partial/);
      const partial = await writeApprovedDraft(service, art, done.localId, { out: "metadata/beverage/approved-partial.jsonl", allowPartial: true });
      assert.deepEqual(partial.validation.problems, []);
      const rows = fs.readFileSync(path.join(root, "metadata/beverage/approved-partial.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      assert.equal(rows.length, 3); // never silently omitted
      assert.deepEqual([rows[1].approved_description, rows[1].provenance.result_job_id, rows[1].provenance.proposal_sha256], [null, null, null]);
      assert.equal(rows[1].columns[1].approved_comment, "FK to product"); // existing value unchanged

      // Retry the failed tables; validation uses each item's own table, and coverage combines.
      fake.submitReplies = [accepted("batch_r")];
      const retry = await service.retryItems(done.localId, { failed: true });
      assert.deepEqual(retry.items!.map((i) => i.source.sourceId), [TABLES[1]!.table, TABLES[2]!.table]);
      const [r0, r1] = retry.customIds;
      await finish(service, fake, retry.localId, [successItem(r1!, JSON.stringify(proposalFor(TABLES[2]!.table))), successItem(r0!, JSON.stringify(proposalFor(TABLES[1]!.table)))], "batch_r");
      assert.equal(service.registry.read(retry.localId).localStatus, "ready");
      const o = metadataOutcome(service, done.localId);
      assert.deepEqual(o.tables.map((t) => [t.status, t.resultJobId]), [["completed", done.localId], ["completed", retry.localId], ["completed", retry.localId]]);
      assert.throws(() => metadataOutcome(service, retry.localId), /is a retry of/);
      const full = await writeApprovedDraft(service, art, done.localId, { out: "metadata/beverage/approved.jsonl" });
      assert.deepEqual(full.validation.problems, []);
    }),
);

test(
  "approved: edits are reported; invented, missing, duplicated, altered and stale rows are rejected; output is deterministic",
  () =>
    withMetadata(async (root, service, fake) => {
      const job = await submitted(service, fake);
      const done = await finish(service, fake, job.localId, job.customIds.map((c, i) => successItem(c, JSON.stringify(proposalFor(TABLES[i]!.table)))));
      const o = metadataOutcome(service, done.localId);
      const a = toApprovedJsonl(approvedDraftRows(o));
      assert.equal(a, toApprovedJsonl(approvedDraftRows(metadataOutcome(service, done.localId)))); // deterministic
      const base = validateApprovedText(a, service);
      assert.deepEqual(base.problems, []);
      assert.deepEqual(base.counts, { keptExisting: 2, fromProposal: 7, edited: 0, nullApproved: 1, total: 10 });

      const rows = () => a.trim().split("\n").map((l) => JSON.parse(l));
      const v = (mutate: (r: ReturnType<typeof rows>) => void) => {
        const r = rows();
        mutate(r);
        return validateApprovedText(r.map((x) => JSON.stringify(x)).join("\n"), service);
      };
      const edited = v((r) => {
        r[1].columns[2].approved_comment = "Lifecycle status of the formulation (ACTIVE, DRAFT).";
        r[0].approved_description = "Sellable beverage products (SKUs)."; // reviewer accepts the proposed improvement
      });
      assert.deepEqual(edited.problems, []);
      assert.deepEqual([edited.counts.edited, edited.counts.fromProposal, edited.counts.keptExisting, edited.counts.nullApproved], [1, 8, 1, 0]);
      assert.match(v((r) => r.pop()).problems.join(), /table "demo_catalog\.beverage\.ingredient" of job .* is missing/);
      assert.match(v((r) => r.push(r[0])).problems.join(), /appears more than once/);
      assert.match(v((r) => (r[0].table = "demo_catalog.beverage.price")).problems.join(), /is not in job/);
      assert.match(v((r) => r[1].columns.push({ name: "invented", existing_comment: null, approved_comment: "x" })).problems.join(), /"invented" is not a column .* \(invented\)/);
      assert.match(v((r) => r[1].columns.pop()).problems.join(), /column "status_cd" of .* is missing/);
      assert.match(v((r) => (r[1].columns[1].existing_comment = "changed")).problems.join(), /existing_comment of "product_id" differs from the evidence/);
      assert.match(v((r) => (r[0].existing_description = null)).problems.join(), /existing_description differs/);
      assert.match(v((r) => (r[0].provenance.input_sha256 = "0".repeat(64))).problems.join(), /input_sha256 does not match/);
      assert.match(v((r) => (r[0].sql = "ALTER TABLE x")).problems.join(), /must NOT have additional properties \("sql"\)/);
      assert.match(validateApprovedText("", service).problems.join(), /no rows/);
      // Approved files and artefacts never contain the API key.
      const art = artifactsFor(root, service);
      await writeApprovedDraft(service, art, done.localId, { out: "metadata/beverage/approved.jsonl" });
      await assert.rejects(writeApprovedDraft(service, art, done.localId, { out: "metadata/beverage/approved.jsonl" }), /already exists/);
      await assert.rejects(writeApprovedDraft(service, art, done.localId, { out: "metadata/beverage/approved.json" }), /\.jsonl destination/);
      await assert.rejects(writeApprovedDraft(service, art, done.localId, { out: "../approved.jsonl" }), /outside the workspace/);
      for (const e of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
        if (e.isFile()) assert.ok(!fs.readFileSync(path.join(e.parentPath, e.name)).includes(FAKE_KEY), e.name);
      }
    }),
);

test(
  "compatibility: a failed table is reported, not dropped; a non-metadata job is refused by metadata commands",
  () =>
    withMetadata(async (_root, service, fake) => {
      const job = await submitted(service, fake);
      const done = await finish(service, fake, job.localId, [successItem(job.customIds[0]!, JSON.stringify(proposalFor(TABLES[0]!.table))), failedItem(job.customIds[1]!), successItem(job.customIds[2]!, JSON.stringify(proposalFor(TABLES[2]!.table)))]);
      assert.equal(done.localStatus, "partial");
      assert.deepEqual(metadataOutcome(service, done.localId).tables.map((t) => t.status), ["completed", "failed", "completed"]);
      fake.submitReplies = [accepted("batch_g")];
      const goal = await service.createJob(await service.prepare({ objective: "Q", files: ["metadata/beverage/context.md"], contexts: [], format: "markdown", includeInstructions: true }), { previewOnly: false });
      assert.throws(() => metadataOutcome(service, goal.localId), /is not a databricks-metadata job/);
    }),
);
