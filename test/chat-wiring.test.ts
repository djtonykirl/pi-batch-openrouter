import assert from "node:assert/strict";
import test from "node:test";
import { BatchPoller, badgeText } from "../src/poller.js";
import type { BatchService } from "../src/service.js";
import { visibleToModel } from "../src/tools.js";
import type { JobManifest } from "../src/types.js";

const job = (localId: string, kind: string, localStatus = "submitted"): JobManifest => ({ localId, kind, localStatus }) as unknown as JobManifest;

test("visibleToModel drops chat jobs and keeps others", () => {
  const jobs = [job("B-1", "goal"), job("B-2", "chat"), job("B-3", "workflow")];
  assert.deepEqual(visibleToModel(jobs).map((j) => j.localId), ["B-1", "B-3"]);
});

test("poller onTick runs after a pass and a throwing onTick does not stop scheduling", async () => {
  const service = { jobsNeedingReconcile: () => [], registry: { list: () => ({ jobs: [] }) } } as unknown as BatchService;
  let ticks = 0;
  const poller = new BatchPoller(
    () => service,
    () => true,
    undefined,
    async () => {
      ticks++;
      throw new Error("boom");
    },
  );
  await assert.doesNotReject(poller.checkNow());
  await assert.doesNotReject(poller.checkNow());
  assert.equal(ticks, 2);
});

test("badge still counts active chat jobs", () => {
  assert.equal(badgeText([job("B-1", "chat", "submitted")]), "📦 Batch: 1 active");
});
