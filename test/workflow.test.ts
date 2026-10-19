import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { CUSTOM_ID_PATTERN, customIdFor, customIdProblems, newLocalJobId } from "../src/ids.js";
import { sha256Hex } from "../src/fsutil.js";
import { FileLogger } from "../src/logger.js";
import { OpenRouterBatchClient } from "../src/openrouter/client.js";
import { JobRegistry } from "../src/registry.js";
import { BatchService, SubmissionBlockedError, DuplicateActiveRequestError, type MapFilesOptions } from "../src/service.js";
import type { JobManifest } from "../src/types.js";
import { FAKE_KEY, FakeOpenRouter, accepted, makeConfig, makeService } from "./fixtures/fake-openrouter.js";
import { BYOK_USAGE, batchObject, completed, failedItem, successItem } from "./fixtures/openrouter.js";
import { rm, tempWorkspace, writeFiles } from "./helpers.js";

const FILES: Record<string, string> = {
  "src/service.ts": "export class Service { run() { return 1; } }\r\n",
  "src/registry.ts": "export const registry = new Map<string, number>();\n",
  "src/openrouter/client.ts": "export async function call() { return fetch('x'); }\n",
};

const MAP: MapFilesOptions = {
  objective: "Review this component for reliability defects and cite the relevant code.",
  files: ["src/service.ts", "src/registry.ts", "src/openrouter/client.ts"],
  contexts: [],
  format: "markdown",
  includeInstructions: true,
};

function withWorkspace(fn: (root: string) => Promise<void>, prefix?: string): () => Promise<void> {
  return async () => {
    const root = tempWorkspace(prefix);
    writeFiles(root, FILES);
    try {
      await fn(root);
    } finally {
      rm(root);
    }
  };
}

async function plan(service: BatchService, over: Partial<MapFilesOptions> = {}) {
  return service.planMapFiles({ ...MAP, ...over });
}

async function submitPlan(service: BatchService, fake: FakeOpenRouter, over: Partial<MapFilesOptions> = {}, batchId = "batch_123"): Promise<JobManifest> {
  fake.submitReplies = [accepted(batchId)];
  const job = await service.createWorkflowJob(await plan(service, over), { previewOnly: false });
  assert.equal(job.localStatus, "submitted", job.error?.message);
  return job;
}

function allArtefactText(dir: string): string {
  let out = "";
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) out += fs.readFileSync(path.join(e.parentPath, e.name), "utf8");
  }
  return out;
}

const ok = (cid: string, text = `review of ${cid}`, extra: Record<string, unknown> = {}) => successItem(cid, text, extra);

// ---------------------------------------------------------------- custom IDs

test("custom_id: first item, large index, max length, allowed charset, uniqueness, duplicate detection", () => {
  const id = newLocalJobId(new Date("2026-10-17T00:00:00Z"));
  assert.equal(customIdFor(id, 0), `${id}_request-001`);
  assert.equal(customIdFor(id, 9_999), `${id}_request-10000`);
  const longest = newLocalJobId(new Date("2026-10-17T00:00:00Z"), 8);
  for (const i of [0, 1, 99, 999, 9_999]) {
    const cid = customIdFor(longest, i);
    assert.match(cid, CUSTOM_ID_PATTERN);
    assert.ok(cid.length <= 64);
  }
  const many = Array.from({ length: 500 }, (_, i) => customIdFor(id, i));
  assert.equal(new Set(many).size, 500);
  assert.deepEqual(customIdProblems(many), []);
  assert.match(customIdProblems([many[0]!, many[0]!]).join(), /duplicate custom_id/);
  assert.match(customIdProblems(["B-1:request-001"]).join(), /does not match/);
  assert.match(customIdProblems(["x".repeat(65)]).join(), /does not match/);
  assert.match(customIdProblems([]).join(), /no requests/);
});

// ------------------------------------------------- first vertical slice (B, C, E)

