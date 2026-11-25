import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { ThreadStore } from "../src/chat/store.js";
import { CleanupService, parseOlderThan } from "../src/cleanup.js";
import { JobRegistry } from "../src/registry.js";
import { mkJob } from "./fixtures/cleanup.js";
import { rm, tempWorkspace } from "./helpers.js";

const DAY = 86_400_000;
const NOW = new Date("2026-11-25T12:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

function setup(extra: Partial<ConstructorParameters<typeof CleanupService>[0]> = {}) {
  const ws = tempWorkspace();
  const root = path.join(ws, ".pi", "batches");
  const registry = new JobRegistry(root);
  const threads = new ThreadStore(path.join(root, "threads"));
  const svc = new CleanupService({ registry, threads, now: () => NOW, ...extra });
  const exists = (id: string) => fs.existsSync(path.join(root, id)) || fs.existsSync(path.join(root, "threads", id));
  return { ws, root, registry, threads, svc, exists };
}
const ids = (items: Array<{ id: string }>) => items.map((i) => i.id).sort();

test("plan is read-only", () => {
  const { ws, registry, svc, exists } = setup();
  try {
    const j = mkJob(registry);
    const plan = svc.plan({ refs: [j.localId] });
    assert.deepEqual(ids(plan.items), [j.localId]);
    assert.equal(exists(j.localId), true);
  } finally {
    rm(ws);
  }
});

test("a chat ref yields the thread and every job of its turns", () => {
  const { ws, registry, threads, svc } = setup();
  try {
    const t = threads.create({ model: "m/x", account: "default" });
    const a = mkJob(registry, { threadId: t.id });
    const b = mkJob(registry, { threadId: t.id });
    const other = mkJob(registry);
    const plan = svc.plan({ refs: [t.id] });
    assert.deepEqual(ids(plan.items), [t.id, a.localId, b.localId].sort());
    assert.ok(!ids(plan.items).includes(other.localId));
  } finally {
    rm(ws);
  }
});

test("a source job pulls in its retries and syntheses; a retry alone leaves the source", () => {
  const { ws, registry, svc } = setup();
  try {
    const src = mkJob(registry);
    const retry = mkJob(registry, { parentJobId: src.localId });
    const syn = mkJob(registry, { kind: "synthesis", sourceJobId: src.localId });
    const plan = svc.plan({ refs: [src.localId] });
    assert.deepEqual(ids(plan.items), [src.localId, retry.localId, syn.localId].sort());
    assert.equal(plan.items.find((i) => i.id === retry.localId)!.viaClosure, src.localId);
    assert.deepEqual(ids(svc.plan({ refs: [retry.localId] }).items), [retry.localId]);
  } finally {
    rm(ws);
  }
});

test("active jobs and busy threads are skipped, with their whole group", () => {
  const { ws, registry, threads, svc } = setup();
  try {
    const src = mkJob(registry);
    const activeRetry = mkJob(registry, { parentJobId: src.localId, status: "polling" });
    const busy = threads.create({ model: "m/x", account: "default" });
    threads.update(busy.id, (t) => {
      t.pending = { throughSeq: 1, claimedAt: ago(0) };
    });
    const plan = svc.plan({ refs: [src.localId, busy.id] });
    assert.deepEqual(plan.items, []);
    assert.deepEqual(ids(plan.skipped), [src.localId, activeRetry.localId, busy.id].sort());
    assert.match(plan.skipped.find((s) => s.id === src.localId)!.reason, /active/);
  } finally {
    rm(ws);
  }
});

test("a job named twice is listed once", () => {
  const { ws, registry, svc } = setup();
  try {
    const src = mkJob(registry);
    const retry = mkJob(registry, { parentJobId: src.localId });
    const plan = svc.plan({ refs: [src.localId, retry.localId, src.localId] });
    assert.equal(plan.items.length, 2);
  } finally {
    rm(ws);
  }
});

test("older-than filter: only finished items past the cutoff; chat turn jobs go with their thread", () => {
  const { ws, registry, threads, svc } = setup();
  try {
    const old = mkJob(registry, { createdAt: ago(10) });
    const young = mkJob(registry, { createdAt: ago(1) });
    const oldActive = mkJob(registry, { createdAt: ago(10), status: "polling" });
    const t = threads.create({ model: "m/x", account: "default" });
    const turn = mkJob(registry, { threadId: t.id, createdAt: ago(10) });
    // `update` stamps updatedAt itself, so age the thread by writing its snapshot directly.
    const file = path.join(threads.root, t.id, "thread.json");
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), updatedAt: ago(10) }));
    const plan = svc.plan({ olderThanMs: 7 * DAY, include: "all" });
    assert.deepEqual(ids(plan.items), [old.localId, t.id, turn.localId].sort());
    assert.ok(!ids(plan.items).includes(young.localId));
    assert.ok(!ids(plan.items).includes(oldActive.localId));
    assert.deepEqual(ids(svc.plan({ olderThanMs: 7 * DAY, include: "chats" }).items), [t.id, turn.localId].sort());
    assert.deepEqual(ids(svc.plan({ olderThanMs: 7 * DAY, include: "jobs" }).items), [old.localId]);
  } finally {
    rm(ws);
  }
});

