import assert from "node:assert/strict";
import test from "node:test";
import { checkBundle, inboxPath } from "../src/metadata/bundle.js";
import { sha256Hex } from "../src/fsutil.js";

const TABLES = Buffer.from('{"a":1}\n{"a":2}\n', "utf8");
const CONTEXT = Buffer.from("# Context\nsecret-context-body\n", "utf8");

function manifestFor(tables: Buffer, context: Buffer, over: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      run_id: "r1",
      domain_prefix: "PNPT",
      contract_version: "1",
      files: [
        { path: "out/tables.jsonl", sha256: sha256Hex(tables), bytes: tables.length },
        { path: "context.md", sha256: sha256Hex(context), bytes: context.length },
      ],
      table_count: 2,
      created_ts: "2026-10-29T00:00:00Z",
      ...over,
    }),
    "utf8",
  );
}

function bundle(over: Record<string, unknown> = {}) {
  return [
    { name: "tables.jsonl", bytes: TABLES },
    { name: "context.md", bytes: CONTEXT },
    { name: "manifest.json", bytes: manifestFor(TABLES, CONTEXT, over) },
  ];
}

const OPTS = { maxBytes: 1_000_000 };

test("valid bundle is accepted with exact dest and writes", () => {
  const r = checkBundle(bundle(), OPTS);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.dest, "metadata/pnpt/r1");
  assert.equal(r.manifest.run_id, "r1");
  assert.deepEqual(r.writes.map((w) => w.relPath), [
    "metadata/pnpt/r1/tables.jsonl",
    "metadata/pnpt/r1/context.md",
    "metadata/pnpt/r1/manifest.json",
  ]);
  assert.ok(r.writes[0]!.bytes.equals(TABLES));
  assert.ok(r.writes[1]!.bytes.equals(CONTEXT));
});

test("one-byte change in context.md is refused, naming the file without content", () => {
  const changed = Buffer.from(CONTEXT);
  changed[3] = changed[3]! ^ 1;
  const files = bundle();
  files[1] = { name: "context.md", bytes: changed };
  const r = checkBundle(files, OPTS);
  assert.ok(!r.ok);
  if (r.ok) return;
  assert.ok(r.problems.some((p) => p.includes("context.md")));
  assert.ok(!r.problems.join("\n").includes("secret-context-body"));
});

test("CRLF re-encoding of tables.jsonl is a mismatch", () => {
  const files = bundle();
  files[0] = { name: "tables.jsonl", bytes: Buffer.from(TABLES.toString("utf8").replace(/\n/g, "\r\n")) };
  const r = checkBundle(files, OPTS);
  assert.ok(!r.ok);
  if (r.ok) return;
  assert.ok(r.problems.some((p) => p.includes("tables.jsonl")));
});

test("missing context.md is refused", () => {
  const r = checkBundle(bundle().filter((f) => f.name !== "context.md"), OPTS);
  assert.ok(!r.ok);
  if (r.ok) return;
  assert.ok(r.problems.some((p) => p.includes("context.md")));
});

test("extra file is refused", () => {
  const r = checkBundle([...bundle(), { name: "extra.txt", bytes: Buffer.from("x") }], OPTS);
  assert.ok(!r.ok);
  if (r.ok) return;
  assert.ok(r.problems.some((p) => p.includes("extra.txt")));
});

test("crafted run_id and domain_prefix are refused", () => {
  for (const over of [{ run_id: "../x" }, { run_id: "a/b" }, { domain_prefix: "PNPT_" }, { domain_prefix: "pn pt" }, { domain_prefix: "pnpt" }, { domain_prefix: "PNPT/../" }]) {
    const r = checkBundle(bundle(over), OPTS);
    assert.ok(!r.ok, JSON.stringify(over));
  }
});

test("file larger than maxBytes is refused", () => {
  const r = checkBundle(bundle(), { maxBytes: 10 });
  assert.ok(!r.ok);
});

test("malformed manifest is refused without echoing content", () => {
  const files = bundle();
  files[2] = { name: "manifest.json", bytes: Buffer.from("not-json-SECRET") };
  const r = checkBundle(files, OPTS);
  assert.ok(!r.ok);
  if (r.ok) return;
  assert.ok(!r.problems.join("\n").includes("SECRET"));
});

test("inboxPath builds the Volumes path", () => {
  const r = checkBundle(bundle(), OPTS);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(
    inboxPath(r.manifest, "uc_dev_global_rnd_mdip_01"),
    "/Volumes/uc_dev_global_rnd_mdip_01/lighthouse_governance/metadata/inbox/PNPT/r1/approved.jsonl",
  );
});
