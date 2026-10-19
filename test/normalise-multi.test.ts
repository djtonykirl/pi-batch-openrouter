import assert from "node:assert/strict";
import test from "node:test";
import { normaliseBatchResult } from "../src/openrouter/normalise-result.js";
import { BYOK_USAGE, completed, failedItem, successItem } from "./fixtures/openrouter.js";

const L = "B-20261017-A7C2";
const IDS = [1, 2, 3].map((n) => `${L}_request-00${n}`);
const expect3 = { localJobId: L, providerBatchId: "batch_123", expectedCustomIds: IDS };
const run = (obj: unknown, e: Parameters<typeof normaliseBatchResult>[1] = expect3) => normaliseBatchResult(JSON.stringify(obj), e);
const ok = (i: number) => successItem(IDS[i]!, `text for ${i + 1}`);

function corruptItem(customId: string): Record<string, unknown> {
  const item = successItem(customId);
  (item.response as Record<string, unknown>).body = "not an object";
  return item;
}

for (const [name, order] of [
  ["submission order", [0, 1, 2]],
  ["reverse order", [2, 1, 0]],
  ["arbitrary order", [1, 2, 0]],
] as const) {
  test(`results in ${name} correlate by custom_id; items come back in submission order`, () => {
    const n = run(completed(order.map(ok)));
    assert.equal(n.outcome, "ready");
    assert.deepEqual(n.items.map((i) => i.customId), IDS);
    assert.deepEqual(n.items.map((i) => i.text), ["text for 1", "text for 2", "text for 3"]);
    // Provider position is kept only as evidence.
    assert.deepEqual(n.items.map((i) => i.resultIndex), IDS.map((_, k) => order.indexOf(k as 0 | 1 | 2)));
  });
}

test("outcome: some completed, some failed -> partial", () => {
  const n = run(completed([ok(0), failedItem(IDS[1]!), ok(2)]));
  assert.equal(n.outcome, "partial");
  assert.deepEqual(n.items.map((i) => i.status), ["completed", "failed", "completed"]);
});

test("outcome: some completed, one malformed item -> partial, other items preserved", () => {
  const n = run(completed([ok(0), corruptItem(IDS[1]!), ok(2)]));
  assert.equal(n.outcome, "partial");
  assert.equal(n.items[1]!.status, "corrupt");
  assert.equal(n.items[1]!.validation.valid, false);
  assert.equal(n.items[0]!.text, "text for 1");
  assert.equal(n.items[2]!.text, "text for 3");
});

test("outcome: all failed -> failed; all individually corrupt -> corrupt", () => {
  assert.equal(run(completed(IDS.map((id) => failedItem(id)))).outcome, "failed");
  const allCorrupt = run(completed(IDS.map(corruptItem)));
  assert.equal(allCorrupt.outcome, "corrupt");
  assert.deepEqual(allCorrupt.issues, []); // correlation was fine; every item was unusable
});

test("outcome: failed + missing with nothing usable -> failed", () => {
  assert.equal(run(completed([failedItem(IDS[0]!)])).outcome, "failed");
});

test("outcome: missing expected custom_id -> item 'missing', batch partial (never ready)", () => {
  const n = run(completed([ok(2), ok(0)]));
  assert.equal(n.outcome, "partial");
  assert.deepEqual(n.missingCustomIds, [IDS[1]]);
  assert.equal(n.items[1]!.status, "missing");
  assert.equal(n.items[1]!.raw, undefined);
});

test("outcome: empty results array for a non-empty batch -> corrupt", () => {
  const n = run(completed([]));
  assert.equal(n.outcome, "corrupt");
  assert.ok(n.issues.some((i) => i.includes("empty results array")));
});

test("outcome: duplicate returned custom_id -> corrupt, duplicate preserved as evidence", () => {
  const n = run(completed([ok(0), ok(1), ok(2), successItem(IDS[1]!, "second copy")]));
  assert.equal(n.outcome, "corrupt");
  assert.deepEqual(n.unexpected.map((u) => [u.customId, u.reason, u.resultIndex]), [[IDS[1], "duplicate_custom_id", 3]]);
  assert.match(JSON.stringify(n.unexpected[0]!.raw), /second copy/);
});

test("outcome: unknown returned custom_id -> corrupt with explicit validation issue", () => {
  const n = run(completed([ok(0), ok(1), ok(2), successItem(`${L}_request-004`)]));
  assert.equal(n.outcome, "corrupt");
  assert.ok(n.issues.includes(`unexpected custom_id ${L}_request-004`));
});

test("outcome: malformed top level -> corrupt; provider 'completed' is never enough for ready", () => {
  assert.equal(normaliseBatchResult("{", expect3).outcome, "corrupt");
  assert.equal(run({ ...completed([ok(0), ok(1), ok(2)]), results: { nope: 1 } }).outcome, "corrupt");
  assert.equal(run(completed([ok(0), ok(1), ok(2), "junk" as unknown as Record<string, unknown>])).outcome, "corrupt");
});

test("item usage is taken from each item's response body only when present; never apportioned", () => {
  const withUsage = successItem(IDS[0]!, "a", { usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14, cost: 0.0001 } });
  const n = run(completed([withUsage, ok(1), ok(2)], { usage: BYOK_USAGE }));
  assert.deepEqual(n.items[0]!.usage, { inputTokens: 11, outputTokens: 3, totalTokens: 14, cost: 0.0001 });
  assert.equal(n.items[1]!.usage, undefined);
  assert.equal(n.items[2]!.usage, undefined);
  assert.equal(n.usage?.isByok, true);
  assert.equal(n.usage?.upstreamInferenceCost, 0.0004);
});

test("absent batch usage stays absent", () => {
  const n = run(completed([ok(0), ok(1), ok(2)], { usage: null }));
  assert.equal(n.usage, undefined);
  assert.ok(n.items.every((i) => i.usage === undefined));
});

test("format=json: valid object ok; fenced object ok with warning; prose -> corrupt item", () => {
  const e = { ...expect3, format: "json" as const };
  const n = run(completed([successItem(IDS[0]!, '{"a":1}'), successItem(IDS[1]!, '```json\n{"b":2}\n```'), successItem(IDS[2]!, "Sure! here it is")]), e);
  assert.deepEqual(n.items.map((i) => i.status), ["completed", "completed", "corrupt"]);
  assert.ok(n.items[1]!.validation.warnings.some((w) => w.includes("code fence")));
  assert.equal(n.items[2]!.error?.code, "invalid_json");
  assert.equal(n.outcome, "partial");
});

test("finish_reason length is a validation warning, not a silent pass", () => {
  const item = successItem(IDS[0]!, "cut off");
  (((item.response as Record<string, unknown>).body as Record<string, unknown>).choices as Array<Record<string, unknown>>)[0]!.finish_reason = "length";
  const n = run(completed([item, ok(1), ok(2)]));
  assert.equal(n.outcome, "ready");
  assert.deepEqual(n.items[0]!.validation.warnings, ["output may be truncated (finish_reason: length)"]);
});
