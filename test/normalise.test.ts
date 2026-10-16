import assert from "node:assert/strict";
import test from "node:test";
import { normaliseBatchResult } from "../src/openrouter/normalise-result.js";
import { BYOK_USAGE, batchObject, completed, failedItem, successItem } from "./fixtures/openrouter.js";

const CID = "B-20261016-A7C2:request-001";
const CID2 = "B-20261016-A7C2:request-002";
const expect1 = { localJobId: "B-20261016-A7C2", providerBatchId: "batch_123", expectedCustomIds: [CID] };
const expect2 = { ...expect1, expectedCustomIds: [CID, CID2] };
const run = (obj: unknown, e = expect1) => normaliseBatchResult(JSON.stringify(obj), e);

test("successful completed response -> ready with text and usage", () => {
  const n = run(completed([successItem(CID, "Findings: none.")]));
  assert.equal(n.outcome, "ready");
  assert.equal(n.items[0]!.text, "Findings: none.");
  assert.equal(n.items[0]!.finishReason, "stop");
  assert.deepEqual(n.usage, { inputTokens: 20, outputTokens: 40, totalTokens: 60, cost: 0.000225, isByok: false });
  assert.deepEqual(n.issues, []);
  assert.deepEqual(n.warnings, []);
});

test("content as an array of text parts is joined", () => {
  const n = run(completed([successItem(CID, [{ type: "text", text: "a" }, { type: "text", text: "b" }])]));
  assert.equal(n.outcome, "ready");
  assert.equal(n.items[0]!.text, "ab");
});

test("BYOK usage keeps the upstream inference cost separately", () => {
  const n = run(completed([successItem(CID)], { usage: BYOK_USAGE }));
  assert.equal(n.usage?.isByok, true);
  assert.equal(n.usage?.cost, 0.00001);
  assert.equal(n.usage?.upstreamInferenceCost, 0.0004);
});

test("absent usage is not fabricated", () => {
  const n = run(completed([successItem(CID)], { usage: null }));
  assert.equal(n.outcome, "ready");
  assert.equal(n.usage, undefined);
  const partialUsage = run(completed([successItem(CID)], { usage: { prompt_tokens: 5 } }));
  assert.deepEqual(partialUsage.usage, { inputTokens: 5 });
});

test("provider-level failure (not completed) is never ready", () => {
  const n = run(batchObject({ status: "failed", error: { message: "invalid model" } }));
  assert.equal(n.outcome, "corrupt");
  assert.equal(n.error?.message, "invalid model");
});

test("single failed request -> failed, error preserved", () => {
  const n = run(completed([failedItem(CID)]));
  assert.equal(n.outcome, "failed");
  assert.equal(n.items[0]!.error?.message, "context length exceeded");
  assert.equal(n.items[0]!.error?.code, "invalid_request");
});

test("mixed outcome -> partial", () => {
  const n = run(completed([successItem(CID), failedItem(CID2)]), expect2);
  assert.equal(n.outcome, "partial");
  assert.deepEqual(n.items.map((i) => i.status), ["completed", "failed"]);
});

test("non-2xx response.status_code is a failed item", () => {
  const item = successItem(CID);
  (item.response as Record<string, unknown>).status_code = 500;
  assert.equal(run(completed([item])).outcome, "failed");
});

test("missing custom_id -> corrupt", () => {
  const item = successItem(CID);
  delete item.custom_id;
  const n = run(completed([item]));
  assert.equal(n.outcome, "corrupt");
  assert.ok(n.issues.some((i) => i.includes("no custom_id")));
});

test("duplicate custom_id -> corrupt", () => {
  const n = run(completed([successItem(CID), successItem(CID)]));
  assert.equal(n.outcome, "corrupt");
  assert.ok(n.issues.some((i) => i.startsWith("duplicate custom_id")));
});

test("unexpected custom_id (not ours) -> corrupt", () => {
  const n = run(completed([successItem("someone-else:1")]));
  assert.equal(n.outcome, "corrupt");
  assert.ok(n.issues.some((i) => i.includes("unexpected custom_id")));
  assert.ok(n.issues.some((i) => i.includes(`expected custom_id ${CID} missing`)));
});

test("missing output (empty content) is a failed item, never ready", () => {
  const n = run(completed([successItem(CID, "   ")]));
  assert.equal(n.outcome, "failed");
  assert.equal(n.items[0]!.error?.code, "missing_output");
  const noChoices = successItem(CID);
  ((noChoices.response as Record<string, unknown>).body as Record<string, unknown>).choices = [];
  assert.equal(run(completed([noChoices])).outcome, "failed");
});

test("unknown extra fields do not break normalisation", () => {
  const n = run(completed([{ ...successItem(CID), brand_new_field: { x: 1 } }], { future_field: [1, 2, 3], usage: { ...BYOK_USAGE, new_metric: 9 } }));
  assert.equal(n.outcome, "ready");
});

test("malformed responses -> corrupt", () => {
  assert.equal(normaliseBatchResult("{not json", expect1).outcome, "corrupt");
  assert.equal(normaliseBatchResult("[]", expect1).outcome, "corrupt");
  assert.equal(run(completed([]), expect1).outcome, "corrupt"); // expected id missing
  assert.equal(run({ ...completed([successItem(CID)]), results: "nope" }).outcome, "corrupt");
  assert.equal(run(completed(["string item" as unknown as Record<string, unknown>])).outcome, "corrupt");
});

test("batch id mismatch -> corrupt", () => {
  const n = run(completed([successItem(CID)], { id: "batch_other" }));
  assert.equal(n.outcome, "corrupt");
  assert.ok(n.issues[0]!.includes("batch id mismatch"));
});

test("completed with results: null -> unavailable (retry later), not corrupt", () => {
  const n = run(batchObject({ status: "completed", results: null }));
  assert.equal(n.outcome, "unavailable");
});

test("request_counts disagreement is a warning", () => {
  const n = run(completed([successItem(CID)], { request_counts: { total: 2, completed: 2, failed: 0 } }));
  assert.equal(n.outcome, "ready");
  assert.ok(n.warnings.some((w) => w.includes("request_counts.total=2")));
});
