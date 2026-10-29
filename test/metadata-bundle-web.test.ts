import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ArtifactService } from "../src/artifacts/service.js";
import { ArtifactStore } from "../src/artifacts/store.js";
import { ChatService } from "../src/chat/service.js";
import { ThreadStore } from "../src/chat/store.js";
import { sha256Hex } from "../src/fsutil.js";
import { OpenRouterBatchClient } from "../src/openrouter/client.js";
import { BatchPoller } from "../src/poller.js";
import { JobRegistry } from "../src/registry.js";
import { BatchService } from "../src/service.js";
import { BatchWebServer } from "../src/web/server.js";
import { FAKE_KEY, FakeOpenRouter, makeConfig } from "./fixtures/fake-openrouter.js";
import { metadataWorkspace } from "./fixtures/metadata.js";
import { rm } from "./helpers.js";

interface Env {
  root: string;
  get: (p: string, extra?: Record<string, string>) => Promise<Response>;
  post: (p: string, body?: unknown, extra?: Record<string, string>) => Promise<Response>;
  anon: (p: string, method?: string) => Promise<Response>;
}

function withWeb(extra: Record<string, string>, fn: (e: Env) => Promise<void>): () => Promise<void> {
  return async () => {
    const root = metadataWorkspace(extra);
    let web: BatchWebServer | undefined;
    try {
      const fake = new FakeOpenRouter();
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
      const get = (p: string, extra: Record<string, string> = {}) => globalThis.fetch(base + p, { headers: { Cookie: cookie, ...extra } });
      const post = (p: string, body: unknown = {}, extra: Record<string, string> = {}) =>
        globalThis.fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json", "X-Batch-Token": web!.csrfToken, Cookie: cookie, ...extra }, body: JSON.stringify(body) });
      const anon = (p: string, method = "GET") => globalThis.fetch(base + p, { method, headers: { "X-Batch-Token": web!.csrfToken } });
      await fn({ root, get, post, anon });
    } finally {
      await web?.stop();
      rm(root);
    }
  };
}

const json = async (r: Response) => (await r.json()) as Record<string, any>;

function bundle(tamper = false) {
  const tables = Buffer.from('{"table":"a"}\n{"table":"b"}\n', "utf8");
  const context = Buffer.from("# Context\nline é\n", "utf8");
  const manifest = Buffer.from(
    JSON.stringify({
      run_id: "r1",
      domain_prefix: "PNPT",
      contract_version: "1",
      files: [
        { path: "tables.jsonl", sha256: sha256Hex(tables), bytes: tables.length },
        { path: "context.md", sha256: sha256Hex(context), bytes: context.length },
      ],
      table_count: 2,
      created_ts: "2026-10-29T00:00:00Z",
    }),
    "utf8",
  );
  const sent = tamper ? Buffer.from(context.toString("utf8").replace("\n", "\r\n"), "utf8") : context;
  const b64 = (name: string, b: Buffer) => ({ name, contentBase64: b.toString("base64") });
  return { tables, context, manifest, files: [b64("tables.jsonl", tables), b64("context.md", sent), b64("manifest.json", manifest)] };
}

const D = "metadata/pnpt/r1";

test(
  "bundle routes need a session and refuse a foreign origin",
  withWeb({}, async ({ anon, post, get }) => {
    assert.equal((await anon("/api/metadata/import-bundle", "POST")).status, 401);
    assert.equal((await post("/api/metadata/import-bundle", {}, { Origin: "http://evil.example" })).status, 403);
    assert.equal((await anon("/api/metadata/approved-file?path=a.jsonl")).status, 401);
    assert.equal((await get("/api/metadata/approved-file?path=a.jsonl", { Origin: "http://evil.example" })).status, 403);
  }),
);

test(
  "import writes exactly the uploaded bytes; re-import is 409; overwrite replaces all three",
  withWeb({}, async ({ root, post }) => {
    const b = bundle();
    const r = await post("/api/metadata/import-bundle", { files: b.files });
    assert.equal(r.status, 201);
    const out = await json(r);
    assert.equal(out.dest, D);
    assert.equal(out.contextPath, `${D}/context.md`);
    assert.equal(out.inputPath, `${D}/tables.jsonl`);
    assert.deepEqual(out.manifest, { run_id: "r1", domain_prefix: "PNPT", contract_version: "1", table_count: 2 });
    assert.ok(readFileSync(join(root, D, "tables.jsonl")).equals(b.tables));
    assert.ok(readFileSync(join(root, D, "context.md")).equals(b.context));
    assert.ok(readFileSync(join(root, D, "manifest.json")).equals(b.manifest));
    assert.equal(readFileSync(join(root, D, "tables.jsonl"), "utf8").includes("\r"), false);

    assert.equal((await post("/api/metadata/import-bundle", { files: b.files })).status, 409);
    writeFileSync(join(root, D, "context.md"), "changed");
    assert.equal((await post("/api/metadata/import-bundle", { files: b.files })).status, 409);
    assert.equal(readFileSync(join(root, D, "context.md"), "utf8"), "changed");

    assert.equal((await post("/api/metadata/import-bundle", { files: b.files, overwrite: true })).status, 201);
    assert.ok(readFileSync(join(root, D, "context.md")).equals(b.context));
    assert.deepEqual(readdirSync(join(root, D)).sort(), ["context.md", "manifest.json", "tables.jsonl"]);
  }),
);

test(
  "a hash mismatch writes nothing",
  withWeb({}, async ({ root, post }) => {
    const r = await post("/api/metadata/import-bundle", { files: bundle(true).files });
    assert.equal(r.status, 400);
    const out = await json(r);
    assert.ok(Array.isArray(out.problems) && out.problems.some((p: string) => p.includes("context.md")));
    assert.equal(existsSync(join(root, "metadata/pnpt")), false);
  }),
);

test(
  "a failing destination leaves nothing replaced",
  withWeb({ "metadata/pnpt/r1/manifest.json/keep.txt": "x" }, async ({ root, post }) => {
    // manifest.json is a directory, so its write must fail; the other two must not be left behind.
    const r = await post("/api/metadata/import-bundle", { files: bundle().files, overwrite: true });
    assert.notEqual(r.status, 201);
    assert.equal(existsSync(join(root, D, "tables.jsonl")), false);
    assert.equal(existsSync(join(root, D, "context.md")), false);
    assert.deepEqual(readdirSync(join(root, D)), ["manifest.json"]);
  }),
);

test(
  "approved-file downloads exact bytes as an attachment and refuses bad paths",
  withWeb({}, async ({ root, get, post }) => {
    const bytes = Buffer.from('{"a":1}\n{"b":2}\n', "utf8");
    await post("/api/metadata/import-bundle", { files: bundle().files });
    writeFileSync(join(root, D, "approved.jsonl"), bytes);
    const r = await get(`/api/metadata/approved-file?path=${encodeURIComponent(`${D}/approved.jsonl`)}`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-disposition") ?? "", /^attachment; filename="approved\.jsonl"/);
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(bytes));
    assert.equal((await get(`/api/metadata/approved-file?path=${encodeURIComponent("../outside.jsonl")}`)).status, 400);
    assert.equal((await get(`/api/metadata/approved-file?path=${encodeURIComponent(`${D}/context.md`)}`)).status, 400);
    assert.equal((await get("/api/metadata/approved-file")).status, 400);
  }),
);