test(
  "vertical slice: map-files preview -> later submit -> reverse-order results -> per-item artefacts -> ready -> items/item",
  withWorkspace(async (root) => {
    const fake = new FakeOpenRouter();
    const service = makeService(root, fake);
    const p = await plan(service, { files: ["src/service.ts", "src/registry.ts"] });
    assert.deepEqual(p.blockers, []);
    assert.equal(p.items.length, 2);
    const preview = await service.createWorkflowJob(p, { previewOnly: true });
    assert.equal(preview.localStatus, "previewed");
    assert.equal(fake.requests.length, 0);
    assert.equal(preview.schemaVersion, 2);
    assert.equal(preview.kind, "workflow");
    assert.deepEqual(preview.workflow, { name: "map-files", version: 1, options: { groupSize: 1, format: "markdown", includeInstructions: true } });
    assert.deepEqual(preview.items!.map((i) => [i.ordinal, i.source.path, i.status]), [
      [1, "src/service.ts", "planned"],
      [2, "src/registry.ts", "planned"],
    ]);

    // Persisted plan, item inventory, exact payload.
    const reg = service.registry;
    const planJson = JSON.parse(fs.readFileSync(reg.artefact(preview.localId, "plan"), "utf8"));
    assert.equal(planJson.workflow.name, "map-files");
    assert.deepEqual(planJson.items.map((i: { customId: string }) => i.customId), preview.customIds);
    assert.equal(planJson.totals.requests, 2);
    const meta2 = JSON.parse(fs.readFileSync(reg.itemArtefact(preview.localId, 2, "metadata"), "utf8"));
    assert.equal(meta2.customId, `${preview.localId}_request-002`);
    assert.equal(meta2.source.path, "src/registry.ts");

    // "Pi restarts" between preview and submit: a fresh service submits the stored plan.
    const fake2 = new FakeOpenRouter();
    const service2 = makeService(root, fake2);
    fake2.submitReplies = [accepted()];
    const submitted = await service2.submit(preview.localId);
    assert.equal(submitted.localStatus, "submitted");
    assert.ok(submitted.items!.every((i) => i.status === "submitted"));
    const posted = fake2.requests[0]!.body!;
    assert.equal(posted, fs.readFileSync(reg.artefact(preview.localId, "submittedRequest"), "utf8"));
    const body = JSON.parse(posted);
    assert.deepEqual(Object.keys(body), ["endpoint", "model", "completion_window", "requests"]);
    assert.equal(body.requests.length, 2);
    // Each request carries only its own file.
    assert.match(body.requests[0].body.messages[1].content, /Path: src\/service\.ts/);
    assert.doesNotMatch(body.requests[0].body.messages[1].content, /registry = new Map/);
    assert.match(body.requests[1].body.messages[1].content, /registry = new Map/);
    assert.doesNotMatch(body.requests[1].body.messages[1].content, /class Service/);

    // Provider returns results in REVERSE order.
    const [c1, c2] = fake2.lastCustomIds();
    fake2.getReplies = [{ status: 200, body: completed([ok(c2!, "registry review"), ok(c1!, "service review")]) }];
    const service3 = makeService(root, fake2); // restart again before polling
    assert.deepEqual(service3.jobsNeedingReconcile().map((j) => j.localId), [preview.localId]);
    await service3.reconcile(preview.localId, { force: true });
    const done = reg.read(preview.localId);
    assert.equal(done.localStatus, "ready");
    assert.deepEqual(done.items!.map((i) => i.status), ["completed", "completed"]);

    // Independent item artefacts, keyed by submission ordinal.
    assert.equal(fs.readFileSync(reg.itemArtefact(done.localId, 1, "resultMd"), "utf8"), "service review\n");
    assert.equal(fs.readFileSync(reg.itemArtefact(done.localId, 2, "resultMd"), "utf8"), "registry review\n");
    assert.equal(JSON.parse(fs.readFileSync(reg.itemArtefact(done.localId, 1, "raw"), "utf8")).custom_id, c1);
    const summary = JSON.parse(fs.readFileSync(reg.artefact(done.localId, "resultSummary"), "utf8"));
    assert.deepEqual(summary.counts, { expected: 2, completed: 2, failed: 0, corrupt: 0, missing: 0, unexpected: 0 });

    const items = service3.describeItems(done.localId);
    assert.match(items, /001 {3}completed {3}src\/service\.ts/);
    assert.match(items, /002 {3}completed {3}src\/registry\.ts/);
    const item = service3.describeItem(done.localId, "src/registry.ts", { text: true });
    assert.match(item.body, /Custom ID\s+B-\d{8}-\w+_request-002/);
    assert.match(item.body, /registry review/);
    assert.match(service3.describeItem(done.localId, "1").body, /Source\s+src\/service\.ts/);
    assert.match(service3.describeItem(done.localId, c2!).body, /Source\s+src\/registry\.ts/);

    // Bounded default read: overview, not every full text.
    const read = service3.read(done.localId, "default").body;
    assert.match(read, /Items: 2 \(completed 2, failed 0, corrupt 0, missing 0\)/);
    assert.match(read, /--item <n>/);
  }),
);

