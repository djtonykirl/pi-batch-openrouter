import assert from "node:assert/strict";
import test from "node:test";
import { formatIsoShort, fromIsoString, fromUnixMilliseconds, fromUnixSeconds, parseProviderTimestamp } from "../src/time.js";

test("Unix seconds convert to the right ISO date", () => {
  assert.deepEqual(fromUnixSeconds(1_792_074_370), { ok: true, iso: "2026-10-15T14:26:10.000Z" });
});

test("Unix milliseconds convert to the right ISO date", () => {
  assert.deepEqual(fromUnixMilliseconds(1_792_074_019_657), { ok: true, iso: "2026-10-15T14:20:19.657Z" });
});

test("regression: a millisecond value passed as seconds is rejected, not turned into a far-future date", () => {
  // Real value from the pre-Release-1 jobs.json (createdAt was Date.now()).
  assert.deepEqual(fromUnixSeconds(1_792_074_019_657), { ok: false, reason: "implausible" });
});

test("regression: a seconds value passed as milliseconds is rejected, not turned into 1970", () => {
  assert.deepEqual(fromUnixMilliseconds(1_792_074_370), { ok: false, reason: "implausible" });
});

test("ISO strings are normalised to UTC", () => {
  assert.deepEqual(fromIsoString("2026-10-16T12:00:00+02:00"), { ok: true, iso: "2026-10-16T10:00:00.000Z" });
  assert.deepEqual(fromIsoString("not a date"), { ok: false, reason: "unparseable" });
  assert.deepEqual(fromIsoString("2026-13-45T00:00:00Z"), { ok: false, reason: "unparseable" });
});

test("null / undefined / empty are reported as missing", () => {
  for (const v of [null, undefined]) {
    assert.deepEqual(fromUnixSeconds(v), { ok: false, reason: "missing" });
    assert.deepEqual(fromUnixMilliseconds(v), { ok: false, reason: "missing" });
    assert.deepEqual(parseProviderTimestamp(v), { ok: false, reason: "missing" });
  }
  assert.deepEqual(fromIsoString(""), { ok: false, reason: "missing" });
});

test("implausible numbers are rejected", () => {
  for (const v of [0, -1, 42, 1e20, Number.NaN, Number.POSITIVE_INFINITY]) {
    const r = fromUnixSeconds(v);
    assert.equal(r.ok, false, `value ${v}`);
  }
  assert.deepEqual(fromUnixSeconds("1792074370"), { ok: false, reason: "not_a_number" });
});

test("provider timestamps accept documented seconds and defensive ISO", () => {
  assert.equal(parseProviderTimestamp(1_792_074_370).ok, true);
  assert.equal(parseProviderTimestamp("2026-10-14T13:46:10Z").ok, true);
  assert.deepEqual(parseProviderTimestamp(1_792_074_370_000), { ok: false, reason: "implausible" });
});

test("display formatting never fabricates a date", () => {
  assert.equal(formatIsoShort("2026-10-15T14:26:10.000Z"), "2026-10-15 14:26Z");
  assert.equal(formatIsoShort(undefined), "-");
  assert.equal(formatIsoShort("garbage"), "-");
});
