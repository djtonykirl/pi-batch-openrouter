import assert from "node:assert/strict";
import test from "node:test";
import type { CleanupPlan, CleanupResult } from "../src/cleanup.js";
import { BatchDashboardComponent, type DashboardActions } from "../src/dashboard.js";
import type { JobManifest } from "../src/types.js";

const job = (id: string): JobManifest =>
  ({ localId: id, localStatus: "ready", kind: "goal", objective: `Job ${id}`, model: "m", requestCount: 1, createdAt: "2026-11-20T10:00:00.000Z" }) as unknown as JobManifest;

const plan = (ids: string[], extra: Partial<CleanupPlan> = {}): CleanupPlan => ({
  planId: "p1",
  items: ids.map((id) => ({ kind: "job" as const, id, label: `Job ${id}`, status: "ready", ageDays: 9, bytes: 2048 })),
  skipped: [],
  totalBytes: ids.length * 2048,
  remote: false,
  ...extra,
});

function harness(planFor: (id: string | null) => CleanupPlan) {
  const calls: { planned: Array<string | null>; applied: string[]; renders: number } = { planned: [], applied: [], renders: 0 };
  const actions: DashboardActions = {
    refresh: async () => [],
    cancel: async () => "cancelled",
    planDelete: (id) => {
      calls.planned.push(id);
      return planFor(id);
    },
    applyDelete: async (planId): Promise<CleanupResult> => {
      calls.applied.push(planId);
      return { deleted: [{ kind: "job", id: "B-1", label: "Job B-1", status: "ready", ageDays: 9, bytes: 2048 }], skipped: [], freedBytes: 2048, remote: [] };
    },
    read: () => {},
    inject: () => {},
    close: () => {},
  };
  const comp = new BatchDashboardComponent([job("B-1"), job("B-2")], actions, () => void calls.renders++);
  const text = () => comp.render(120).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  return { comp, calls, text };
}

test("d plans the selected job and shows the list; nothing is deleted until y", async () => {
  const h = harness((id) => plan([id!]));
  h.comp.handleInput("d");
  assert.deepEqual(h.calls.planned, ["B-1"]);
  assert.match(h.text(), /Delete 1 item \(2\.0 KB\)\? This cannot be undone/);
  assert.ok(h.text().includes("B-1"));
  assert.deepEqual(h.calls.applied, []);
  h.comp.handleInput("y");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.calls.applied, ["p1"]);
  assert.match(h.text(), /1 deleted, 0 skipped, 2\.0 KB freed/);
});

test("any key other than y cancels and deletes nothing", () => {
  const h = harness((id) => plan([id!]));
  h.comp.handleInput("d");
  h.comp.handleInput("n");
  assert.deepEqual(h.calls.applied, []);
  assert.match(h.text(), /Cancelled; nothing was deleted/);
  h.comp.handleInput("d");
  h.comp.handleInput("\x1b"); // Esc also cancels instead of closing the dashboard
  assert.deepEqual(h.calls.applied, []);
});

test("x plans the 7 day clean-up (no id) and lists at most 10 items with a count of the rest", () => {
  const ids = Array.from({ length: 13 }, (_, i) => `B-${i}`);
  const h = harness(() => plan(ids));
  h.comp.handleInput("x");
  assert.deepEqual(h.calls.planned, [null]);
  const out = h.text();
  assert.match(out, /Delete 13 items/);
  assert.ok(out.includes("B-9") && !out.includes("B-10"));
  assert.match(out, /…and 3 more/);
});

test("a job that cannot be deleted is explained instead of asking for confirmation", () => {
  const h = harness(() => plan([], { skipped: [{ kind: "job", id: "B-1", reason: "active (polling)" }] }));
  h.comp.handleInput("d");
  assert.match(h.text(), /Nothing deleted: B-1 active \(polling\)/);
  assert.doesNotMatch(h.text(), /This cannot be undone/);
});

test("nothing to clean says so", () => {
  const h = harness(() => plan([]));
  h.comp.handleInput("x");
  assert.match(h.text(), /Nothing to delete/);
});

test("the footer advertises the delete keys", () => {
  const h = harness(() => plan([]));
  assert.match(h.text(), /\[d\] Delete {2}\[x\] Clean up 7d\+/);
});
