import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { evidenceHash } from "../src/metadata/contract.js";
import { writeApprovedDraft, writeMetadataReview } from "../src/metadata/outputs.js";
import { metadataOutcome, metadataSummary, validateApprovedText } from "../src/metadata/report.js";
import { sha256Hex } from "../src/fsutil.js";
import { artifactsFor } from "./fixtures/artifacts.js";
import { FakeOpenRouter, accepted, makeService } from "./fixtures/fake-openrouter.js";
import { CONTEXT_MD, TABLES, TABLES_JSONL, metadataWorkspace, proposalFor } from "./fixtures/metadata.js";
import { completed, successItem } from "./fixtures/openrouter.js";
import { rm } from "./helpers.js";

test("vertical slice: context + 3 tables -> preview -> fake OpenRouter (out of order) -> validation -> review.md -> approved.jsonl", async () => {
  const root = metadataWorkspace();
  try {
    const fake = new FakeOpenRouter();
    const service = makeService(root, fake);
    const prepared = await service.planMetadata({ context: "metadata/beverage/context.md", input: "metadata/beverage/tables.jsonl" });
    assert.deepEqual(prepared.blockers, []);
    const plan = prepared.plan!;
    assert.equal(plan.contextSha256, sha256Hex(CONTEXT_MD));
    assert.equal(plan.inputSha256, sha256Hex(TABLES_JSONL));
    assert.deepEqual([plan.tables, plan.items.length, plan.tablesWithSamples], [3, 3, 2]);
    // One table per request: each prompt carries the shared context and ONLY its own table.
    for (const it of plan.items) {
      assert.match(it.prompt, /<<<DOMAIN CONTEXT BEGIN Q[0-9a-f]{16}>>>\n# Beverage Product Domain/);
      for (const other of TABLES.filter((t) => t.table !== it.evidence.table)) assert.ok(!it.prompt.includes(`"table": "${other.table}"`));
    }
    const preview = await service.createMetadataJob(prepared, { previewOnly: true });
    assert.equal(preview.schemaVersion, 3);
    assert.deepEqual(preview.items!.map((i) => i.source.sourceId), TABLES.map((t) => t.table));
    assert.equal(fake.requests.length, 0);

    fake.submitReplies = [accepted()];
    const job = await service.submit(preview.localId);
    const ids = job.customIds;
    fake.getReplies = [{ status: 200, body: completed([2, 0, 1].map((i) => successItem(ids[i]!, JSON.stringify(proposalFor(TABLES[i]!.table))))) }];
    await service.reconcile(job.localId, { force: true });
    const done = service.registry.read(job.localId);
    assert.equal(done.localStatus, "ready", done.error?.message);

    const o = metadataOutcome(service, done.localId);
    assert.deepEqual(o.tables.map((t) => [t.table, t.status]), TABLES.map((t) => [t.table, "completed"]));
    assert.match(metadataSummary(o), /Tables:\s+3 · proposals 3/);

    const art = artifactsFor(root, service);
    const review = await writeMetadataReview(service, art, done.localId, { out: "metadata/beverage/review.md" });
    const md = fs.readFileSync(path.join(root, "metadata/beverage/review.md"), "utf8");
    assert.match(md, /Proposed metadata has not been applied to Databricks/);
    assert.match(md, /## demo_catalog\.beverage\.product\n\n\*\*Existing description:\*\*\n\nSellable beverage SKUs\.\n\n\*\*Proposed description:\*\*\n\nSellable beverage products \(SKUs\)\./);
    assert.match(md, /\| product_id \| STRING \| FK to product \| Identifier of the product this formulation belongs to\. \| high \|/);
    assert.match(md, /### Insufficient evidence\n\n- status_cd: The evidence does not establish/);
    assert.equal(review.manifest.source.type, "batch-report");
    assert.equal(review.manifest.source.jobId, done.localId);

    const approved = await writeApprovedDraft(service, art, done.localId, { out: "metadata/beverage/approved.jsonl" });
    assert.deepEqual(approved.validation.problems, []);
    const rows = fs.readFileSync(path.join(root, "metadata/beverage/approved.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(rows.map((r) => r.table), TABLES.map((t) => t.table));
    // Existing values are kept (never replaced automatically); empty ones take the proposal; insufficient stays null.
    assert.equal(rows[0].approved_description, "Sellable beverage SKUs.");
    assert.equal(rows[1].approved_description, "Contains formulation records.");
    assert.deepEqual(rows[1].columns.map((c: { name: string; approved_comment: string | null }) => [c.name, c.approved_comment]), [
      ["formulation_id", "Business meaning of formulation_id."],
      ["product_id", "FK to product"],
      ["status_cd", null],
    ]);
    assert.deepEqual(rows[1].provenance, {
      job_id: done.localId,
      result_job_id: done.localId,
      result_custom_id: ids[1],
      input_sha256: evidenceHash(TABLES[1] as never),
      context_sha256: sha256Hex(CONTEXT_MD),
      proposal_sha256: sha256Hex(fs.readFileSync(service.registry.itemArtefact(done.localId, 2, "output"))),
    });
    assert.deepEqual(Object.keys(rows[0]), ["table", "existing_description", "approved_description", "columns", "provenance"]);
    const text = fs.readFileSync(path.join(root, "metadata/beverage/approved.jsonl"), "utf8");
    assert.doesNotMatch(text, /\b(ALTER|COMMENT ON|UPDATE|DROP|SELECT)\b/); // no SQL anywhere
    assert.deepEqual(validateApprovedText(text, service).problems, []);
  } finally {
    rm(root);
  }
});
