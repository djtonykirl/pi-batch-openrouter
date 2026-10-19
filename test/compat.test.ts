import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { sha256Hex } from "../src/fsutil.js";
import { jobItems } from "../src/items.js";
import type { BatchService } from "../src/service.js";
import { FakeOpenRouter, accepted, makeService } from "./fixtures/fake-openrouter.js";
import { completed, successItem } from "./fixtures/openrouter.js";
import { rm, tempWorkspace } from "./helpers.js";

/**
 * A Release 1 job exactly as be0cf43 wrote it: schemaVersion 1, no kind/items,
 * and a custom_id containing ':' (the format replaced by 35a3246).
 */
const R1_ID = "B-20261016-A7C2";
const R1_CUSTOM_ID = `${R1_ID}:request-001`;

function writeRelease1Job(service: BatchService, status: "polling" | "previewed"): void {
  const dir = service.registry.jobDir(R1_ID);
  const body = {
    endpoint: "/v1/chat/completions",
    model: "anthropic/claude-haiku-5.5",
    completion_window: "24h",
    requests: [{ custom_id: R1_CUSTOM_ID, body: { messages: [{ role: "user", content: "OBJECTIVE\n=========\n\nReview it\n" }], max_tokens: 16000 } }],
  };
  const bodyText = JSON.stringify(body, null, 2);
  const files: Record<string, string> = {
    "request/objective.md": "Review it\n",
    "request/context.md": "OBJECTIVE\n=========\n\nReview it\n",
    "request/context-manifest.json": "{}\n",
    "request/submitted-request.json": bodyText,
    "request/request.sha256": `${sha256Hex(bodyText)}  submitted-request.json\n`,
    "events.jsonl":
      JSON.stringify({ id: "e1", localId: R1_ID, eventType: "created", eventAt: "2026-10-16T10:00:00.000Z", details: { localStatus: "draft" } }) +
      "\n" +
      JSON.stringify({ id: "e2", localId: R1_ID, eventType: "transition", previousStatus: "draft", newStatus: "previewed", eventAt: "2026-10-16T10:00:00.100Z" }) +
      "\n",
  };
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  const manifest = {
    schemaVersion: 1,
    localId: R1_ID,
    retryCount: 0,
    objective: "Review it",
    model: "anthropic/claude-haiku-5.5",
    provider: "openrouter",
    account: "openrouter",
    endpoint: "/v1/chat/completions",
    format: "markdown",
    localStatus: status,
    requestCount: 1,
    customIds: [R1_CUSTOM_ID],
    createdAt: "2026-10-16T10:00:00.000Z",
    pollAttempts: 0,
    consecutivePollFailures: 0,
    requestSha256: sha256Hex(bodyText),
    contentSha256: "0".repeat(64),
    context: { fileCount: 0, characters: 30, excludedCount: 0 },
    injectionCount: 0,
    warnings: [],
    ...(status === "polling" ? { providerBatchId: "batch_r1", providerStatus: "in_progress", submittedAt: "2026-10-16T10:00:01.000Z" } : {}),
  };
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
}

test("Release 1 job: loads, shown as one item with its stored custom_id verbatim, completes, reads and injects", async () => {
  const root = tempWorkspace();
  try {
    const fake = new FakeOpenRouter();
    const service = makeService(root, fake);
    writeRelease1Job(service, "polling");

    const before = service.registry.read(R1_ID);
    assert.equal(before.schemaVersion, 1);
    const items = jobItems(service.registry, before);
    assert.deepEqual(items.map((i) => [i.ordinal, i.customId, i.status]), [[1, R1_CUSTOM_ID, "submitted"]]);

    // Correlated against the STORED id (with ':'), not a regenerated one.
    fake.getReplies = [{ status: 200, body: completed([successItem(R1_CUSTOM_ID, "R1 result")], { id: "batch_r1" }) }];
    await service.reconcile(R1_ID, { force: true });
    const after = service.registry.read(R1_ID);
    assert.equal(after.localStatus, "ready");
    assert.equal(after.schemaVersion, 1); // never upgraded in place
    assert.equal(after.items, undefined);
    assert.deepEqual(after.customIds, [R1_CUSTOM_ID]);
    assert.equal(service.read(R1_ID, "default").body, "R1 result\n");
    // Item artefacts live under an ordinal folder (':' is not a valid Windows file name character).
    assert.ok(fs.existsSync(service.registry.itemArtefact(R1_ID, 1, "raw")));
    assert.deepEqual(jobItems(service.registry, after).map((i) => i.status), ["completed"]);
    assert.match(service.describeItems(R1_ID), /001 {3}completed {3}goal \(Release 1 job\)/);

    const inj = service.buildInjection(R1_ID, "default");
    assert.ok(inj.ok);
    assert.match(inj.content, /^Deferred batch result: B-20261016-A7C2\n/);
    assert.match(inj.content, /\nR1 result\n/);

    // History preserved: original events still first, new ones appended.
    const events = service.registry.events(R1_ID);
    assert.deepEqual(events.slice(0, 2).map((e) => e.id), ["e1", "e2"]);
    assert.ok(events.some((e) => e.newStatus === "ready"));

    // Release 1 retry still works and moves to provider-safe IDs.
    fake.submitReplies = [accepted("batch_r1_retry")];
    const child = await service.retry(R1_ID);
    assert.equal(child.localStatus, "submitted");
    assert.equal(child.customIds[0], `${child.localId}_request-001`);
    assert.deepEqual(child.items![0]!.replaces, { jobId: R1_ID, customId: R1_CUSTOM_ID, ordinal: 1 });
  } finally {
    rm(root);
  }
});

test("Release 1 previewed job whose stored custom_id is not provider-safe is refused locally before any network call", async () => {
  const root = tempWorkspace();
  try {
    const fake = new FakeOpenRouter();
    const service = makeService(root, fake);
    writeRelease1Job(service, "previewed");
    await assert.rejects(service.submit(R1_ID), /does not match .*Cancel it/s);
    assert.equal(fake.requests.length, 0);
    assert.equal(service.registry.read(R1_ID).localStatus, "previewed");
  } finally {
    rm(root);
  }
});

test("unknown schemaVersion is reported as unreadable, never guessed", () => {
  const root = tempWorkspace();
  try {
    const service = makeService(root, new FakeOpenRouter());
    writeRelease1Job(service, "previewed");
    const p = path.join(service.registry.jobDir(R1_ID), "manifest.json");
    fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace('"schemaVersion": 1', '"schemaVersion": 99'));
    const list = service.registry.list();
    assert.equal(list.jobs.length, 0);
    assert.match(list.unreadable[0]!.reason, /schemaVersion/);
  } finally {
    rm(root);
  }
});