test("a corrupt manifest is skipped with a reason, never deleted blindly", () => {
  const { ws, root, registry, svc } = setup();
  try {
    const j = mkJob(registry);
    fs.writeFileSync(path.join(root, j.localId, "manifest.json"), "{ not json");
    const plan = svc.plan({ refs: [j.localId] });
    assert.deepEqual(plan.items, []);
    assert.equal(plan.skipped[0]!.id, j.localId);
    assert.match(plan.skipped[0]!.reason, /unreadable|corrupt/i);
  } finally {
    rm(ws);
  }
});

test("an unresolvable ref throws naming it", () => {
  const { ws, svc } = setup();
  try {
    assert.throws(() => svc.plan({ refs: ["nothing-here"] }), /nothing-here/);
  } finally {
    rm(ws);
  }
});

test("apply deletes the planned list; a chat goes before its jobs", async () => {
  const { ws, registry, threads, svc, exists } = setup();
  try {
    const t = threads.create({ model: "m/x", account: "default" });
    const turn = mkJob(registry, { threadId: t.id });
    const keep = mkJob(registry);
    const res = await svc.apply(svc.plan({ refs: [t.id] }).planId);
    assert.deepEqual(res.deleted.map((d) => d.kind), ["thread", "job"]);
    assert.equal(exists(t.id), false);
    assert.equal(exists(turn.localId), false);
    assert.equal(exists(keep.localId), true);
    assert.ok(res.freedBytes > 0);
  } finally {
    rm(ws);
  }
});

test("a job that becomes active between plan and apply is skipped, the rest still go", async () => {
  const { ws, registry, svc, exists } = setup();
  try {
    const a = mkJob(registry);
    const b = mkJob(registry);
    const plan = svc.plan({ refs: [a.localId, b.localId] });
    registry.update(b.localId, (u) => {
      u.manifest.localStatus = "polling";
    });
    const res = await svc.apply(plan.planId);
    assert.deepEqual(res.deleted.map((d) => d.id), [a.localId]);
    assert.deepEqual(res.skipped.map((s) => s.id), [b.localId]);
    assert.equal(exists(b.localId), true);
  } finally {
    rm(ws);
  }
});

test("apply with an unknown or expired plan id asks to re-plan", async () => {
  let now = NOW;
  const { ws, registry, svc } = setup({ now: () => now });
  try {
    await assert.rejects(svc.apply("nope"), /re-plan/);
    const j = mkJob(registry);
    const plan = svc.plan({ refs: [j.localId] });
    now = new Date(NOW.getTime() + 11 * 60_000);
    await assert.rejects(svc.apply(plan.planId), /re-plan/);
  } finally {
    rm(ws);
  }
});

test("a plan can be applied only once", async () => {
  const { ws, registry, svc } = setup();
  try {
    const plan = svc.plan({ refs: [mkJob(registry).localId] });
    await svc.apply(plan.planId);
    await assert.rejects(svc.apply(plan.planId), /re-plan/);
  } finally {
    rm(ws);
  }
});

