import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { identityProblems, parseDataset } from "../src/datasets/dataset.js";
import type { BatchService, DatasetRunOptions } from "../src/service.js";
import { FAKE_KEY, FakeOpenRouter, accepted, makeConfig, makeService } from "./fixtures/fake-openrouter.js";
import { CLASSIFY_YAML, TICKETS_CSV, datasetWorkspace } from "./fixtures/datasets.js";
import { rm, tempWorkspace, writeFiles } from "./helpers.js";

const CSV_SPEC = { type: "csv" as const, idField: "id", fields: ["title", "body"] };
const JSONL_SPEC = { type: "jsonl" as const, idField: "id", fields: ["title", "body"] };

const JSONL_YAML = CLASSIFY_YAML.replace("name: classify-tickets", "name: classify-jsonl").replace("type: csv", "type: jsonl");

async function withDataset(files: Record<string, string>, fn: (root: string, service: BatchService, fake: FakeOpenRouter) => Promise<void>, cfg = makeConfig()): Promise<void> {
  const root = datasetWorkspace(files);
  const fake = new FakeOpenRouter();
  try {
    await fn(root, makeService(root, fake, cfg), fake);
  } finally {
    rm(root);
  }
}

const run = (service: BatchService, over: Partial<DatasetRunOptions> = {}) => service.planDataset({ workflow: "classify-tickets", input: "data/tickets.csv", ...over });

// --------------------------------------------------------------------- CSV

test("CSV: quoted commas, escaped quotes, multi-line fields, BOM, UTF-8, empty fields, CRLF/LF/mixed", () => {
  const text = 'id,title,body\r\n1,"a, b","say ""hi"""\n2,"multi\nline",\r\n3,Ünïcødé ✓,日本語\r\n';
  const d = parseDataset(text, CSV_SPEC);
  assert.deepEqual(d.fatal, []);
  assert.deepEqual(d.records.map((r) => [r.id, r.row, r.values.title, r.values.body]), [
    ["1", 1, "a, b", 'say "hi"'],
    ["2", 2, "multi\nline", ""],
    ["3", 3, "Ünïcødé ✓", "日本語"],
  ]);
  const lf = parseDataset(text.replace(/\r\n/g, "\n"), CSV_SPEC);
  assert.deepEqual(lf.records.map((r) => r.values), d.records.map((r) => r.values));
  // BOM is handled at the byte level by decodeDatasetBytes; delimiter alternatives work.
  const semi = parseDataset("id;title;body\n1;a,b;c\n", { ...CSV_SPEC, delimiter: ";" });
  assert.equal(semi.records[0]!.values.title, "a,b");
  const tsv = parseDataset("id\ttitle\tbody\n1\ta\tb\n", { ...CSV_SPEC, delimiter: "\t" });
  assert.equal(tsv.records[0]!.values.body, "b");
});

test("CSV: blank lines are ignored and counted; long text fields are kept whole", () => {
  const long = "x".repeat(200_000);
  const d = parseDataset(`id,title,body\n\n1,t,${long}\n\n\n2,t,b\n`, CSV_SPEC);
  assert.deepEqual(d.fatal, []);
  assert.equal(d.blankLines, 3);
  assert.equal(d.records[0]!.values.body!.length, 200_000);
  assert.deepEqual(d.records.map((r) => r.row), [1, 2]);
});

test("CSV: duplicate headers, missing required columns, malformed rows and empty files are fatal, without echoing data", () => {
  assert.match(parseDataset("id,title,title,body\n1,a,b,c\n", CSV_SPEC).fatal.join(), /duplicate header "title" \(columns 2 and 3\)/);
  assert.match(parseDataset("id,title\n1,a\n", CSV_SPEC).fatal.join(), /missing required column\(s\): "body"/);
  const ragged = parseDataset("id,title,body\n1,a,b\n2,SECRET-ROW-VALUE,b,extra\n", CSV_SPEC).fatal.join();
  assert.match(ragged, /malformed CSV at line 3: the record does not have the same number of columns/);
  assert.doesNotMatch(ragged, /SECRET-ROW-VALUE/);
  const quote = parseDataset('id,title,body\n1,"abc"PRIVATE,b\n', CSV_SPEC).fatal.join();
  assert.match(quote, /malformed CSV at line 2/);
  assert.doesNotMatch(quote, /PRIVATE/);
  assert.match(parseDataset('id,title,body\n1,"never closed,b\n', CSV_SPEC).fatal.join(), /quoted field is never closed/);
  assert.match(parseDataset("", CSV_SPEC).fatal.join(), /empty/);
  assert.match(parseDataset("id,title,body\n", CSV_SPEC).fatal.join(), /no data rows/);
});

