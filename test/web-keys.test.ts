import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { createStandaloneKeyResolver, resolveStandaloneApiKey } from "../src/web/server.js";
import { rm, tempWorkspace, writeFiles } from "./helpers.js";

const A = "sk-or-v1-" + "a".repeat(64);
const B = "sk-or-v1-" + "b".repeat(64);
const ENV = "sk-or-v1-" + "e".repeat(64);

function withAuth(fn: (authFile: string) => void): void {
  const dir = tempWorkspace();
  const saved = process.env.OPENROUTER_API_KEY;
  try {
    writeFiles(dir, { "auth.json": JSON.stringify({ openrouter: { key: A }, work: { key: B } }) });
    fn(join(dir, "auth.json"));
  } finally {
    if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = saved;
    rm(dir);
  }
}

test("U-I7: the standalone server uses only the requested account's key, never another account's", () =>
  withAuth((authFile) => {
    process.env.OPENROUTER_API_KEY = ENV;
    assert.equal(resolveStandaloneApiKey("work", "openrouter", authFile), B);
    assert.equal(resolveStandaloneApiKey("openrouter", "openrouter", authFile), A);
    // An account with no key of its own is an error, not a silent fallback to "openrouter" (or the env key).
    assert.throws(() => resolveStandaloneApiKey("client-x", "openrouter", authFile), /No API key for account "client-x"/);
    // OPENROUTER_API_KEY only stands in for the configured default account.
    assert.equal(resolveStandaloneApiKey("client-x", "client-x", authFile), ENV);
    delete process.env.OPENROUTER_API_KEY;
    assert.throws(() => resolveStandaloneApiKey("client-x", "client-x", authFile), /OPENROUTER_API_KEY/);
  }));

test("U-I7: every key the standalone resolver hands out is redacted by its logger", async () => {
  const r = createStandaloneKeyResolver(() => "openrouter", async (account) => (account === "work" ? B : A));
  assert.deepEqual(r.secrets(), process.env.OPENROUTER_API_KEY ? [process.env.OPENROUTER_API_KEY] : []);
  await r.resolve("work");
  await r.resolve("openrouter");
  assert.ok(r.secrets().includes(A));
  assert.ok(r.secrets().includes(B));
});
