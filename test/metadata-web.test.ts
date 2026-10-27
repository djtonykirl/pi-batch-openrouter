import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ArtifactService } from "../src/artifacts/service.js";
import { ArtifactStore } from "../src/artifacts/store.js";
import { ChatService } from "../src/chat/service.js";
import { ThreadStore } from "../src/chat/store.js";
import { formatMetadataPreview } from "../src/metadata-commands.js";
import { OpenRouterBatchClient } from "../src/openrouter/client.js";
import { BatchPoller } from "../src/poller.js";
import { JobRegistry } from "../src/registry.js";
import { BatchService } from "../src/service.js";
import { BatchWebServer } from "../src/web/server.js";
import { FAKE_KEY, FakeOpenRouter, accepted, makeConfig } from "./fixtures/fake-openrouter.js";
import { metadataWorkspace, proposalFor } from "./fixtures/metadata.js";
import { completed, successItem } from "./fixtures/openrouter.js";
import { rm } from "./helpers.js";

interface Env {
  root: string;
  batch: BatchService;
  fake: FakeOpenRouter;
  get: (p: string, init?: RequestInit) => Promise<Response>;
  post: (p: string, body?: unknown, extra?: Record<string, string>) => Promise<Response>;
  anon: (p: string, method?: string) => Promise<Response>;
}

const CTX = "metadata/beverage/context.md";
const TABLES = "metadata/beverage/tables.jsonl";

function withWeb(fn: (e: Env) => Promise<void>): () => Promise<void> {
  return async () => {
    const root = metadataWorkspace();
    let web: BatchWebServer | undefined;
    try {
      const fake = new FakeOpenRouter();
      fake.submitReplies = [async () => accepted("batch_md")];
      const cfg = makeConfig();
      const batch = new BatchService({
        registry: new JobRegistry(join(root, ".pi", "batches")),
        workspaceRoot: root,
        getConfig: () => cfg,
        resolveApiKey: async () => FAKE_KEY,
        createClient: (apiKey, timeoutMs) => new OpenRouterBatchClient({ apiKey, fetchImpl: fake.fetch, timeoutMs }),
        gitIgnored: () => new Set(),
      });
      const store = new ThreadStore(join(root, ".pi/batches/threads"));
      const chat = new ChatService({ store, batch, workspaceRoot: root, getConfig: () => cfg });
      const artifacts = new ArtifactService({ batch, workspaceRoot: root, getConfig: () => cfg, store: new ArtifactStore(join(root, ".pi/batches/artifacts")) });
      const poller = new BatchPoller(() => batch, () => true);
      web = new BatchWebServer({ workspaceRoot: root, service: batch, chat, chatStore: store, artifacts, poller, getConfig: () => cfg, getKnownModels: () => [], reloadConfig: () => {} });
      const base = await web.start(0, "127.0.0.1");
      const launch = await globalThis.fetch(web.createLaunchUrl()!, { redirect: "manual" });
      const cookie = (launch.headers.get("set-cookie") ?? "").split(";")[0]!;
      const get = (p: string, init: RequestInit = {}) => globalThis.fetch(base + p, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), Cookie: cookie } });
      const post = (p: string, body: unknown = {}, extra: Record<string, string> = {}) =>
        globalThis.fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json", "X-Batch-Token": web!.csrfToken, Cookie: cookie, ...extra }, body: JSON.stringify(body) });
      const anon = (p: string, method = "GET") => globalThis.fetch(base + p, { method, headers: { "X-Batch-Token": web!.csrfToken } });
      await fn({ root, batch, fake, get, post, anon });
    } finally {
      await web?.stop();
      rm(root);
    }
  };
}

const json = async (r: Response) => (await r.json()) as Record<string, any>;

test(
  "metadata endpoints need a session and refuse a foreign origin",
  withWeb(async ({ anon, post }) => {
    for (const path of ["/api/jobs/metadata", "/api/jobs/job_x/metadata/review", "/api/jobs/job_x/metadata/approved", "/api/metadata/validate-approved"]) {
      assert.equal((await anon(path, "POST")).status, 401, `${path} without a session`);
      assert.equal((await post(path, {}, { Origin: "http://evil.example" })).status, 403, `${path} foreign origin`);
    }
  }),
);

test(
  "a context outside the workspace is a 400 and creates no job",
  withWeb(async ({ post, batch }) => {
    const dry = await post("/api/jobs/metadata", { context: "../outside.md", input: TABLES, mode: "dryrun" });
    assert.equal(dry.status, 400);
    for (const mode of ["preview", "submit"]) {
      assert.equal((await post("/api/jobs/metadata", { context: "../outside.md", input: TABLES, mode })).status, 400);
    }
    assert.equal(batch.registry.list().jobs.length, 0);
  }),
);