test("CSV: missing and duplicate source IDs are found across the whole dataset", () => {
  const d = parseDataset("id,title,body\n1,a,b\n,a,b\n1,a,b\n   ,a,b\n", CSV_SPEC);
  const p = identityProblems(d.records, "csv");
  assert.equal(p.missing, 2);
  assert.equal(p.duplicates, 1);
  assert.deepEqual(p.messages, ["row 2: missing source ID (id is empty)", 'row 3: duplicate source ID "1" (first at row 1)', "row 4: missing source ID (id is empty)"]);
});

// ------------------------------------------------------------------- JSONL

test("JSONL: valid rows, blank lines, scalar rendering, line numbers persisted", () => {
  const d = parseDataset('{"id":"a","title":"t","body":"b"}\r\n\n   \n{"id":7,"title":3.5,"body":true,"extra":{"x":1}}\n', JSONL_SPEC);
  assert.deepEqual(d.fatal, []);
  assert.equal(d.blankLines, 2);
  assert.deepEqual(d.records.map((r) => [r.id, r.line, r.index, r.values]), [
    ["a", 1, 1, { title: "t", body: "b" }],
    ["7", 4, 2, { title: "3.5", body: "true" }],
  ]);
});

test("JSONL: malformed lines fail with their exact line number and no content; non-objects fail", () => {
  const d = parseDataset('{"id":"a","title":"t","body":"b"}\n{"id":"b","title":"PRIVATE-VALUE",\n[1,2]\n', JSONL_SPEC);
  assert.deepEqual(d.fatal, ["line 2: not valid JSON", "line 3: not a JSON object"]);
  assert.doesNotMatch(d.fatal.join(), /PRIVATE/);
  assert.match(parseDataset("\n\n", JSONL_SPEC).fatal.join(), /no records/);
});

test("JSONL: missing/duplicate IDs and missing/null/non-scalar fields are row problems", () => {
  const d = parseDataset(['{"id":"a","title":"t","body":"b"}', '{"title":"t","body":"b"}', '{"id":"a","title":"t","body":"b"}', '{"id":"c","title":null,"body":{"x":1}}', '{"id":1.5,"title":"t","body":"b"}', '{"id":"d","body":"b"}'].join("\n"), JSONL_SPEC);
  assert.deepEqual(d.records.map((r) => r.problems), [[], ["missing source ID (id)"], [], ['field "title" is null', 'field "body" is not a string, number or boolean'], ["source ID (id) must be a string or an integer"], ['missing field "title"']]);
  const p = identityProblems(d.records, "jsonl");
  assert.equal(p.missing, 2);
  assert.equal(p.duplicates, 1);
  assert.match(p.messages.join("\n"), /line 3: duplicate source ID "a" \(first at line 1\)/);
});

test("JSONL workflow end to end: plan uses line numbers; IDs never become custom_ids", async () => {
  await withDataset(
    {
      ".pi/batch-workflows/classify-jsonl.yaml": JSONL_YAML,
      "data/tickets.jsonl": '{"ticket_id":"T/1 with spaces:é","title":"a","description":"b","secret_note":"not selected"}\n\n{"ticket_id":"T-2","title":"c","description":"d"}\n',
    },
    async (_root, service) => {
      const p = await service.planDataset({ workflow: "classify-jsonl", input: "data/tickets.jsonl" });
      assert.deepEqual(p.blockers, []);
      assert.deepEqual(p.plan!.items.map((i) => [i.source.sourceId, i.source.line, i.source.row]), [
        ["T/1 with spaces:é", 1, undefined],
        ["T-2", 3, undefined],
      ]);
      const job = await service.createDatasetJob(p, { previewOnly: true });
      for (const cid of job.customIds) assert.match(cid, /^[A-Za-z0-9_-]{1,64}$/);
      assert.ok(!fs.readFileSync(service.registry.artefact(job.localId, "submittedRequest"), "utf8").includes("not selected"));
    },
  );
});

