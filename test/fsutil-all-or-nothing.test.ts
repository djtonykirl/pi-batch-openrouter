import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { writeFilesAllOrNothing } from "../src/fsutil.js";
import { rm, tempWorkspace } from "./helpers.js";

test("writeFilesAllOrNothing restores originals and leaves no temp or backup files when a later rename fails", () => {
  const root = tempWorkspace();
  try {
    const a = join(root, "a", "one.txt");
    const b = join(root, "b", "two.txt");
    const c = join(root, "c", "three");
    mkdirSync(join(root, "a"));
    mkdirSync(join(root, "b"));
    mkdirSync(c, { recursive: true });
    writeFileSync(a, "old-a");
    writeFileSync(b, Buffer.from([0, 1, 2, 255]));
    writeFileSync(join(c, "keep.txt"), "keep");
    const oldB = readFileSync(b);

    assert.throws(() =>
      writeFilesAllOrNothing([
        { abs: a, bytes: Buffer.from("new-a") },
        { abs: b, bytes: Buffer.from("new-b") },
        { abs: c, bytes: Buffer.from("new-c") },
      ]),
    );

    assert.equal(readFileSync(a, "utf8"), "old-a");
    assert.ok(readFileSync(b).equals(oldB));
    assert.equal(readFileSync(join(c, "keep.txt"), "utf8"), "keep");
    assert.deepEqual(readdirSync(join(root, "a")), ["one.txt"]);
    assert.deepEqual(readdirSync(join(root, "b")), ["two.txt"]);
    assert.deepEqual(readdirSync(join(root, "c")), ["three"]);
    assert.deepEqual(readdirSync(c), ["keep.txt"]);
  } finally {
    rm(root);
  }
});

test("writeFilesAllOrNothing replaces existing files and creates new ones on success", () => {
  const root = tempWorkspace();
  try {
    const a = join(root, "a.txt");
    const b = join(root, "sub", "b.txt");
    writeFileSync(a, "old");
    writeFilesAllOrNothing([
      { abs: a, bytes: Buffer.from("new-a") },
      { abs: b, bytes: Buffer.from("new-b") },
    ]);
    assert.equal(readFileSync(a, "utf8"), "new-a");
    assert.equal(readFileSync(b, "utf8"), "new-b");
    assert.deepEqual(readdirSync(root).sort(), ["a.txt", "sub"]);
    assert.deepEqual(readdirSync(join(root, "sub")), ["b.txt"]);
  } finally {
    rm(root);
  }
});
