import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { ThreadStore } from "../src/chat/store.js";
import { JobRegistry } from "../src/registry.js";
import { dirSizeBytes } from "../src/removal.js";
import { mkJob } from "./fixtures/cleanup.js";
import { rm, tempWorkspace } from "./helpers.js";

const setup = () => {
  const ws = tempWorkspace();
  const root = path.join(ws, ".pi", "batches");
  return { ws, registry: new JobRegistry(root), threads: new ThreadStore(path.join(root, "threads")) };
};

test("removeJob deletes the folder and the listing forgets it", async () => {
  const { ws, registry } = setup();
  try {
    const job = mkJob(registry, { status: "ready" });
    await registry.removeJob(job.localId);
    assert.equal(fs.existsSync(path.join(registry.root, job.localId)), false);
    assert.equal(registry.list().jobs.length, 0);
    assert.deepEqual(fs.readdirSync(registry.root).filter((n) => n.startsWith(".deleting-")), []);
  } finally {
    rm(ws);
  }
});

test("removeJob refuses an active job and leaves it untouched", async () => {
  const { ws, registry } = setup();
  try {
    const job = mkJob(registry, { status: "polling" });
    await assert.rejects(registry.removeJob(job.localId), /active/);
    assert.equal(fs.existsSync(path.join(registry.root, job.localId, "manifest.json")), true);
  } finally {
    rm(ws);
  }
});

test("a leftover .deleting-* folder is invisible and sweepDeleting removes it", () => {
  const { ws, registry } = setup();
  try {
    mkJob(registry);
    const left = path.join(registry.root, ".deleting-B-20261125-ABCD");
    fs.mkdirSync(left);
    fs.writeFileSync(path.join(left, "manifest.json"), "{}");
    assert.equal(registry.list().jobs.length, 1);
    assert.equal(registry.list().unreadable.length, 0);
    assert.equal(registry.sweepDeleting(), 1);
    assert.equal(fs.existsSync(left), false);
  } finally {
    rm(ws);
  }
});

test("removeThread deletes an idle thread and refuses one with a pending turn", async () => {
  const { ws, threads } = setup();
  try {
    const idle = threads.create({ model: "m/x", account: "default" });
    await threads.removeThread(idle.id);
    assert.equal(threads.list().length, 0);
    assert.equal(fs.existsSync(path.join(threads.root, idle.id)), false);
    const busy = threads.create({ model: "m/x", account: "default" });
    threads.update(busy.id, (t) => {
      t.pending = { throughSeq: 1, claimedAt: new Date().toISOString() };
    });
    await assert.rejects(threads.removeThread(busy.id), /in use/);
    assert.equal(threads.list().length, 1);
  } finally {
    rm(ws);
  }
});

test("dirSizeBytes sums nested files and is 0 for a missing folder", () => {
  const ws = tempWorkspace();
  try {
    fs.mkdirSync(path.join(ws, "a", "b"), { recursive: true });
    fs.writeFileSync(path.join(ws, "a", "x.txt"), "12345");
    fs.writeFileSync(path.join(ws, "a", "b", "y.txt"), "123");
    assert.equal(dirSizeBytes(path.join(ws, "a")), 8);
    assert.equal(dirSizeBytes(path.join(ws, "nope")), 0);
  } finally {
    rm(ws);
  }
});