// --------------------------------------------------------------- selection

test("selection: repeatable --id keeps dataset order; unknown IDs fail; excluded rows counted", async () => {
  await withDataset({}, async (_root, service) => {
    const p = await run(service, { ids: ["T-1003", "T-1001", "T-1003"] });
    assert.deepEqual(p.blockers, []);
    assert.deepEqual(p.plan!.items.map((i) => i.source.sourceId), ["T-1001", "T-1003"]);
    assert.deepEqual([p.plan!.counts.totalRows, p.plan!.counts.selectedRows, p.plan!.counts.excludedRows, p.plan!.counts.plannedRequests], [3, 2, 1, 2]);
    assert.match(p.warnings.join(), /given more than once/);
    const bad = await run(service, { ids: ["T-9999"] });
    assert.match(bad.blockers.join(), /--id names source IDs that are not in the dataset:\n  - "T-9999"/);
  });
});

test("selection: --from-row/--to-row ranges, bad ranges, and combining with --id", async () => {
  await withDataset({}, async (_root, service) => {
    const p = await run(service, { fromRow: 2, toRow: 3 });
    assert.deepEqual(p.plan!.items.map((i) => i.source.row), [2, 3]);
    assert.deepEqual((await run(service, { fromRow: 3 })).plan!.items.map((i) => i.source.sourceId), ["T-1003"]);
    assert.match((await run(service, { fromRow: 2, toRow: 9 })).blockers.join(), /outside the dataset \(rows 1-3\)/);
    assert.match((await run(service, { fromRow: 3, toRow: 2 })).blockers.join(), /--to-row must be/);
    assert.match((await run(service, { ids: ["T-1001"], fromRow: 1 })).blockers.join(), /either --id or --from-row/);
  });
});

test("selection: invalid rows block only when selected; identity problems block always", async () => {
  const yaml = JSONL_YAML;
  const data = ['{"ticket_id":"a","title":"t","description":"d"}', '{"ticket_id":"b","title":null,"description":"d"}', '{"ticket_id":"c","title":"t","description":"d"}'].join("\n");
  await withDataset({ ".pi/batch-workflows/classify-jsonl.yaml": yaml, "data/t.jsonl": data }, async (_root, service) => {
    const all = await service.planDataset({ workflow: "classify-jsonl", input: "data/t.jsonl" });
    assert.match(all.blockers.join(), /selected rows have invalid fields:\n  - line 2: field "title" is null/);
    const subset = await service.planDataset({ workflow: "classify-jsonl", input: "data/t.jsonl", ids: ["a", "c"] });
    assert.deepEqual(subset.blockers, []);
    assert.equal(subset.plan!.counts.invalidRows, 1);
    assert.match(subset.warnings.join(), /1 unselected row\(s\) have invalid fields/);
  });
  await withDataset({ "data/tickets.csv": TICKETS_CSV + "T-1001,dup,dup,x@example.invalid\r\n" }, async (_root, service) => {
    const p = await run(service, { ids: ["T-1002"] });
    assert.match(p.blockers.join(), /source IDs must be present and unique in every row \(0 missing, 1 duplicate\)/);
    assert.match(p.blockers.join(), /row 4: duplicate source ID "T-1001" \(first at row 1\)/);
    assert.equal(p.plan!.items.length, 0); // no request is planned for a dataset whose identity is unsound
  });
});

// ------------------------------------------------------------- determinism