test(
  "building: many items, deterministic mapping, stable content hash, duplicate protection",
  withWorkspace(async (root) => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 25; i++) files[`src/m${String(i).padStart(2, "0")}.ts`] = `export const v${i} = ${i};\n`;
    writeFiles(root, files);
    const fake = new FakeOpenRouter();
    const service = makeService(root, fake);
    const names = Object.keys(files);
    const a = await plan(service, { files: names });
    const b = await plan(service, { files: names });
    assert.equal(a.items.length, 25);
    assert.deepEqual(a.items.map((i) => i.source.path), names);
    assert.equal(a.contentSha256, b.contentSha256);
    const reordered = await plan(service, { files: [...names].reverse() });
    assert.notEqual(reordered.contentSha256, a.contentSha256);

    fake.submitReplies = [accepted()];
    const job = await service.createWorkflowJob(a, { previewOnly: false });
    assert.equal(job.customIds.length, 25);
    assert.deepEqual(customIdProblems(job.customIds), []);
    await assert.rejects(service.createWorkflowJob(b, { previewOnly: false }), DuplicateActiveRequestError);
  }),
);

test(
  "group-size: deterministic consecutive groups, no file omitted, sources listed in prompt",
  withWorkspace(async (root) => {
    writeFiles(root, { "src/d.ts": "export const d = 4;\n", "src/e.ts": "export const e = 5;\n" });
    const service = makeService(root, new FakeOpenRouter());
    const p = await plan(service, { files: ["src/service.ts", "src/registry.ts", "src/openrouter/client.ts", "src/d.ts", "src/e.ts"], groupSize: 2 });
    assert.deepEqual(
      p.items.map((i) => (i.source.kind === "group" ? i.source.paths : [i.source.path])),
      [["src/service.ts", "src/registry.ts"], ["src/openrouter/client.ts", "src/d.ts"], ["src/e.ts"]],
    );
    assert.match(p.items[0]!.prompt, /SOURCES\n=+\n\n1\. src\/service\.ts\n2\. src\/registry\.ts/);
    assert.match(p.items[0]!.prompt, /FILE CONTENT: src\/registry\.ts/);
    assert.match((await plan(service, { groupSize: 0 })).blockers.join(), /group-size/);
  }),
);

test(
  "local limits block the plan explicitly (requests, per-item characters, total characters)",
  withWorkspace(async (root) => {
    const cfg = makeConfig((c) => {
      c.workflows.maxRequestsPerBatch = 2;
      c.workflows.maxCharactersPerItem = 600;
      c.workflows.maxTotalCharacters = 1500;
    });
    writeFiles(root, { "src/big.ts": "// " + "x".repeat(800) + "\n" });
    const service = makeService(root, new FakeOpenRouter(), cfg);
    const p = await plan(service, { files: [...MAP.files, "src/big.ts"] });
    const blockers = p.blockers.join("\n");
    assert.match(blockers, /4 requests; workflows\.maxRequestsPerBatch is 2/);
    assert.match(blockers, /item 4 \(src\/big\.ts\) is \d+ characters; workflows\.maxCharactersPerItem is 600/);
    assert.match(blockers, /workflows\.maxTotalCharacters is 1500/);
    await assert.rejects(service.createWorkflowJob(p, { previewOnly: true }), SubmissionBlockedError);
    assert.equal(service.registry.list().jobs.length, 0);
  }),
);

