import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { parseArgs, tokenize } from "../src/args.js";
import { DEFAULT_CONFIG, loadConfig, projectConfigPath, saveConfigUpdate, validateConfig } from "../src/config.js";
import { atomicWriteFile, isInside, tryAcquireLock, writeOnce } from "../src/fsutil.js";
import { customIdFor, isLocalJobId, newLocalJobId } from "../src/ids.js";
import { buildSubmitBody } from "../src/openrouter/types.js";
import { rm, tempWorkspace, writeFiles } from "./helpers.js";

test("tokenizer keeps Windows backslashes and quoted spaces", () => {
  assert.deepEqual(tokenize(`ask --file src\\auth.ts --file "C:\\My Repo\\x.ts" "Review the auth design"`), [
    "ask", "--file", "src\\auth.ts", "--file", "C:\\My Repo\\x.ts", "Review the auth design",
  ]);
  assert.deepEqual(tokenize(`a 'b c' "" d`), ["a", "b c", "", "d"]);
});

test("flag parser: repeatable, values, booleans, -- terminator, unknown flags", () => {
  const p = parseArgs(tokenize(`--file a --file=b --model m --preview Review this -- --not-a-flag`), {
    values: ["model"], repeatable: ["file"], booleans: ["preview"],
  });
  assert.deepEqual(p.lists.file, ["a", "b"]);
  assert.equal(p.values.model, "m");
  assert.ok(p.booleans.has("preview"));
  assert.deepEqual(p.positionals, ["Review", "this", "--not-a-flag"]);
  assert.deepEqual(p.errors, []);
  assert.match(parseArgs(["--bogus"], {}).errors[0]!, /unknown option --bogus/);
  assert.match(parseArgs(["--model"], { values: ["model"] }).errors[0]!, /requires a value/);
});

test("local IDs are well-formed and unique-ish; custom_id embeds the local ID", () => {
  const id = newLocalJobId(new Date("2026-10-16T10:00:00Z"));
  assert.match(id, /^B-20261016-[0-9A-Z]{4}$/);
  assert.ok(isLocalJobId(id));
  assert.equal(customIdFor(id, 0), `${id}:request-001`);
  const many = new Set(Array.from({ length: 200 }, () => newLocalJobId()));
  assert.ok(many.size > 190);
});

test("submit body keeps OpenRouter's required field order (requests last)", () => {
  const body = buildSubmitBody({ model: "m", provider: { only: ["p"], allow_fallbacks: false }, requests: [] });
  assert.deepEqual(Object.keys(body), ["endpoint", "model", "provider", "completion_window", "requests"]);
  assert.deepEqual(Object.keys(buildSubmitBody({ model: "m", requests: [] })), ["endpoint", "model", "completion_window", "requests"]);
});

test("config validation: invalid values fall back and are reported; unknown keys reported", () => {
  const r = validateConfig({ polling: { intervalSeconds: "60", maxBackoffSeconds: 120 }, bogus: 1, injection: { maxCharacters: -5 } });
  assert.equal(r.config.polling.intervalSeconds, DEFAULT_CONFIG.polling.intervalSeconds);
  assert.equal(r.config.polling.maxBackoffSeconds, 120);
  assert.equal(r.config.injection.maxCharacters, DEFAULT_CONFIG.injection.maxCharacters);
  assert.equal(r.errors.length, 3);
});

test("config cascade: global <- legacy project <- batch.config.json; legacy keys migrated", () => {
  const root = tempWorkspace();
  const globalFile = path.join(root, "global-config.json");
  try {
    fs.writeFileSync(globalFile, JSON.stringify({ defaultProvider: "openrouter-work", defaultModel: "g/model", pollIntervalMs: 30000, outputBaseDir: "docs/batches" }));
    writeFiles(root, { ".pi/pi-batch-openrouter.json": JSON.stringify({ defaultModel: "legacy/model" }) });
    let loaded = loadConfig(root, globalFile);
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.config.defaultAccount, "openrouter-work");
    assert.equal(loaded.config.defaultModel, "legacy/model");
    assert.equal(loaded.config.polling.intervalSeconds, 30);
    saveConfigUpdate({ defaultModel: "project/model" }, { cwd: root, global: false }, globalFile);
    loaded = loadConfig(root, globalFile);
    assert.equal(loaded.config.defaultModel, "project/model");
    assert.equal(JSON.parse(fs.readFileSync(projectConfigPath(root), "utf8")).schemaVersion, 1);
    fs.writeFileSync(projectConfigPath(root), "{ broken");
    assert.match(loadConfig(root, globalFile).errors[0]!, /invalid JSON/);
  } finally {
    rm(root);
  }
});

test("atomic write leaves no temp files; writeOnce never overwrites", () => {
  const root = tempWorkspace();
  try {
    const f = path.join(root, "a", "x.json");
    atomicWriteFile(f, "1");
    atomicWriteFile(f, "2");
    assert.equal(fs.readFileSync(f, "utf8"), "2");
    assert.deepEqual(fs.readdirSync(path.dirname(f)), ["x.json"]);
    const r = path.join(root, "final-response.json");
    assert.equal(writeOnce(r, "first"), r);
    assert.equal(writeOnce(r, "second"), path.join(root, "final-response.2.json"));
    assert.equal(fs.readFileSync(r, "utf8"), "first");
  } finally {
    rm(root);
  }
});

test("lock is exclusive and released", () => {
  const root = tempWorkspace();
  try {
    const p = path.join(root, ".lock");
    const a = tryAcquireLock(p);
    assert.ok(a);
    assert.equal(tryAcquireLock(p), null);
    a!.release();
    const b = tryAcquireLock(p);
    assert.ok(b);
    b!.release();
  } finally {
    rm(root);
  }
});

test("isInside handles .. prefixes and other drives", () => {
  const base = path.resolve("/work/repo");
  assert.ok(isInside(base, path.join(base, "..foo")));
  assert.ok(isInside(base, path.join(base, "a", "b")));
  assert.equal(isInside(base, path.resolve(base, "..", "other")), false);
  if (process.platform === "win32") assert.equal(isInside("C:\\work", "D:\\work\\x"), false);
});
