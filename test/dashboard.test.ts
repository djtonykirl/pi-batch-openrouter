import assert from "node:assert/strict";
import test from "node:test";
import { detailCommandHints } from "../src/dashboard.js";
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
