import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { canonicalJson, sha256Hex } from "../src/fsutil.js";
import { discoverWorkflows } from "../src/workflows/definition.js";
import { FAKE_KEY, FakeOpenRouter, accepted, makeService } from "./fixtures/fake-openrouter.js";
import { completed, successItem } from "./fixtures/openrouter.js";
import { rm } from "./helpers.js";
import { CLASSIFY_YAML, TICKETS_CSV, datasetWorkspace } from "./fixtures/datasets.js";

const json = (category: string, rationale = "because") => JSON.stringify({ category, rationale });

test("vertical slice: YAML workflow + 3-row CSV -> preview -> restart -> submit -> reversed results -> schema-valid -> ready -> JSONL export -> restart", async () => {
  const root = datasetWorkspace();
  try {
    // 1-3. Discovery and validation.
    const catalog = discoverWorkflows(root);
    assert.equal(catalog.entries.length, 1);
    const entry = catalog.entries[0]!;
    assert.equal(entry.valid, true, JSON.stringify(entry.diagnostics));
    assert.equal(entry.name, "classify-tickets");
    assert.equal(entry.definitionSha256, sha256Hex(fs.readFileSync(path.join(root, ".pi/batch-workflows/classify-tickets.yaml"))));

    // 4-5. Preview: three stable source IDs, three requests, exact selected fields.
    const fake = new FakeOpenRouter();
    const service = makeService(root, fake);
    const prepared = await service.planDataset({ workflow: "classify-tickets", input: "data/tickets.csv" });
    assert.deepEqual(prepared.blockers, []);
    assert.equal(prepared.model, "openai/gpt-oss-20b");
    const plan = prepared.plan!;
    assert.deepEqual(plan.items.map((i) => i.source.sourceId), ["T-1001", "T-1002", "T-1003"]);
    assert.deepEqual(plan.counts, { totalRows: 3, selectedRows: 3, excludedRows: 0, invalidRows: 0, plannedRequests: 3, missingIds: 0, duplicateIds: 0, blankLines: 0 });
    // Braces in source data stay data; the unselected column never reaches a prompt.
    assert.match(plan.items[1]!.prompt, /Crash on start: "NullPointer" in \{\{title\}\}/);
    for (const it of plan.items) assert.doesNotMatch(it.prompt, /example\.invalid/);

    const preview = await service.createDatasetJob(prepared, { previewOnly: true });
    assert.equal(preview.localStatus, "previewed");
    assert.equal(preview.schemaVersion, 3);
    assert.equal(fake.requests.length, 0);
    const reg = service.registry;
    const meta2 = JSON.parse(fs.readFileSync(reg.itemArtefact(preview.localId, 2, "metadata"), "utf8"));
    assert.deepEqual(meta2.selectedFields, { title: "App crashes", description: 'Crash on start: "NullPointer" in {{title}}' });
    assert.equal(meta2.source.sourceId, "T-1002");
    assert.equal(meta2.source.row, 2);
    assert.equal(meta2.customId, `${preview.localId}_request-002`);
    assert.notEqual(meta2.customId, "T-1002");
    assert.equal(meta2.inputSha256, sha256Hex(canonicalJson({ sourceId: "T-1002", fields: meta2.selectedFields })));
    assert.equal(fs.readFileSync(reg.artefact(preview.localId, "workflowSource"), "utf8"), CLASSIFY_YAML);
    const dsJson = JSON.parse(fs.readFileSync(reg.artefact(preview.localId, "dataset"), "utf8"));
    assert.deepEqual(dsJson.items.map((i: { sourceId: string; customId: string }) => [i.sourceId, i.customId]), preview.customIds.map((c, i) => [`T-100${i + 1}`, c]));

    // Restart between preview and submit.
    const fake2 = new FakeOpenRouter();
    const service2 = makeService(root, fake2);
    fake2.submitReplies = [accepted()];
    const submitted = await service2.submit(preview.localId);
    assert.equal(submitted.localStatus, "submitted");
    assert.equal(fake2.requests[0]!.body, fs.readFileSync(reg.artefact(preview.localId, "submittedRequest"), "utf8"));
    const body = JSON.parse(fake2.requests[0]!.body!);
    assert.equal(body.model, "openai/gpt-oss-20b");
    assert.match(body.requests[0].body.messages[0].content, /OUTPUT FORMAT/);

    // 6-9. Results out of order; correlation by custom_id; schema validation; ready.
    const [c1, c2, c3] = fake2.lastCustomIds();
    fake2.getReplies = [{ status: 200, body: completed([successItem(c3!, json("other")), successItem(c1!, json("billing")), successItem(c2!, "```json\n" + json("bug") + "\n```")]) }];
    const service3 = makeService(root, fake2);
    await service3.reconcile(preview.localId, { force: true });
    const done = reg.read(preview.localId);
    assert.equal(done.localStatus, "ready", done.error?.message);
    assert.deepEqual(done.items!.map((i) => i.status), ["completed", "completed", "completed"]);
    assert.deepEqual(JSON.parse(fs.readFileSync(reg.itemArtefact(done.localId, 1, "output"), "utf8")), { category: "billing", rationale: "because" });
    assert.deepEqual(JSON.parse(fs.readFileSync(reg.itemArtefact(done.localId, 2, "output"), "utf8")).category, "bug");
    assert.ok(done.items![1]!.validation!.warnings.some((w) => /code fence/.test(w)));

    // 10. JSONL export keeps source IDs and results.
    const rec = service3.exportResults(done.localId, { format: "jsonl" });
    assert.equal(rec.records, 3);
    assert.match(rec.path, /^\.pi\/batches\/.+\/exports\/.+\.jsonl$/);
    const lines = fs.readFileSync(path.join(root, rec.path), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => [l.source_id, l.source_row, l.status, l.result.category]), [
      ["T-1001", 1, "completed", "billing"],
      ["T-1002", 2, "completed", "bug"],
      ["T-1003", 3, "completed", "other"],
    ]);
    assert.equal(lines[0].workflow, "classify-tickets");
    assert.equal(lines[0].dataset_sha256, sha256Hex(TICKETS_CSV));
    assert.equal(lines[0].input_tokens, null); // per-item usage not reported by this fake response: never invented

    // 11. Restart: a fresh service sees the same final state and export record.
    const service4 = makeService(root, new FakeOpenRouter());
    const again = service4.registry.read(done.localId);
    assert.equal(again.localStatus, "ready");
    assert.equal(again.exports?.length, 1);
    assert.deepEqual(service4.jobsNeedingReconcile(), []);
    // The API key never lands in artefacts.
    for (const e of fs.readdirSync(path.join(root, ".pi"), { recursive: true, withFileTypes: true })) {
      if (e.isFile()) assert.ok(!fs.readFileSync(path.join(e.parentPath, e.name), "utf8").includes(FAKE_KEY), `${e.name} contains the API key`);
    }
  } finally {
    rm(root);
  }
});