test("planning leaves .deleting-* leftovers alone; apply sweeps them", async () => {
  const { ws, root, registry, svc } = setup();
  try {
    const j = mkJob(registry, { createdAt: ago(1) });
    const left = path.join(root, ".deleting-B-20261101-ABCD");
    fs.mkdirSync(left);
    const plan = svc.plan({ olderThanMs: 0, include: "all" });
    assert.equal(fs.existsSync(left), true, "planning must stay read-only");
    await svc.apply(plan.planId);
    assert.equal(fs.existsSync(left), false);
    assert.deepEqual(ids(plan.items), [j.localId]);
  } finally {
    rm(ws);
  }
});

test("parseOlderThan", () => {
  assert.equal(parseOlderThan("7d"), 604_800_000);
  assert.equal(parseOlderThan("12h"), 43_200_000);
  assert.equal(parseOlderThan("0"), 0);
  assert.throws(() => parseOlderThan("soon"), /older-than/);
});

test("remote: a finished job with a provider batch is deleted there once; a failure never undoes the local delete", async () => {
  const calls: string[] = [];
  const { ws, registry, svc, exists } = setup({
    remoteDelete: async (job) => {
      calls.push(job.localId);
      if (job.providerBatchId === "batch-bad") throw new Error("HTTP 500");
    },
  });
  try {
    const ok = mkJob(registry, { providerBatchId: "batch-ok" });
    const bad = mkJob(registry, { providerBatchId: "batch-bad" });
    const res = await svc.apply(svc.plan({ refs: [ok.localId, bad.localId] }, { remote: true }).planId);
    assert.deepEqual(calls.sort(), [ok.localId, bad.localId].sort());
    assert.equal(exists(ok.localId) || exists(bad.localId), false);
    assert.deepEqual(res.remote.map((r) => [r.id, r.ok]).sort(), [[ok.localId, true], [bad.localId, false]].sort());
    assert.match(res.remote.find((r) => !r.ok)!.error!, /HTTP 500/);
  } finally {
    rm(ws);
  }
});

test("remote: jobs that never reached OpenRouter are not sent, and nothing is called without remote", async () => {
  const calls: string[] = [];
  const { ws, registry, svc } = setup({ remoteDelete: async (job) => void calls.push(job.localId) });
  try {
    const never = mkJob(registry, { status: "failed" }); // no providerBatchId: never reached OpenRouter
    const reached = mkJob(registry, { providerBatchId: "batch-1" });
    await svc.apply(svc.plan({ refs: [never.localId], }, { remote: true }).planId);
    assert.deepEqual(calls, []);
    await svc.apply(svc.plan({ refs: [reached.localId] }).planId); // remote not requested
    assert.deepEqual(calls, []);
  } finally {
    rm(ws);
  }
});

test("a chat turn job on its own is refused (delete the chat); naming the chat and its job together is fine; an orphaned turn job can go", () => {
  const { ws, registry, threads, svc } = setup();
  try {
    const t = threads.create({ model: "m/x", account: "default" });
    const turn = mkJob(registry, { threadId: t.id });
    const alone = svc.plan({ refs: [turn.localId] });
    assert.deepEqual(alone.items, []);
    assert.match(alone.skipped[0]!.reason, new RegExp(`belongs to chat ${t.id}`));
    assert.deepEqual(ids(svc.plan({ refs: [turn.localId, t.id] }).items), [t.id, turn.localId].sort());
    const orphan = mkJob(registry, { threadId: "T-20260101-GONE" });
    assert.deepEqual(ids(svc.plan({ refs: [orphan.localId] }).items), [orphan.localId]);
  } finally {
    rm(ws);
  }
});

