import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { ThreadStore } from "../src/chat/store.js";
import { CleanupService } from "../src/cleanup.js";
import { runClean, runDelete } from "../src/cleanup-commands.js";
import { JobRegistry } from "../src/registry.js";
import { mkJob } from "./fixtures/cleanup.js";
import { rm, tempWorkspace } from "./helpers.js";

const DAY = 86_400_000;

function setup() {
  const ws = tempWorkspace();
  const root = path.join(ws, ".pi", "batches");
  const registry = new JobRegistry(root);
  const threads = new ThreadStore(path.join(root, "threads"));
  const cleanup = new CleanupService({ registry, threads });
  const asked: Array<{ title: string; body: string }> = [];
  const confirmWith = (answer: boolean) => async (title: string, body: string) => {
    asked.push({ title, body });
    return answer;
  };
  return { ws, root, registry, threads, cleanup, asked, confirmWith, exists: (id: string) => fs.existsSync(path.join(root, id)) };
}
const old = () => new Date(Date.now() - 10 * DAY).toISOString();

test("/batch delete shows the plan, asks once, deletes on yes", async () => {
  const s = setup();
  try {
    const j = mkJob(s.registry);
    const r = await runDelete({ cleanup: s.cleanup, confirm: s.confirmWith(true) }, [j.localId]);
    assert.equal(s.asked.length, 1);
    assert.ok(s.asked[0]!.body.includes(j.localId));
    assert.equal(s.exists(j.localId), false);
    assert.match(r.text, /1 deleted, 0 skipped, .+ freed/);
  } finally {
    rm(s.ws);
  }
});

test("/batch delete deletes nothing on no", async () => {
  const s = setup();
  try {
    const j = mkJob(s.registry);
    const r = await runDelete({ cleanup: s.cleanup, confirm: s.confirmWith(false) }, [j.localId]);
    assert.equal(s.exists(j.localId), true);
    assert.match(r.text, /Nothing was deleted/);
  } finally {
    rm(s.ws);
  }
});

test("--yes skips the question", async () => {
  const s = setup();
  try {
    const j = mkJob(s.registry);
    await runDelete({ cleanup: s.cleanup, confirm: s.confirmWith(false) }, [j.localId, "--yes"]);
    assert.equal(s.asked.length, 0);
    assert.equal(s.exists(j.localId), false);
  } finally {
    rm(s.ws);
  }
});

test("/batch delete without a ref shows usage; an unknown ref is an error naming it", async () => {
  const s = setup();
  try {
    await assert.rejects(runDelete({ cleanup: s.cleanup, confirm: s.confirmWith(true) }, []), /Usage: \/batch delete/);
    await assert.rejects(runDelete({ cleanup: s.cleanup, confirm: s.confirmWith(true) }, ["ghost"]), /ghost/);
  } finally {
    rm(s.ws);
  }
});

test("/batch clean defaults to 7 days and lists only older finished items", async () => {
  const s = setup();
  try {
    const oldJob = mkJob(s.registry, { createdAt: old() });
    const young = mkJob(s.registry);
    await runClean({ cleanup: s.cleanup, confirm: s.confirmWith(true) }, []);
    assert.equal(s.exists(oldJob.localId), false);
    assert.equal(s.exists(young.localId), true);
  } finally {
    rm(s.ws);
  }
});

test("/batch clean --older-than 0 --chats limits to threads", async () => {
  const s = setup();
  try {
    const j = mkJob(s.registry);
    const t = s.threads.create({ model: "m/x", account: "default" });
    await runClean({ cleanup: s.cleanup, confirm: s.confirmWith(true) }, ["--older-than", "0", "--chats"]);
    assert.equal(s.exists(j.localId), true);
    assert.equal(fs.existsSync(path.join(s.threads.root, t.id)), false);
  } finally {
    rm(s.ws);
  }
});

test("/batch clean rejects a bad --older-than and the --chats --jobs combination", async () => {
  const s = setup();
  try {
    await assert.rejects(runClean({ cleanup: s.cleanup, confirm: s.confirmWith(true) }, ["--older-than", "soon"]), /--older-than/);
    await assert.rejects(runClean({ cleanup: s.cleanup, confirm: s.confirmWith(true) }, ["--chats", "--jobs"]), /either --chats or --jobs/);
  } finally {
    rm(s.ws);
  }
});

test("/batch clean with nothing to delete says so and does not ask", async () => {
  const s = setup();
  try {
    const r = await runClean({ cleanup: s.cleanup, confirm: s.confirmWith(true) }, []);
    assert.equal(s.asked.length, 0);
    assert.match(r.text, /Nothing to delete/);
  } finally {
    rm(s.ws);
  }
});