test("determinism: identical inputs give an identical logical plan; changes to data or workflow change the hashes", async () => {
  await withDataset({}, async (root, service) => {
    const a = (await run(service)).plan!;
    const b = (await run(service)).plan!;
    assert.equal(a.planSha256, b.planSha256);
    assert.deepEqual(a.items.map((i) => [i.source, i.prompt, i.requestSha256, i.inputSha256]), b.items.map((i) => [i.source, i.prompt, i.requestSha256, i.inputSha256]));
    const j1 = await service.createDatasetJob(await run(service), { previewOnly: true });
    const j2 = await service.createDatasetJob(await run(service), { previewOnly: true });
    assert.notEqual(j1.localId, j2.localId);
    assert.deepEqual(j1.items!.map((i) => i.requestSha256), j2.items!.map((i) => i.requestSha256));
    assert.equal((j1.workflow as { planSha256: string }).planSha256, (j2.workflow as { planSha256: string }).planSha256);

    fs.writeFileSync(path.join(root, "data/tickets.csv"), TICKETS_CSV.replace("App crashes", "App crashed"));
    const c = (await run(service)).plan!;
    assert.notEqual(c.planSha256, a.planSha256);
    assert.notEqual(c.dataset.sha256, a.dataset.sha256);
    assert.deepEqual(c.items.map((i) => i.requestSha256 === a.items[i.ordinal - 1]!.requestSha256), [true, false, true]);
    assert.notEqual((await run(service, { model: "other/model" })).plan!.planSha256, c.planSha256);
  });
});

test("immutable preview: editing the workflow after preview never rebuilds the stored request; submit warns", async () => {
  await withDataset({}, async (root, service, fake) => {
    const preview = await service.createDatasetJob(await run(service), { previewOnly: true });
    const stored = fs.readFileSync(service.registry.artefact(preview.localId, "submittedRequest"), "utf8");
    assert.equal(service.workflowDrift(preview.localId), undefined);
    fs.writeFileSync(path.join(root, ".pi/batch-workflows/classify-tickets.yaml"), CLASSIFY_YAML.replace("Classify this ticket.", "Summarise this ticket."));
    assert.match(service.workflowDrift(preview.localId)!, /has changed since .* was previewed/);
    fake.submitReplies = [accepted()];
    const job = await service.submit(preview.localId);
    assert.equal(job.localStatus, "submitted");
    assert.equal(fake.requests[0]!.body, stored);
    assert.match(fake.requests[0]!.body!, /Classify this ticket/);
    assert.ok(job.warnings.some((w) => /has changed since/.test(w)));
    assert.ok(service.registry.events(preview.localId).some((e) => e.eventType === "workflow_changed_since_preview"));
    // The verbatim definition used for the preview is kept with the job.
    assert.equal(fs.readFileSync(service.registry.artefact(preview.localId, "workflowSource"), "utf8"), CLASSIFY_YAML);
  });
});

// ---------------------------------------------------------------- security

test("security: dataset outside the workspace, hard-denied, batchignored, or missing is blocked", async () => {
  const outside = tempWorkspace("pi batch outside-");
  try {
    writeFiles(outside, { "t.csv": TICKETS_CSV });
    await withDataset({ ".env": TICKETS_CSV, "data/ignored.csv": TICKETS_CSV, ".pi/batchignore": "data/ignored.csv\n" }, async (root, service) => {
      assert.match((await run(service, { input: path.join(outside, "t.csv") })).blockers.join(), /outside the workspace/);
      assert.match((await run(service, { input: path.relative(root, path.join(outside, "t.csv")) })).blockers.join(), /outside the workspace/);
      assert.match((await run(service, { input: ".env" })).blockers.join(), /hard-deny/);
      assert.match((await run(service, { input: "data/ignored.csv" })).blockers.join(), /batchignore/);
      assert.match((await run(service, { input: "data/none.csv" })).blockers.join(), /dataset not found/);
    });
  } finally {
    rm(outside);
  }
});

