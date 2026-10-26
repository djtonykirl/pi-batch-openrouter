import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { DEFAULT_CONFIG, validateConfig } from "../src/config.js";
import { isThreadId, newThreadId } from "../src/ids.js";
import { JobRegistry } from "../src/registry.js";
import { CHAT_MANIFEST_SCHEMA_VERSION, isChatJob, type JobManifest } from "../src/types.js";
import { rm, tempWorkspace } from "./helpers.js";

test("chat config defaults", () => {
  const { systemPrompt, ...rest } = DEFAULT_CONFIG.chat;
  assert.deepEqual(rest, { autoCompact: true, autoCompactTokens: 60000, keepRecentExchanges: 4, retitleAtTurn: 3 });
  assert.ok(typeof systemPrompt === "string" && systemPrompt.length > 0);
});

test("chat config validation", () => {
  const { config, errors } = validateConfig({ chat: { autoCompactTokens: -1, keepRecentExchanges: 2 } });
  assert.equal(config.chat.keepRecentExchanges, 2);
  assert.equal(config.chat.autoCompactTokens, 60000);
  assert.ok(errors.some((e) => e.includes("autoCompactTokens")));
});

test("thread ids", () => {
  assert.match(newThreadId(new Date("2026-10-26T10:00:00Z")), /^T-20261026-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(isThreadId("B-20261026-ABCD"), false);
});

test("registry reads schema v4 manifests", () => {
  const ws = tempWorkspace();
  try {
    const registry = new JobRegistry(path.join(ws, ".pi", "batches"));
    registry.ensureRoot();
    const created = registry.create(
      (localId) =>
        ({
          schemaVersion: CHAT_MANIFEST_SCHEMA_VERSION,
          localId,
          kind: "chat",
          retryCount: 0,
          objective: "Chat turn in T-20261026-ABCD",
          model: "m",
          provider: "openrouter",
          account: "openrouter",
          endpoint: "/v1/chat/completions",
          format: "markdown",
          localStatus: "draft",
          requestCount: 1,
          customIds: [],
          createdAt: new Date().toISOString(),
          pollAttempts: 0,
          consecutivePollFailures: 0,
          chat: { threadId: "T-20261026-ABCD", purpose: "turn", throughSeq: 1, titleItem: false },
        }) as unknown as JobManifest,
    );
    const read = registry.read(created.localId);
    assert.equal(read.schemaVersion, 4);
    assert.equal(isChatJob(read), true);
  } finally {
    rm(ws);
  }
});