test(
  "domain without ucPrefix is a 400 naming both, and no job is created",
  withWeb(async ({ post, batch }) => {
    for (const mode of ["dryrun", "preview", "submit"]) {
      const r = await post("/api/jobs/metadata", { context: CTX, input: TABLES, domain: "beverage", mode });
      assert.equal(r.status, 400, mode);
      assert.match((await json(r)).error, /domain[\s\S]*(ucPrefix|uc-prefix)/);
    }
    assert.equal(batch.registry.list().jobs.length, 0);
  }),
);

test(
  "dry run returns the same preview text as formatMetadataPreview; preview saves, submit submits",
  withWeb(async ({ post, batch }) => {
    const dry = await json(await post("/api/jobs/metadata", { context: CTX, input: TABLES, mode: "dryrun" }));
    assert.deepEqual(dry.blockers, []);
    const expected = formatMetadataPreview(await batch.planMetadata({ context: CTX, input: TABLES }), true);
    assert.equal(dry.preview, expected);
    assert.equal(batch.registry.list().jobs.length, 0);

    const saved = await post("/api/jobs/metadata", { context: CTX, input: TABLES, mode: "preview" });
    assert.equal(saved.status, 201);
    assert.equal((await json(saved)).job.localStatus, "previewed");
    const sub = await post("/api/jobs/metadata", { context: CTX, input: TABLES, mode: "submit" });
    assert.equal(sub.status, 201);
    assert.equal((await json(sub)).job.localStatus, "submitted");
  }),
);

test(
  "review and approved on an unfinished job say to wait; approved needs out",
  withWeb(async ({ post }) => {
    const job = (await json(await post("/api/jobs/metadata", { context: CTX, input: TABLES, mode: "submit" }))).job;
    const rev = await post(`/api/jobs/${job.localId}/metadata/review`, {});
    assert.equal(rev.status, 400);
    assert.match((await json(rev)).error, /wait until it has finished/);
    const app = await post(`/api/jobs/${job.localId}/metadata/approved`, { out: "metadata/beverage/approved.jsonl" });
    assert.equal(app.status, 400);
    assert.match((await json(app)).error, /wait until it has finished/);
    assert.equal((await post(`/api/jobs/${job.localId}/metadata/approved`, {})).status, 400);
  }),
);

test(
  "finished job: review, approved draft and validate-approved work through the artifact system",
  withWeb(async ({ post, batch, fake, root }) => {
    const job = (await json(await post("/api/jobs/metadata", { context: CTX, input: TABLES, mode: "submit" }))).job;
    const names = ["demo_catalog.beverage.product", "demo_catalog.beverage.formulation", "demo_catalog.beverage.ingredient"];
    const results = (job.customIds as string[]).map((c, i) => successItem(c, JSON.stringify(proposalFor(names[i]!))));
    fake.getReplies = [{ status: 200, body: completed(results, { id: "batch_md" }) }];
    await batch.reconcile(job.localId, { force: true });

    const rev = await json(await post(`/api/jobs/${job.localId}/metadata/review`, { out: "metadata/beverage/review.md" }));
    assert.equal(rev.path, "metadata/beverage/review.md");
    assert.ok(rev.artifactId);
    assert.equal(typeof rev.gaps, "number");
    assert.ok(existsSync(join(root, "metadata", "beverage", "review.md")));
    // No silent overwrite; explicit overwrite works; containment holds.
    assert.equal((await post(`/api/jobs/${job.localId}/metadata/review`, { out: "metadata/beverage/review.md" })).status, 400);
    assert.equal((await post(`/api/jobs/${job.localId}/metadata/review`, { out: "metadata/beverage/review.md", overwrite: true })).status, 200);
    assert.equal((await post(`/api/jobs/${job.localId}/metadata/review`, { out: "../escape.md" })).status, 400);

    const app = await json(await post(`/api/jobs/${job.localId}/metadata/approved`, { out: "metadata/beverage/approved.jsonl" }));
    assert.equal(app.path, "metadata/beverage/approved.jsonl");
    assert.match(app.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(app.problems, []);
    assert.ok(app.counts.total > 0);

    const val = await json(await post("/api/metadata/validate-approved", { file: "metadata/beverage/approved.jsonl", job: job.localId }));
    assert.equal(val.jobId, job.localId);
    assert.deepEqual(val.problems, []);
    assert.equal(val.rows, 3);

    assert.equal((await post("/api/metadata/validate-approved", { file: "../outside.md" })).status, 400);
    assert.equal((await post("/api/metadata/validate-approved", {})).status, 400);
  }),
);

test(
  "the page has a UC Metadata tab with no inline handlers",
  withWeb(async ({ get }) => {
    const html = await (await get("/")).text();
    assert.equal(/\son(click|change|input|submit|load|error)\s*=/i.test(html), false);
    for (const needle of ['data-kind="metadata"', "UC Metadata", "metadataContextInput", "writeMetadataReview", "writeMetadataApproved", "validateMetadataApproved", "/api/jobs/metadata"]) {
      assert.ok(html.includes(needle), `page mentions ${needle}`);
    }
  }),
);