// -------------------------------------------------------------------- security (F)

test(
  "security: one secret-bearing, hard-denied, outside, binary or ignored explicit file blocks the WHOLE plan; nothing persisted or sent",
  withWorkspace(async (root) => {
    const secretValue = "Zx9" + "-cl13nt-s3cr3t-value";
    writeFiles(root, {
      "src/settings.json": `{ "client_secret": "${secretValue}" }`,
      ".env": "X=1\n",
      "src/blob.ts": Buffer.from([0x00, 0x01, 0x02, 0xff]),
      ".pi/batchignore": "src/ignored.ts\n",
      "src/ignored.ts": "export {};\n",
    });
    fs.writeFileSync(path.join(path.dirname(root), "outside-r2.txt"), "outside");
    const fake = new FakeOpenRouter();
    const service = makeService(root, fake);
    for (const [bad, pattern] of [
      ["src/settings.json", /File: src\/settings\.json\n {2}Line: 1\n {2}Type: client secret assignment/],
      [".env", /\.env is excluded by hard-deny rule/],
      ["../outside-r2.txt", /outside the workspace/],
      ["src/blob.ts", /binary or not valid UTF-8/],
      ["src/ignored.ts", /excluded by batchignore/],
    ] as const) {
      const p = await plan(service, { files: [...MAP.files, bad] });
      const text = p.blockers.join("\n");
      assert.match(text, pattern, bad);
      assert.ok(!text.includes(secretValue), "blocker must not echo the secret value");
      await assert.rejects(service.createWorkflowJob(p, { previewOnly: false }), SubmissionBlockedError);
    }
    assert.equal(fake.requests.length, 0);
    assert.equal(service.registry.list().jobs.length, 0);
    fs.rmSync(path.join(path.dirname(root), "outside-r2.txt"), { force: true });

    // Directory expansion skips ignored files deterministically and lists them.
    const viaDir = await plan(service, { files: [], contexts: ["src"] });
    assert.ok(viaDir.pkg.excluded.some((e) => e.relPath === "src/ignored.ts" && e.layer === "batchignore"));
    assert.ok(viaDir.pkg.excluded.some((e) => e.relPath === "src/blob.ts" && e.layer === "binary"));
    // ...but a secret inside the directory still blocks.
    assert.match(viaDir.blockers.join(), /client secret assignment/);
  }),
);

test(
  "no API key or bearer token in any artefact or in the diagnostics log",
  withWorkspace(async (root) => {
    const fake = new FakeOpenRouter();
    const storage = path.join(root, ".pi", "batches");
    const logFile = path.join(storage, "extension.log");
    const service = new BatchService({
      registry: new JobRegistry(storage),
      workspaceRoot: root,
      getConfig: () => makeConfig(),
      resolveApiKey: async () => FAKE_KEY,
      createClient: (apiKey, timeoutMs) => new OpenRouterBatchClient({ apiKey, fetchImpl: fake.fetch, timeoutMs }),
      gitIgnored: () => new Set(),
      logger: new FileLogger(logFile, () => [FAKE_KEY]),
    });
    fake.submitReplies = [accepted()];
    const job = await service.createWorkflowJob(await plan(service), { previewOnly: false });
    const ids = fake.lastCustomIds();
    fake.getReplies = [{ status: 200, body: completed([ok(ids[0]!), failedItem(ids[1]!), ok(ids[2]!)]) }];
    await service.reconcile(job.localId, { force: true });
    const everything = allArtefactText(storage);
    assert.ok(fs.existsSync(logFile));
    assert.ok(!everything.includes(FAKE_KEY));
    assert.doesNotMatch(everything, /Bearer\s+\S/);
    assert.doesNotMatch(everything, /Authorization/);
  }),
);

// ------------------------------------------------- outcomes through the service (D)