test("security: a secret in a provider-bound field blocks the plan; unselected columns are not scanned or sent; no value is echoed", async () => {
  const token = "ghp_" + "Ab1".repeat(12);
  const data = "ticket_id,title,description,notes\r\nT-1,Login,uses " + token + " in config,fine\r\nT-2,Other,ok,also " + token + "\r\n";
  await withDataset({ "data/s.csv": data }, async (_root, service) => {
    const p = await run(service, { input: "data/s.csv" });
    const text = p.blockers.join("\n");
    assert.match(text, /Potential secret detected/);
    assert.match(text, /item 001 \(row 1\)/);
    assert.doesNotMatch(text, /item 002/); // the token in T-2 sits in the unselected "notes" column
    assert.ok(!text.includes(token));
    assert.equal(p.plan!.secretFindings.length, 1);
    // The configured API key is also caught when it appears in a selected field.
    const withKey = data.replace("Login", FAKE_KEY);
    fs.writeFileSync(path.join(_root, "data/s.csv"), withKey);
    const p2 = await run(service, { input: "data/s.csv", ids: ["T-1"] });
    assert.match(p2.blockers.join(), /configured API key value/);
    assert.ok(!p2.blockers.join().includes(FAKE_KEY));
    assert.equal(service.registry.list().jobs.length, 0);
  });
});

test("security: diagnostics name rows and fields but never dump row content", async () => {
  const data = "ticket_id,title,description\r\nT-1,PRIVATE-TITLE,PRIVATE-DESC\r\n,PRIVATE-2,PRIVATE-3\r\nT-1,PRIVATE-4,PRIVATE-5\r\n";
  await withDataset({ "data/p.csv": data }, async (_root, service) => {
    const p = await run(service, { input: "data/p.csv" });
    const text = p.blockers.join("\n") + p.warnings.join("\n");
    assert.match(text, /row 2: missing source ID/);
    assert.match(text, /row 3: duplicate source ID "T-1"/);
    assert.doesNotMatch(text, /PRIVATE/);
  });
});

// ------------------------------------------------------------------ limits

test("limits: request, row, per-item and total limits fail planning clearly; workflow limits only tighten", async () => {
  await withDataset({}, async (_root, service) => {
    assert.deepEqual((await run(service)).blockers, []);
  }, makeConfig((c) => (c.workflows.maxRequestsPerBatch = 3)));
  await withDataset({}, async (_root, service) => {
    const p = await run(service);
    assert.match(p.blockers.join(), /3 rows selected; the row limit is 2/);
    assert.match(p.blockers.join(), /plan has 3 requests; the request limit is 2 .*never split/);
    assert.equal(service.registry.list().jobs.length, 0);
  }, makeConfig((c) => ((c.workflows.maxRequestsPerBatch = 2), (c.workflows.maxRowsPerRun = 2))));
  // Workflow says maxRequests 10; config 2 still wins (tighter).
  await withDataset({}, async (_root, service) => {
    const p = await run(service);
    assert.equal(p.limits.maxRequests, 2);
  }, makeConfig((c) => (c.workflows.maxRequestsPerBatch = 2)));
  // Workflow tighter than config.
  await withDataset({ ".pi/batch-workflows/classify-tickets.yaml": CLASSIFY_YAML.replace("maxRequests: 10", "maxRequests: 1\n  maxCharactersPerItem: 50\n  maxTotalCharacters: 60").replace("  maxCharactersPerItem: 100000\n", "") }, async (_root, service) => {
    const p = await run(service);
    assert.match(p.blockers.join(), /request limit is 1/);
    assert.match(p.blockers.join(), /per-item limit of 50 characters/);
    assert.match(p.blockers.join(), /the limit is 60 \(local policy\)/);
    assert.equal(p.limits.maxRequests, 1);
  });
  await withDataset({}, async (_root, service) => {
    assert.match((await run(service)).blockers.join(), /bytes \(limit 10\)/);
  }, makeConfig((c) => (c.workflows.maxDatasetBytes = 10)));
});

test("invalid or unknown workflows are reported, nothing persisted", async () => {
  await withDataset({ ".pi/batch-workflows/bad.yaml": "schemaVersion: 1\nname: bad\n" }, async (_root, service) => {
    const p = await service.planDataset({ workflow: "bad", input: "data/tickets.csv" });
    assert.match(p.blockers.join(), /workflow "bad" is invalid:\n.*bad\.yaml \[input\]: required property is missing/);
    await assert.rejects(service.planDataset({ workflow: "nope", input: "data/tickets.csv" }), /No workflow named "nope"/);
    await assert.rejects(service.createDatasetJob(p, { previewOnly: true }), /invalid/);
    assert.equal(service.registry.list().jobs.length, 0);
  });
});
