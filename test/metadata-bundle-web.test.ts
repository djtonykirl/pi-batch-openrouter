import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import test, { mock, type TestContext } from "node:test";
import type { BatchConfig } from "../src/config.js";
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
import { bundleInfoFor, metadataInboxText } from "../src/web/ui.js";
import { FAKE_KEY, FakeOpenRouter, makeConfig } from "./fixtures/fake-openrouter.js";
import { metadataWorkspace } from "./fixtures/metadata.js";
import { rm } from "./helpers.js";

interface Env {
  root: string;
  get: (p: string, extra?: Record<string, string>) => Promise<Response>;
  post: (p: string, body?: unknown, extra?: Record<string, string>) => Promise<Response>;
  anon: (p: string, method?: string) => Promise<Response>;
}

function withWeb(
  extra: Record<string, string>,
  fn: (e: Env, t: TestContext) => Promise<void>,
  over?: (c: BatchConfig) => void,
): (t: TestContext) => Promise<void> {
  return async (t) => {
    const root = metadataWorkspace(extra);
    let web: BatchWebServer | undefined;
    try {
      const fake = new FakeOpenRouter();
      const cfg = makeConfig(over);
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
      await fn({ root, get, post, anon }, t);
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

    writeFileSync(join(root, D, "tables.jsonl"), "tampered tables");
    writeFileSync(join(root, D, "manifest.json"), "tampered manifest");
    assert.equal((await post("/api/metadata/import-bundle", { files: b.files, overwrite: true })).status, 201);
    assert.ok(readFileSync(join(root, D, "context.md")).equals(b.context));
    assert.ok(readFileSync(join(root, D, "tables.jsonl")).equals(b.tables));
    assert.ok(readFileSync(join(root, D, "manifest.json")).equals(b.manifest));
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
  "a destination that is a directory is refused by the pre-check and nothing is written",
  withWeb({ "metadata/pnpt/r1/manifest.json/keep.txt": "x" }, async ({ root, post }) => {
    // manifest.json is a directory, so the pre-check refuses the whole import; the other two must not be written.
    const r = await post("/api/metadata/import-bundle", { files: bundle().files, overwrite: true });
    assert.equal(r.status, 400);
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

test(
  "approved-file refuses a .jsonl name that is a symlink to a non-.jsonl file",
  withWeb({}, async ({ root, get }, t) => {
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs", "notes.md"), "secret notes");
    try {
      symlinkSync(join(root, "docs", "notes.md"), join(root, "docs", "x.jsonl"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("cannot create symlinks on this platform");
        return;
      }
      throw err;
    }
    const r = await get(`/api/metadata/approved-file?path=${encodeURIComponent("docs/x.jsonl")}`);
    assert.equal(r.status, 400);
  }),
);

const GOV = join("test", "fixtures", "governance");

/** A bundle from the governance contract's v1 fixtures, with their real sha256 and sizes. */
function governanceBundle() {
  const tables = readFileSync(join(GOV, "tables.v1.valid.jsonl"));
  const context = readFileSync(join(GOV, "context.v1.fixture.md"));
  const manifest = Buffer.from(
    JSON.stringify({
      run_id: "r1",
      domain_prefix: "PNPT",
      contract_version: "1",
      files: [
        { path: "tables.jsonl", sha256: sha256Hex(tables), bytes: tables.length },
        { path: "context.md", sha256: sha256Hex(context), bytes: context.length },
      ],
      table_count: tables.toString("utf8").trim().split("\n").length,
      created_ts: "2026-10-29T00:00:00Z",
    }),
    "utf8",
  );
  const b64 = (name: string, b: Buffer) => ({ name, contentBase64: b.toString("base64") });
  return [b64("tables.jsonl", tables), b64("context.md", context), b64("manifest.json", manifest)];
}

test(
  "the page has the Import Databricks export and Download approved.jsonl controls, wired by data-action",
  withWeb({}, async ({ get }) => {
    const html = await (await get("/")).text();
    assert.equal(/\son(click|change|input|submit|load|error)\s*=/i.test(html), false);
    assert.match(html, /<button[^>]*data-action="importMetadataBundle"[^>]*>Import Databricks export<\/button>/);
    assert.match(html, /<input type="file" id="metadataBundleInput" multiple/);
    for (const needle of [
      '"importMetadataBundle"',
      '"downloadMetadataApproved"',
      '"confirmMetadataBundleOverwrite"',
      '"cancelMetadataBundleOverwrite"',
      'act("downloadMetadataApproved"',
      ">Download approved.jsonl<",
      "/api/metadata/import-bundle",
      "/api/metadata/approved-file",
      "/api/metadata/bundle-info",
      "metadataCatalogInput",
    ]) {
      assert.ok(html.includes(needle), `page mentions ${needle}`);
    }
    assert.equal(/window\.confirm\s*\(/.test(html), false);
  }),
);

test(
  "bundle-info needs a session and refuses a foreign origin",
  withWeb({}, async ({ anon, get }) => {
    assert.equal((await anon("/api/metadata/bundle-info?contextPath=a.md")).status, 401);
    assert.equal((await get("/api/metadata/bundle-info?contextPath=a.md", { Origin: "http://evil.example" })).status, 403);
  }),
);

test(
  "bundle-info returns the IDs for an imported bundle and {} otherwise",
  withWeb({ "metadata/plain/context.md": "# ctx\n", "metadata/bad/context.md": "# ctx\n","metadata/bad/manifest.json": "SECRET-NOT-JSON" }, async ({ get, post }) => {
    assert.equal((await post("/api/metadata/import-bundle", { files: bundle().files })).status, 201);
    const info = (p: string) => get(`/api/metadata/bundle-info?contextPath=${encodeURIComponent(p)}`);
    const r = await info(`${D}/context.md`);
    assert.equal(r.status, 200);
    assert.deepEqual(await json(r), { run_id: "r1", domain_prefix: "PNPT", contract_version: "1", table_count: 2 });

    const none = await info("metadata/plain/context.md");
    assert.equal(none.status, 200);
    assert.deepEqual(await json(none), {});
    const bad = await info("metadata/bad/context.md");
    assert.equal(bad.status, 200);
    const badText = await bad.text();
    assert.deepEqual(JSON.parse(badText), {});
    assert.equal(badText.includes("SECRET"), false);

    assert.equal((await get("/api/metadata/bundle-info")).status, 400);
    const outside = await info("../outside.md");
    assert.equal(outside.status, 400);
  }),
);

test(
  "approved-file check=1 reports existence without sending the file",
  withWeb({}, async ({ root, get, post }) => {
    await post("/api/metadata/import-bundle", { files: bundle().files });
    const p = `${D}/approved.jsonl`;
    const missing = await get(`/api/metadata/approved-file?check=1&path=${encodeURIComponent(p)}`);
    assert.equal(missing.status, 400);
    writeFileSync(join(root, p), '{"a":1}\n');
    const ok = await get(`/api/metadata/approved-file?check=1&path=${encodeURIComponent(p)}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-disposition"), null);
    assert.deepEqual(await json(ok), { path: p, bytes: 8 });
  }),
);

test(
  "a dry run of the imported governance fixtures returns no blockers",
  withWeb({}, async ({ post }) => {
    const imp = await post("/api/metadata/import-bundle", { files: governanceBundle() });
    assert.equal(imp.status, 201);
    const { contextPath, inputPath, manifest } = await json(imp);
    assert.equal(manifest.table_count, 3);
    const r = await post("/api/jobs/metadata", { context: contextPath, input: inputPath, mode: "dryrun" });
    const out = await json(r);
    assert.equal(r.status, 200, String(out.error));
    assert.deepEqual(out.blockers, []);
  }),
);

test("metadataInboxText shows the inbox path from the manifest, or explains how to find it", () => {
  assert.equal(
    metadataInboxText({ run_id: "r1", domain_prefix: "PNPT" }, "dev_catalog"),
    "Databricks inbox: /Volumes/dev_catalog/lighthouse_governance/metadata/inbox/PNPT/r1/approved.jsonl",
  );
  assert.equal(
    metadataInboxText({ run_id: "r1", domain_prefix: "PNPT" }, "  "),
    "Databricks inbox: /Volumes/<catalog>/lighthouse_governance/metadata/inbox/PNPT/r1/approved.jsonl",
  );
  const none = metadataInboxText({}, "dev_catalog");
  assert.match(none, /no manifest\.json/i);
  assert.match(none, /\/Volumes\/dev_catalog\/lighthouse_governance\/metadata\/inbox\/<PREFIX>\/<run_id>\/approved\.jsonl/);
});

test(
  "bundle-info falls back to {} when the manifest cannot be read",
  withWeb({}, async ({ get, post }) => {
    assert.equal((await post("/api/metadata/import-bundle", { files: bundle().files })).status, 201);
    const orig = fs.readFileSync;
    const m = mock.method(fs, "readFileSync", ((...a: Parameters<typeof fs.readFileSync>) => {
      if (String(a[0]).endsWith("manifest.json")) throw Object.assign(new Error("EACCES: denied secret-path"), { code: "EACCES" });
      return orig(...a);
    }) as typeof fs.readFileSync);
    syncBuiltinESMExports();
    try {
      const r = await get(`/api/metadata/bundle-info?contextPath=${encodeURIComponent(`${D}/context.md`)}`);
      assert.equal(r.status, 200);
      assert.deepEqual(await json(r), {});
    } finally {
      m.mock.restore();
      syncBuiltinESMExports();
    }
  }),
);

test("bundleInfoFor uses cached manifest IDs only for the same context file", () => {
  const cache = { contextPath: "metadata/pnpt/r1/context.md", info: { run_id: "r1", domain_prefix: "PNPT" } };
  assert.deepEqual(bundleInfoFor(cache, "metadata/pnpt/r1/context.md"), cache.info);
  assert.equal(bundleInfoFor(cache, "metadata/abcd/r2/context.md"), null);
  assert.equal(bundleInfoFor(cache, ""), null);
  assert.equal(bundleInfoFor(null, "metadata/pnpt/r1/context.md"), null);
  // Another job's IDs never reach this job's inbox line.
  assert.match(metadataInboxText(bundleInfoFor(cache, "metadata/abcd/r2/context.md"), "cat"), /no manifest\.json/);
});

test(
  "the handoff card keeps the inbox line on the displayed job and re-checks before downloading",
  withWeb({}, async ({ get }) => {
    const html = await (await get("/")).text();
    const handoff = html.slice(html.indexOf("// ---- Download approved.jsonl and the Databricks inbox line ----"));
    // The download action carries no job ID, and the page embeds the same bundleInfoFor the tests run.
    assert.ok(html.includes('act("downloadMetadataApproved")'));
    assert.ok(html.includes(bundleInfoFor.toString()));
    // A late bundle-info answer for another job is not rendered; selecting a job clears both caches.
    assert.ok(handoff.includes("if (state.selectedJobId !== j.localId) return;"));
    assert.ok(html.includes("if (localId !== state.selectedJobId) clearMetadataHandoffCaches();"));
    assert.ok(handoff.includes("renderInboxLine(displayedJob())"));
    // The download probes first and only then creates the link.
    const dl = handoff.slice(handoff.indexOf("window.downloadMetadataApproved"));
    assert.ok(dl.indexOf("probeApproved(p)") > 0 && dl.indexOf("probeApproved(p)") < dl.indexOf('createElement("a")'));
  }),
);

test(
  "bundle-info returns {} for a context file and manifest outside the workspace",
  withWeb(
    {},
    async ({ get }) => {
      const outside = mkdtempSync(join(tmpdir(), "bundle-outside-"));
      try {
        writeFileSync(join(outside, "context.md"), "# ctx\n");
        writeFileSync(join(outside, "manifest.json"), JSON.stringify({ run_id: "r1", domain_prefix: "PNPT", contract_version: "1", table_count: 2 }));
        const r = await get(`/api/metadata/bundle-info?contextPath=${encodeURIComponent(join(outside, "context.md"))}`);
        assert.equal(r.status, 200);
        assert.deepEqual(await json(r), {});
      } finally {
        rm(outside);
      }
    },
    (c) => {
      c.security.allowOutsideWorkspace = true;
    },
  ),
);
