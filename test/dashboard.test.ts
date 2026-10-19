import assert from "node:assert/strict";
import test from "node:test";
import { describeJob, detailCommandHints } from "../src/dashboard.js";
import type { ItemStatus, JobManifest } from "../src/types.js";

function job(localStatus: string, statuses: ItemStatus[], extra: Partial<JobManifest> = {}): JobManifest {
  return {
    localId: "B-20261019-TEST",
    localStatus,
    kind: "workflow",
    items: statuses.map((status, i) => ({ customId: `B-20261019-TEST_request-00${i + 1}`, ordinal: i + 1, source: { kind: "file", path: `f${i}.ts` }, status })),
    ...extra,
  } as unknown as JobManifest;
}

test("dashboard detail hints only offer commands the job's state accepts", () => {
  const id = "B-20261019-TEST";
  // Not finished: nothing to retry or synthesize yet.
  assert.deepEqual(detailCommandHints(job("previewed", ["planned", "planned"])), [`/batch items ${id}`]);
  assert.deepEqual(detailCommandHints(job("polling", ["submitted", "submitted"])), [`/batch items ${id}`]);
  // Complete: synthesis, but no failed items to retry.
  assert.deepEqual(detailCommandHints(job("ready", ["completed", "completed"])), [`/batch items ${id}`, `/batch synthesize ${id}`]);
  // Partial: retry the gaps, or synthesize with the gaps stated.
  assert.deepEqual(detailCommandHints(job("partial", ["completed", "failed"])), [
    `/batch items ${id}`,
    `/batch retry-items ${id} --failed`,
    `/batch synthesize ${id} --allow-partial`,
  ]);
  // Failed: retry only.
  assert.deepEqual(detailCommandHints(job("failed", ["failed", "missing"])), [`/batch items ${id}`, `/batch retry-items ${id} --failed`]);
  // A submission OpenRouter may have accepted must be checked there first: no retry suggested.
  const unknown = job("failed", ["planned", "planned"], { error: { code: "submission_unknown", message: "may or may not" } });
  assert.deepEqual(detailCommandHints(unknown), [`/batch items ${id}`]);
  // A synthesis job is never offered for synthesis itself.
  assert.deepEqual(detailCommandHints(job("ready", ["completed", "completed"], { kind: "synthesis" })), [`/batch items ${id}`]);
});

const DATASET_WF = {
  name: "classify-tickets",
  version: 1,
  origin: "project",
  definitionFile: ".pi/batch-workflows/classify-tickets.yaml",
  definitionSha256: "a".repeat(64),
  resolvedSha256: "b".repeat(64),
  output: "json",
  synthesisEnabled: true,
  dataset: { type: "csv", path: "data/tickets.csv", sha256: "c".repeat(64), bytes: 10, idField: "ticket_id", fields: ["title", "description"], totalRows: 5, selectedRows: 2, excludedRows: 3, invalidRows: 0, blankLines: 0 },
  selection: { ids: ["T-1", "T-2"] },
  planSha256: "d".repeat(64),
};

test("dashboard: dataset jobs offer export when finished, and synthesis only when the workflow enables it", () => {
  const id = "B-20261019-TEST";
  const ready = job("ready", ["completed", "completed"], { workflow: DATASET_WF } as never);
  assert.deepEqual(detailCommandHints(ready), [`/batch items ${id}`, `/batch synthesize ${id}`, `/batch export ${id} --format jsonl`]);
  const disabled = job("ready", ["completed", "completed"], { workflow: { ...DATASET_WF, synthesisEnabled: false } } as never);
  assert.deepEqual(detailCommandHints(disabled), [`/batch items ${id}`, `/batch export ${id} --format jsonl`]);
  assert.deepEqual(detailCommandHints(job("polling", ["submitted", "submitted"], { workflow: DATASET_WF } as never)), [`/batch items ${id}`]);
});

test("dashboard: describeJob shows workflow, dataset, rows, fields, output, synthesis and exports for dataset jobs only", () => {
  const base = { model: "m", account: "openrouter", objective: "o", requestCount: 2, retryCount: 0, context: { fileCount: 1, characters: 9, excludedCount: 0 }, createdAt: "2026-10-19T00:00:00.000Z", pollAttempts: 0, warnings: [] };
  const lines = describeJob(job("ready", ["completed", "completed"], { ...base, workflow: DATASET_WF, exports: [{ format: "csv", path: "out/r.csv", sha256: "e", records: 2, combined: true, at: "x" }] } as never)).join("\n");
  assert.match(lines, /Workflow\s+classify-tickets \(project workflow v1, definition aaaaaaaaaaaa…\)/);
  assert.match(lines, /Dataset\s+csv data\/tickets\.csv/);
  assert.match(lines, /Rows\s+5 total · 2 selected \(ids T-1, T-2\) · 3 excluded · 0 invalid/);
  assert.match(lines, /Fields sent\s+title, description \(ID field: ticket_id\)/);
  assert.match(lines, /Output\s+json \(validated/);
  assert.match(lines, /Exports\s+1 \(latest: csv out\/r\.csv, 2 records\)/);
  const mapFiles = describeJob(job("ready", ["completed", "completed"], { ...base, workflow: { name: "map-files", version: 1, options: { groupSize: 2, format: "markdown", includeInstructions: true } } } as never)).join("\n");
  assert.match(mapFiles, /Workflow\s+map-files v1 \(groups of 2\)/);
  assert.doesNotMatch(mapFiles, /Dataset|Exports/);
});