test("natural references: latest picks the newest finished job; running jobs and chat turns are never matched", () => {
  const { ws, registry, threads, svc } = setup();
  try {
    const older = mkJob(registry, { createdAt: ago(5) });
    const newest = mkJob(registry, { createdAt: ago(1) });
    mkJob(registry, { createdAt: ago(0), status: "polling" });
    const t = threads.create({ model: "m/x", account: "default" });
    mkJob(registry, { threadId: t.id, createdAt: ago(0) });
    assert.deepEqual(ids(svc.plan({ refs: ["latest"] }).items), [newest.localId]);
    assert.ok(!ids(svc.plan({ refs: ["latest"] }).items).includes(older.localId));
  } finally {
    rm(ws);
  }
});

test("an ambiguous description is refused with the candidates, not guessed", () => {
  const { ws, registry, svc } = setup();
  try {
    mkJob(registry, { createdAt: ago(3) });
    mkJob(registry, { createdAt: ago(3) });
    assert.throws(() => svc.plan({ refs: ["the finished job"] }), /more than one|Which one/);
  } finally {
    rm(ws);
  }
});

test("naming a busy chat together with its turn job deletes neither", () => {
  const { ws, registry, threads, svc } = setup();
  try {
    const t = threads.create({ model: "m/x", account: "default" });
    const turn = mkJob(registry, { threadId: t.id });
    threads.update(t.id, (s) => {
      s.pending = { throughSeq: 1, claimedAt: ago(0) };
    });
    for (const refs of [[t.id, turn.localId], [turn.localId, t.id]]) {
      const plan = svc.plan({ refs });
      assert.deepEqual(plan.items, []);
      assert.deepEqual(ids(plan.skipped), [t.id, turn.localId].sort());
    }
  } finally {
    rm(ws);
  }
});

test("a job whose group is blocked stays out even when it is also named on its own", () => {
  const { ws, registry, svc } = setup();
  try {
    const a = mkJob(registry);
    const b = mkJob(registry, { parentJobId: a.localId });
    const c = mkJob(registry, { parentJobId: a.localId, status: "polling" });
    const plan = svc.plan({ refs: [a.localId, b.localId] });
    assert.deepEqual(plan.items, []);
    assert.deepEqual(ids(plan.skipped), [a.localId, b.localId, c.localId].sort());
  } finally {
    rm(ws);
  }
});

test("apply deletes a chat before its jobs: a chat that became busy keeps its jobs too", async () => {
  const { ws, registry, threads, svc, exists } = setup();
  try {
    const t = threads.create({ model: "m/x", account: "default" });
    const turn = mkJob(registry, { threadId: t.id });
    const plan = svc.plan({ refs: [t.id] });
    threads.update(t.id, (s) => {
      s.pending = { throughSeq: 1, claimedAt: ago(0) };
    });
    const res = await svc.apply(plan.planId);
    assert.deepEqual(res.deleted, []);
    assert.equal(exists(t.id), true);
    assert.equal(exists(turn.localId), true);
    assert.match(res.skipped.find((s) => s.id === turn.localId)!.reason, /chat/);
  } finally {
    rm(ws);
  }
});

test("a short ref matching both a job and a chat is ambiguous, not silently the job", () => {
  const { ws, registry, threads, svc } = setup();
  try {
    const j = mkJob(registry, { createdAt: ago(3) });
    const t = threads.create({ model: "m/x", account: "default" });
    const tail = j.localId.slice(-4);
    threads.update(t.id, (s) => {
      s.title = tail;
    });
    assert.throws(() => svc.plan({ refs: [tail] }), /ambiguous/);
    assert.deepEqual(ids(svc.plan({ refs: [j.localId] }).items), [j.localId]);
  } finally {
    rm(ws);
  }
});

test("a clean-up reports unreadable job folders instead of silently leaving them", () => {
  const { ws, root, registry, svc } = setup();
  try {
    const bad = mkJob(registry, { createdAt: ago(10) });
    fs.writeFileSync(path.join(root, bad.localId, "manifest.json"), "{ not json");
    const plan = svc.plan({ olderThanMs: 0, include: "all" });
    assert.deepEqual(plan.items, []);
    assert.equal(plan.skipped[0]!.id, bad.localId);
    assert.match(plan.skipped[0]!.reason, /unreadable/);
  } finally {
    rm(ws);
  }
});