test(
  "service outcomes: partial (failed + corrupt + missing) keeps usable items; summary counts are exact",
  withWorkspace(async (root) => {
    writeFiles(root, { "src/d.ts": "export const d = 4;\n" });
    const fake = new FakeOpenRouter();
    const service = makeService(root, fake);
    const job = await submitPlan(service, fake, { files: [...MAP.files, "src/d.ts"] });
    const [a, b, c] = fake.lastCustomIds();
    const malformed = ok(c!);
    (malformed.response as Record<string, unknown>).body = null;
    fake.getReplies = [{ status: 200, body: completed([malformed, failedItem(b!), ok(a!, "only good one")]) }];
    await service.reconcile(job.localId, { force: true });
    const m = service.registry.read(job.localId);
    assert.equal(m.localStatus, "partial");
    assert.deepEqual(m.items!.map((i) => i.status), ["completed", "failed", "corrupt", "missing"]);
    assert.equal(m.error?.message, "3 of 4 request(s) failed (1 failed, 1 corrupt, 1 missing)");
    assert.equal(fs.readFileSync(service.registry.itemArtefact(job.localId, 1, "resultMd"), "utf8"), "only good one\n");
    assert.ok(!fs.existsSync(service.registry.itemArtefact(job.localId, 3, "resultMd")));
    assert.ok(fs.existsSync(service.registry.itemArtefact(job.localId, 3, "raw")));
    assert.ok(!fs.existsSync(service.registry.itemArtefact(job.localId, 4, "raw")));
    const md = fs.readFileSync(service.registry.artefact(job.localId, "resultMd"), "utf8");
    assert.match(md, /## Item 002 · src\/registry\.ts \(FAILED\)/);
    assert.match(md, /## Item 004 · src\/d\.ts \(MISSING\)/);
    const inj = service.buildInjection(job.localId, "full");
    assert.ok(inj.ok);
    assert.match(inj.content, /PARTIAL RESULT/);
    assert.match(inj.content, /Coverage: 1 of 4 item\(s\) usable\./);
    assert.match(inj.content, /Not covered: src\/registry\.ts \(failed\); src\/openrouter\/client\.ts \(corrupt\); src\/d\.ts \(missing\)/);
  }),
);

test(
  "service outcomes: duplicate or unknown IDs -> corrupt; nothing readable or injectable; evidence kept",
  withWorkspace(async (root) => {
    const fake = new FakeOpenRouter();
    const service = makeService(root, fake);
    const job = await submitPlan(service, fake);
    const [a, b, c] = fake.lastCustomIds();
    fake.getReplies = [{ status: 200, body: completed([ok(a!), ok(b!), ok(c!), ok(b!, "dupe")]) }];
    await service.reconcile(job.localId, { force: true });
    const m = service.registry.read(job.localId);
    assert.equal(m.localStatus, "corrupt");
    assert.match(m.error!.message, /duplicate custom_id/);
    assert.ok(fs.existsSync(service.registry.artefact(job.localId, "resultUnexpected")));
    assert.ok(!fs.existsSync(service.registry.artefact(job.localId, "resultMd")));
    assert.equal(service.buildInjection(job.localId, "full").ok, false);
    assert.match(service.describeItem(job.localId, "1", { text: true }).body, /could not be correlated safely/);
    assert.match(service.describeItems(job.localId), /untrusted \(batch corrupt\)/);
  }),
);

test(
  "fake provider enforces provider-safe custom_ids: a ':' ID is rejected with HTTP 422 like the live defect",
  withWorkspace(async (root) => {
    const fake = new FakeOpenRouter();
    const service = makeService(root, fake);
    const preview = await service.createWorkflowJob(await plan(service), { previewOnly: true });
    // Simulate a payload from an older generator.
    const reqPath = service.registry.artefact(preview.localId, "submittedRequest");
    const legacy = fs.readFileSync(reqPath, "utf8").replace(/_request-/g, ":request-");
    fs.writeFileSync(reqPath, legacy);
    service.registry.update(preview.localId, (u) => {
      u.manifest.requestSha256 = sha256Hex(legacy);
    });
    // Blocked locally before any network call...
    await assert.rejects(service.submit(preview.localId), /does not match/);
    assert.equal(fake.requests.length, 0);
    // ...and the fake would have rejected it anyway.
    const fakeVerdict = (await fake.fetch("https://x/batches", { method: "POST", headers: {}, body: legacy })).status;
    assert.equal(fakeVerdict, 422);
  }),
);

// ------------------------------------------------------------ recovery (I)

test(
  "recovery: interrupted retrieval (raw saved, item writes partial) finishes from local evidence with no network",
  withWorkspace(async (root) => {
    const fake = new FakeOpenRouter();
    const service = makeService(root, fake);
    const job = await submitPlan(service, fake);
    const [a, b, c] = fake.lastCustomIds();
    const raw = JSON.stringify(completed([ok(c!), ok(a!), ok(b!)], { id: "batch_123" }));
    // Simulate the crash window: raw saved, transitions up to retrieving, one item half-written.
    const reg = service.registry;
    fs.mkdirSync(path.dirname(reg.artefact(job.localId, "finalResponse")), { recursive: true });
    fs.writeFileSync(reg.artefact(job.localId, "finalResponse"), raw);
    reg.update(job.localId, (u) => {
      u.transition("polling");
      u.transition("provider_completed");
      u.transition("retrieving");
      u.manifest.finalResponseFile = "provider/final-response.json";
    });
    fs.mkdirSync(path.dirname(reg.itemArtefact(job.localId, 2, "resultMd")), { recursive: true });
    fs.writeFileSync(reg.itemArtefact(job.localId, 2, "resultMd"), "partial wri");

    const offline = new FakeOpenRouter();
    offline.offline = true;
    const fresh = makeService(root, offline);
    assert.deepEqual(fresh.jobsNeedingReconcile().map((j) => j.localId), [job.localId]);
    await fresh.reconcile(job.localId);
    assert.equal(offline.requests.length, 0);
    const m = reg.read(job.localId);
    assert.equal(m.localStatus, "ready");
    assert.equal(fs.readFileSync(reg.itemArtefact(job.localId, 2, "resultMd"), "utf8"), `review of ${b}\n`);
    assert.ok(!fs.existsSync(reg.artefact(job.localId, "finalResponse").replace(".json", ".2.json")));
    assert.ok(reg.events(job.localId).some((e) => e.newStatus === "ready" && e.details?.resumed === true));
  }),
);

test(
  "recovery: provider completed before local retrieval, then restart -> retrieved once; overlapping checks never double-retrieve",
  withWorkspace(async (root) => {
    const fake = new FakeOpenRouter();
    const service = makeService(root, fake);
    const job = await submitPlan(service, fake);
    const ids = fake.lastCustomIds();
    fake.getReplies = [{ status: 402, body: batchObject({ status: "completed", results: null }) }];
    await service.reconcile(job.localId, { force: true });
    assert.equal(service.registry.read(job.localId).localStatus, "provider_completed");

    const fake2 = new FakeOpenRouter();
    const s1 = makeService(root, fake2);
    const s2 = makeService(root, fake2);
    fake2.getReplies = [async () => (await new Promise((r) => setTimeout(r, 80)), { status: 200, body: completed(ids.map((id) => ok(id))) })];
    const outcomes = await Promise.all([s1.reconcile(job.localId, { force: true }), s2.reconcile(job.localId, { force: true })]);
    assert.deepEqual(outcomes.map((o) => o.skipped ?? "ran").sort(), ["locked", "ran"]);
    assert.equal(service.registry.read(job.localId).localStatus, "ready");
    const retrievals = service.registry.events(job.localId).filter((e) => e.newStatus === "retrieving").length;
    assert.equal(retrievals, 2); // first attempt (402, back to provider_completed) + the real one
    assert.ok(!fs.existsSync(service.registry.artefact(job.localId, "finalResponse").replace(".json", ".2.json")));
  }),
);

test(
  "recovery: transient network loss during multi-request polling is recorded and recovers",
  withWorkspace(async (root) => {
    const fake = new FakeOpenRouter();
    const service = makeService(root, fake);
    const job = await submitPlan(service, fake);
    fake.getReplies = [new TypeError("fetch failed: ECONNRESET")];
    await service.reconcile(job.localId, { force: true });
    assert.equal(service.registry.read(job.localId).lastPollError?.category, "network");
    assert.equal(service.registry.read(job.localId).localStatus, "submitted");
    fake.getReplies = [{ status: 200, body: completed(fake.lastCustomIds().map((id) => ok(id))) }];
    await service.reconcile(job.localId, { force: true });
    assert.equal(service.registry.read(job.localId).localStatus, "ready");
  }),
);

test(
  "item selector: ambiguous source path is reported, never guessed",
  withWorkspace(async (root) => {
    writeFiles(root, { "src/x.ts": "export const x = 1;\n", "src/y.ts": "export const y = 2;\n", "src/z.ts": "export const z = 3;\n" });
    const fake = new FakeOpenRouter();
    const service = makeService(root, fake);
    const preview = await service.createWorkflowJob(await plan(service, { files: ["src/x.ts", "src/y.ts", "src/z.ts"], groupSize: 2 }), { previewOnly: true });
    assert.throws(() => service.describeItem(preview.localId, "src/nope.ts"), /No item matches/);
    assert.match(service.describeItem(preview.localId, "src/y.ts").body, /Item\s+1 of 2/);
    // A path present in two items (constructed) is ambiguous.
    service.registry.update(preview.localId, (u) => {
      u.manifest.items![1]!.source = { kind: "group", paths: ["src/z.ts", "src/x.ts"] };
    });
    assert.throws(() => service.describeItem(preview.localId, "src/x.ts"), /ambiguous; it matches items 1, 2/);
  }),
);

// ---------------------------------------------------------------- usage (J)

test(
  "usage: batch-level only is shown as batch-level; item usage only where returned; no invented item cost",
  withWorkspace(async (root) => {
    const fake = new FakeOpenRouter();
    const service = makeService(root, fake);
    const job = await submitPlan(service, fake);
    const [a, b, c] = fake.lastCustomIds();
    fake.getReplies = [
      { status: 200, body: completed([ok(a!, "a", { usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 } }), ok(b!), ok(c!)], { usage: BYOK_USAGE }) },
    ];
    await service.reconcile(job.localId, { force: true });
    const m = service.registry.read(job.localId);
    assert.equal(m.usage?.cost, 0.00001);
    assert.equal(m.usage?.isByok, true);
    assert.equal(m.usage?.upstreamInferenceCost, 0.0004);
    assert.deepEqual(m.items![0]!.usage, { inputTokens: 7, outputTokens: 2, totalTokens: 9 });
    assert.equal(m.items![1]!.usage, undefined);
    assert.equal(m.items![2]!.usage, undefined);
    assert.match(service.describeItem(job.localId, "2").body, /Item usage\s+not reported per item \(batch-level usage only/);
    assert.match(service.describeItem(job.localId, "1").body, /Item usage\s+input 7 tok, output 2 tok/);
  }),
);

// ---------------------------------------------------------------- Windows (K)

test(
  "Windows-style paths: OneDrive-like workspace with spaces, CRLF normalised, backslash input, case-insensitive duplicates",
  withWorkspace(async (root) => {
    const fake = new FakeOpenRouter();
    const service = makeService(root, fake);
    assert.match(root, /OneDrive - Contoso/);
    const files = process.platform === "win32" ? ["src\\service.ts", "SRC/Service.ts", "src/registry.ts"] : ["src/service.ts", "src/service.ts", "src/registry.ts"];
    const p = await plan(service, { files });
    assert.deepEqual(p.blockers, []);
    assert.deepEqual(p.items.map((i) => i.source.path), ["src/service.ts", "src/registry.ts"]); // collapsed, first selection kept
    assert.doesNotMatch(p.items[0]!.prompt, /\r/);
    assert.match(p.pkg.files[0]!.lineEndings, /crlf/);
  }, "OneDrive - Contoso ws-"),
);
