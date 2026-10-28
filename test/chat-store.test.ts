import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { ThreadBusyError, ThreadNotFoundError, ThreadStore } from "../src/chat/store.js";
import { acquireLock } from "../src/fsutil.js";
import { isThreadId } from "../src/ids.js";
import { rm, tempWorkspace } from "./helpers.js";

describe("ThreadStore", () => {
  let dir: string;
  let store: ThreadStore;
  beforeEach(() => {
    dir = tempWorkspace();
    store = new ThreadStore(path.join(dir, "threads"));
  });
  afterEach(() => rm(dir));

  const mk = () => store.create({ model: "m/x", account: "default" });
  const sleep = (ms: number) => {
    const end = Date.now() + ms;
    while (Date.now() < end);
  };

  it("create then read round-trips", () => {
    const t = mk();
    const r = store.read(t.id);
    assert.deepEqual(r, t);
    assert.equal(r.title, "(untitled)");
    assert.equal(r.titleLocked, false);
    assert.equal(r.nextSeq, 1);
    assert.ok(isThreadId(r.id));
  });

  it("update allocates sequential seqs and never rewrites", () => {
    const t = mk();
    const file = path.join(store.root, t.id, "transcript.jsonl");
    const e1 = store.update(t.id, (_s, append) => append({ type: "user", text: "hi" }));
    const after1 = fs.readFileSync(file, "utf8");
    const e2 = store.update(t.id, (_s, append) => append({ type: "assistant", text: "yo", model: "m/x", jobId: "B-1" }));
    const after2 = fs.readFileSync(file, "utf8");
    assert.equal(e1.seq, 1);
    assert.equal(e2.seq, 2);
    assert.ok(after2.startsWith(after1));
    assert.equal(store.read(t.id).nextSeq, 3);
    assert.equal(store.transcript(t.id).entries.length, 2);
  });

  it("list orders by updatedAt desc", () => {
    const a = mk();
    sleep(5);
    const b = mk();
    sleep(5);
    store.update(a.id, (_s, append) => append({ type: "status", text: "x" }));
    assert.deepEqual(
      store.list().map((t) => t.id),
      [a.id, b.id],
    );
  });

  it("resolve by id, suffix and title; ambiguity and unknown", () => {
    const a = mk();
    assert.equal(store.resolve(a.id), a.id);
    assert.equal(store.resolve(a.id.slice(-4).toLowerCase()), a.id);
    store.update(a.id, (s) => {
      s.title = "My Plan";
    });
    assert.equal(store.resolve("my plan"), a.id);
    const b = mk();
    store.update(b.id, (s) => {
      s.title = "My Plan";
    });
    assert.throws(() => store.resolve("my plan"), /ambiguous/);
    store.update(b.id, (s) => {
      s.title = a.id.slice(-4);
    });
    assert.throws(() => store.resolve(a.id.slice(-4)), /ambiguous/);
    assert.throws(() => store.resolve("nope-nothing"), ThreadNotFoundError);
  });

  it("update throws ThreadBusyError while another holder has the lock", () => {
    const t = mk();
    let ran = false;
    const tFile = path.join(store.root, t.id, "transcript.jsonl");
    const sFile = path.join(store.root, t.id, "thread.json");
    store.update(t.id, (_s, append) => append({ type: "user", text: "hi" }));
    const before = [fs.readFileSync(tFile), fs.readFileSync(sFile)];
    const lock = acquireLock(path.join(store.root, t.id, "thread.lock"));
    try {
      assert.throws(
        () =>
          store.update(
            t.id,
            () => {
              ran = true;
            },
            100,
          ),
        ThreadBusyError,
      );
    } finally {
      lock.release();
    }
    assert.equal(ran, false);
    assert.ok(fs.readFileSync(tFile).equals(before[0]!));
    assert.ok(fs.readFileSync(sFile).equals(before[1]!));
  });

  it("a non-timeout lock error is not converted to ThreadBusyError", () => {
    const t = mk();
    const orig = fs.openSync;
    const m = mock.method(fs, "openSync", ((...a: Parameters<typeof fs.openSync>) => {
      if (String(a[0]).endsWith("thread.lock")) throw Object.assign(new Error("denied"), { code: "EPERM" });
      return orig(...a);
    }) as typeof fs.openSync);
    syncBuiltinESMExports();
    try {
      assert.throws(
        () => store.update(t.id, () => {}, 100),
        (e: unknown) => !(e instanceof ThreadBusyError) && /denied/.test((e as Error).message),
      );
    } finally {
      m.mock.restore();
      syncBuiltinESMExports();
    }
  });

  it("seqs stay unique after a crash between append and snapshot", () => {
    const t = mk();
    const file = path.join(store.root, t.id, "transcript.jsonl");
    fs.appendFileSync(file, JSON.stringify({ seq: 1, at: new Date().toISOString(), type: "user", text: "orphan" }) + "\n");
    const e = store.update(t.id, (_s, append) => append({ type: "user", text: "next" }));
    assert.equal(e.seq, 2);
    assert.deepEqual(
      store.transcript(t.id).entries.map((x) => x.seq),
      [1, 2],
    );
    assert.equal(store.read(t.id).nextSeq, 3);
  });

  it("transcript counts malformed lines", () => {
    const t = mk();
    store.update(t.id, (_s, append) => append({ type: "user", text: "hi" }));
    fs.appendFileSync(path.join(store.root, t.id, "transcript.jsonl"), "garbage{\n");
    const r = store.transcript(t.id);
    assert.equal(r.malformedLines, 1);
    assert.equal(r.entries.length, 1);
  });
});
