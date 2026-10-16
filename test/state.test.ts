import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTIVE_STATUSES,
  IllegalTransitionError,
  LOCAL_STATUSES,
  TERMINAL_STATUSES,
  allowedTransitions,
  assertTransition,
  canTransition,
  type LocalStatus,
} from "../src/state.js";

const VALID: Array<[LocalStatus, LocalStatus]> = [
  ["draft", "previewed"],
  ["previewed", "submitting"],
  ["previewed", "cancelled"],
  ["submitting", "submitted"],
  ["submitting", "failed"],
  ["submitted", "polling"],
  ["submitted", "cancel_requested"],
  ["submitted", "failed"],
  ["polling", "polling"],
  ["polling", "provider_completed"],
  ["polling", "failed"],
  ["polling", "expired"],
  ["polling", "cancel_requested"],
  ["provider_completed", "retrieving"],
  ["retrieving", "ready"],
  ["retrieving", "partial"],
  ["retrieving", "corrupt"],
  ["retrieving", "provider_completed"],
  ["cancel_requested", "cancelled"],
  ["cancel_requested", "provider_completed"],
  ["cancel_requested", "failed"],
];

test("all documented valid transitions are allowed", () => {
  for (const [from, to] of VALID) assert.ok(canTransition(from, to), `${from} -> ${to}`);
});

test("invalid transitions throw IllegalTransitionError", () => {
  const invalid: Array<[LocalStatus, LocalStatus]> = [
    ["draft", "submitted"],
    ["previewed", "ready"],
    ["submitting", "polling"],
    ["polling", "ready"], // must go through provider_completed -> retrieving
    ["provider_completed", "ready"],
    ["cancel_requested", "ready"],
    ["ready", "polling"],
    ["cancelled", "ready"],
  ];
  for (const [from, to] of invalid) {
    assert.equal(canTransition(from, to), false, `${from} -> ${to}`);
    assert.throws(() => assertTransition(from, to, "B-20261016-AAAA"), IllegalTransitionError);
  }
});

test("terminal states have no outgoing transitions", () => {
  assert.deepEqual([...TERMINAL_STATUSES].sort(), ["cancelled", "corrupt", "expired", "failed", "partial", "ready"]);
  for (const s of TERMINAL_STATUSES) {
    for (const to of LOCAL_STATUSES) assert.equal(canTransition(s, to), false, `${s} -> ${to}`);
  }
});

test("cancel/completion race: a cancel request can still end in a completed result", () => {
  const path: LocalStatus[] = ["polling", "cancel_requested", "provider_completed", "retrieving", "ready"];
  for (let i = 0; i < path.length - 1; i++) assertTransition(path[i]!, path[i + 1]!);
});

test("every state is reachable from draft", () => {
  const seen = new Set<LocalStatus>(["draft"]);
  const queue: LocalStatus[] = ["draft"];
  while (queue.length) for (const n of allowedTransitions(queue.shift()!)) if (!seen.has(n)) (seen.add(n), queue.push(n));
  assert.deepEqual([...seen].sort(), [...LOCAL_STATUSES].sort());
});

test("active and terminal sets are disjoint", () => {
  for (const s of ACTIVE_STATUSES) assert.equal(TERMINAL_STATUSES.has(s), false);
});
