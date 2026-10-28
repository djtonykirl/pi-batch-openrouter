import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import test from "node:test";
import * as vm from "node:vm";
import { ArtifactService } from "../src/artifacts/service.js";
import { ArtifactStore } from "../src/artifacts/store.js";
import { ChatService } from "../src/chat/service.js";
import { ThreadStore } from "../src/chat/store.js";
import type { BatchConfig } from "../src/config.js";
import { buildContextPackage } from "../src/context/package.js";
import { retentionLine } from "../src/dashboard.js";
import { ModelCatalog, type CatalogData } from "../src/models/catalog.js";
import { OpenRouterBatchClient } from "../src/openrouter/client.js";
import { formatPrivacyPolicy } from "../src/openrouter/routing.js";
import { BatchPoller } from "../src/poller.js";
import { batchModelCandidates, fallbackPickerEntry, pickerEntries, PRIVACY_NOTICE, PRIVACY_SETTINGS_URL } from "../src/privacy/commands.js";
import { neverReachedOpenRouter, RETENTION_KEPT, RETENTION_NOT_APPLICABLE } from "../src/privacy/policy.js";
import { JobRegistry } from "../src/registry.js";
import { BatchService, previewPrivacy } from "../src/service.js";
import type { JobManifest } from "../src/types.js";
import { BatchWebServer, inspectWorkspaceFiles } from "../src/web/server.js";
import { createCoalescer, failureStates, privacyNoticeHtml, renderWebUiHtml } from "../src/web/ui.js";
import { FAKE_KEY, FakeOpenRouter, accepted, makeConfig, makeService } from "./fixtures/fake-openrouter.js";
import { config, rm, tempWorkspace, writeFiles } from "./helpers.js";

const GEMINI = "google/gemini-3.8-flash";
const CLAUDE = "anthropic/claude-opus-5.5";

/** The walk-through's catalog: Gemini's batch endpoint is on the ZDR list, Claude's (anthropic) is not. */
const ZDR_CATALOG: CatalogData = {
  models: [
    { id: `${GEMINI}:batch`, name: "Gemini 3.8 Flash (batch)", free: false },
    { id: GEMINI, name: "Gemini 3.8 Flash", free: false },
    { id: `${CLAUDE}:batch`, name: "Claude Opus 5.5 (batch)", free: false },
  ],
  zdr: [{ model: GEMINI, provider: "google-vertex/global" }],
  batchEndpoints: { [GEMINI]: ["google-vertex/global"], [CLAUDE]: ["anthropic"] },
} as CatalogData;

const html = () => renderWebUiHtml({ csrfToken: "t", workspaceRoot: "/w" });
const script = () => [...html().matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]!)[0]!;

interface Env {
  root: string;
  cfg: BatchConfig;
  fake: FakeOpenRouter;
  batch: BatchService;
  chat: ChatService;
  store: ThreadStore;
  get: (p: string) => Promise<Response>;
  post: (p: string, body?: unknown) => Promise<Response>;
}

/** A standalone-like server (no Pi known models) over a stub catalog. */
function withWeb(data: CatalogData, fn: (e: Env) => Promise<void>, over: (c: BatchConfig) => void = () => {}): () => Promise<void> {
  return async () => {
    const root = tempWorkspace();
    writeFiles(root, { "src/a.ts": "export const a = 1;\n" });
    let web: BatchWebServer | undefined;
    try {
      const fake = new FakeOpenRouter();
      fake.submitReplies = [async () => accepted("batch_1")];
      const cfg = makeConfig(over);
      const catalog = new ModelCatalog({ fetch: async () => data, file: join(root, "catalog.json") });
      await catalog.load();
      const batch = new BatchService({
        registry: new JobRegistry(join(root, ".pi", "batches")),
        workspaceRoot: root,
        getConfig: () => cfg,
        resolveApiKey: async () => FAKE_KEY,
        createClient: (apiKey, timeoutMs) => new OpenRouterBatchClient({ apiKey, fetchImpl: fake.fetch, timeoutMs }),
        gitIgnored: () => new Set(),
        catalog,
      });
      const store = new ThreadStore(join(root, ".pi/batches/threads"));
      const chat = new ChatService({ store, batch, workspaceRoot: root, getConfig: () => cfg });
      web = new BatchWebServer({
        workspaceRoot: root,
        service: batch,
        chat,
        chatStore: store,
        artifacts: new ArtifactService({ batch, workspaceRoot: root, getConfig: () => cfg, store: new ArtifactStore(join(root, ".pi/batches/artifacts")) }),
        poller: new BatchPoller(() => batch, () => false),
        catalog,
        getConfig: () => cfg,
      });
      const base = await web.start(0, "127.0.0.1");
      const launch = await globalThis.fetch(web.createLaunchUrl()!, { redirect: "manual" });
      const cookie = (launch.headers.get("set-cookie") ?? "").split(";")[0]!;
      const get = (p: string) => globalThis.fetch(base + p, { headers: { Cookie: cookie } });
      const post = (p: string, body: unknown = {}) =>
        globalThis.fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json", "X-Batch-Token": web!.csrfToken, Cookie: cookie }, body: JSON.stringify(body) });
      await fn({ root, cfg, fake, batch, chat, store, get, post });
    } finally {
      await web?.stop();
      rm(root);
    }
  };
}

const zdr = (c: BatchConfig) => {
  c.privacy.level = "zdr";
};

// ------------------------------------------------------------------ 1. batch models from the catalog

test("1: batchModelCandidates adds every catalog :batch model (by base ID) to the sources, deduplicated", async () => {
  const root = tempWorkspace();
  try {
    const catalog = new ModelCatalog({ fetch: async () => ZDR_CATALOG, file: join(root, "c.json") });
    await catalog.load();
    const snap = catalog.snapshot();
    assert.deepEqual(batchModelCandidates(snap, [CLAUDE, "x/y", CLAUDE]), [CLAUDE, "x/y", GEMINI]);
    // The TUI picker's list (pickModel uses exactly these two calls).
    const entries = pickerEntries(snap, batchModelCandidates(snap, [CLAUDE]), "zdr", false);
    const gem = entries.find((e) => e.id === GEMINI)!;
    assert.deepEqual(gem.labels, ["batch", "ZDR"]);
    assert.equal(gem.blocked, undefined);
    assert.match(entries.find((e) => e.id === CLAUDE)!.blocked ?? "", /^Privacy level zdr: anthropic\/claude-opus-5.5 has no batch endpoint on OpenRouter's ZDR list/);
    // Selectable first, then alphabetical within each group.
    assert.deepEqual(entries.map((e) => e.id), [GEMINI, CLAUDE]);
  } finally {
    rm(root);
  }
});

test("1: pickerEntries orders selectable entries first, then alphabetically", () => {
  const entries = pickerEntries(undefined, ["b/two", "a/one", "c/three:free"], "standard", false);
  assert.deepEqual(entries.map((e) => e.id), ["a/one", "b/two", "c/three:free"]);
  const strict = pickerEntries(undefined, ["b/two", "a/one"], "no-training", false);
  assert.ok(strict.every((e) => e.blocked));
  assert.deepEqual(strict.map((e) => e.id), ["a/one", "b/two"]);
});

test(
  "1: GET /api/models at zdr lists the catalog's Gemini batch model as selectable [ZDR] and Claude as blocked",
  withWeb(ZDR_CATALOG, async ({ get }) => {
    const res = (await (await get("/api/models")).json()) as { level: string; entries: Array<{ id: string; route: string; labels: string[]; blocked?: string }> };
    assert.equal(res.level, "zdr");
    const gem = res.entries.find((e) => e.id === GEMINI);
    assert.ok(gem, "Gemini is offered");
    assert.equal(gem.route, "batch");
    assert.deepEqual(gem.labels, ["batch", "ZDR"]);
    assert.equal(gem.blocked, undefined);
    assert.match(res.entries.find((e) => e.id === CLAUDE)?.blocked ?? "", /^Privacy level zdr: /);
    assert.equal(res.entries[0]!.id, GEMINI, "selectable entries come first");
    const boot = (await (await get("/api/bootstrap")).json()) as { models: string[] };
    assert.ok(boot.models.includes(GEMINI), "the model datalist offers it too");
  }, zdr),
);

// ------------------------------------------------------------------ 2. modal stacking

test("2: the workspace picker stacks above the New Batch Job studio", () => {
  const page = html();
  assert.match(page, /#workspacePickerModal \{ z-index: 110; \}/);
  assert.match(page, /\.modal-backdrop \{[^}]*z-index: 100;/);
  const s = script();
  assert.match(s, /function openModal\(id\) \{\s*const el = document\.getElementById\(id\);\s*el\.style\.zIndex = String\(\+\+modalZ\);/);
  assert.ok(s.includes('openModal("workspacePickerModal")') && s.includes('openModal("newJobModal")'));
  assert.equal(s.includes('classList.add("open")'), true, "only inside openModal");
  assert.equal(s.split('classList.add("open")').length - 1, 1);
});

// ------------------------------------------------------------------ 3. new threads on a refused default

test("3: fallbackPickerEntry prefers a ZDR batch entry at zdr, then any batch entry, then a free one", () => {
  const e = (id: string, route: "batch" | "immediate", labels: string[], blocked?: string) => ({ id, route, labels, ...(blocked ? { blocked } : {}) });
  assert.equal(fallbackPickerEntry([e("a/x", "batch", ["batch"]), e("b/y", "batch", ["batch", "ZDR"])], "zdr")?.id, "b/y");
  assert.equal(fallbackPickerEntry([e("a/x", "batch", ["batch"]), e("b/y", "batch", ["batch", "ZDR"])], "standard")?.id, "a/x");
  assert.equal(fallbackPickerEntry([e("a/x", "batch", ["batch"], "no"), e("f:free", "immediate", ["free"])], "zdr")?.id, "f:free");
  assert.equal(fallbackPickerEntry([e("a/x", "batch", ["batch"], "no")], "zdr"), undefined);
});

test(
  "3: POST /api/threads with no model at zdr starts on Gemini with a notice; GET /api/privacy names the default's refusal",
  withWeb(ZDR_CATALOG, async ({ post, get, store }) => {
    const r = await post("/api/threads", {});
    assert.equal(r.status, 201);
    const body = (await r.json()) as { thread: { id: string; model: string }; notice?: string; warning?: string };
    assert.equal(body.thread.model, GEMINI);
    assert.equal(store.read(body.thread.id).model, GEMINI);
    assert.match(body.notice ?? "", /^Started on google\/gemini-3\.8-flash \[batch, ZDR\]: the default model anthropic\/claude-opus-5\.5 is refused at privacy level zdr \(Privacy level zdr: /);
    assert.equal(body.warning, undefined);

    const p = (await (await get("/api/privacy")).json()) as { defaultModelRefusal?: string };
    assert.match(p.defaultModelRefusal ?? "", /^Privacy level zdr: anthropic\/claude-opus-5\.5 has no batch endpoint on OpenRouter's ZDR list/);
  }, zdr),
);

test(
  "3: with nothing selectable the thread keeps the default and the response carries a warning",
  withWeb({ models: [{ id: `${CLAUDE}:batch`, name: "c", free: false }], zdr: [], batchEndpoints: { [CLAUDE]: ["anthropic"] } } as CatalogData, async ({ post }) => {
    const body = (await (await post("/api/threads", {})).json()) as { thread: { model: string }; notice?: string; warning?: string };
    assert.equal(body.thread.model, CLAUDE);
    assert.equal(body.notice, undefined);
    assert.match(body.warning ?? "", /^The default model anthropic\/claude-opus-5\.5 is refused at privacy level zdr and no other model is selectable: Privacy level zdr: /);
  }, zdr),
);

test(
  "3: at standard nothing changes: the default is kept, no notice, no defaultModelRefusal",
  withWeb(ZDR_CATALOG, async ({ post, get }) => {
    const body = (await (await post("/api/threads", {})).json()) as { thread: { model: string }; notice?: string; warning?: string };
    assert.equal(body.thread.model, CLAUDE);
    assert.equal(body.notice ?? body.warning, undefined);
    assert.equal(((await (await get("/api/privacy")).json()) as { defaultModelRefusal?: string }).defaultModelRefusal, undefined);
  }),
);

test("3: the page shows the new-thread notice and the default-model warning", () => {
  const s = script();
  assert.ok(s.includes("if (res.notice) alertEl.innerHTML"));
  assert.ok(s.includes("p.defaultModelRefusal"));
  assert.ok(html().includes('id="defaultModelWarning"'));
});

// ------------------------------------------------------------------ 4. dry-run privacy preview

test("4: previewPrivacy refuses Claude and pins Gemini at zdr, from the same decision persistJob makes", async () => {
  const root = tempWorkspace();
  try {
    const catalog = new ModelCatalog({ fetch: async () => ZDR_CATALOG, file: join(root, "c.json") });
    await catalog.load();
    const cfg = makeConfig(zdr);
    const base = { config: cfg, privacy: { level: "zdr" as const, accountNoTraining: false }, catalog: catalog.view() };
    const refused = previewPrivacy({ ...base, draft: { kind: "goal", model: CLAUDE } });
    assert.equal(refused.ok, false);
    assert.match(refused.reason ?? "", /^Privacy level zdr: anthropic\/claude-opus-5\.5 has no batch endpoint/);
    assert.deepEqual(previewPrivacy({ ...base, draft: { kind: "goal", model: GEMINI } }), { ok: true, enforcement: "pinned to ZDR providers: google-vertex/global" });
    // Free models are chat-only, as at submit.
    assert.equal(previewPrivacy({ ...base, draft: { kind: "goal", model: "x/y:free" } }).ok, false);
  } finally {
    rm(root);
  }
});

test(
  "4: a zdr dry run returns the refusal for Claude and the pin for Gemini, and writes nothing",
  withWeb(ZDR_CATALOG, async ({ post, batch, root }) => {
    const before = fs.readdirSync(join(root, ".pi", "batches")).sort();
    const ask = (model: string) => post("/api/jobs/ask", { objective: "Review", files: ["src/a.ts"], model, mode: "dryrun" });
    const claude = (await (await ask(CLAUDE)).json()) as { privacy: { ok: boolean; reason?: string } };
    assert.equal(claude.privacy.ok, false);
    assert.match(claude.privacy.reason ?? "", /^Privacy level zdr: anthropic\/claude-opus-5\.5 has no batch endpoint/);
    const gem = (await (await ask(GEMINI)).json()) as { privacy: { ok: boolean; enforcement?: string } };
    assert.deepEqual(gem.privacy, { ok: true, enforcement: "pinned to ZDR providers: google-vertex/global" });

    const map = (await (await post("/api/jobs/map-files", { objective: "Review", files: ["src/a.ts"], model: CLAUDE, mode: "dryrun" })).json()) as { privacy: { ok: boolean } };
    assert.equal(map.privacy.ok, false);
    const ds = (await (await post("/api/jobs/dataset", { workflow: "none", input: "none.csv", model: CLAUDE, mode: "dryrun" })).json()) as { privacy?: { ok: boolean } };
    if (ds.privacy) assert.equal(ds.privacy.ok, false);

    assert.equal(batch.registry.list().jobs.length, 0);
    assert.deepEqual(fs.readdirSync(join(root, ".pi", "batches")).sort(), before, "nothing written");
  }, zdr),
);

test("4: the dry-run box shows a privacy refusal as a blocker, never as Validated", () => {
  const s = script();
  assert.ok(s.includes("const privacyBlock = res.privacy && !res.privacy.ok ? [res.privacy.reason] : [];"));
  assert.ok(s.includes("const blockers = (res.blockers || []).concat(privacyBlock);"));
  assert.ok(s.indexOf("if (blockers.length > 0)") < s.indexOf("Dry-Run Validated"));
});

// ------------------------------------------------------------------ 5. live updates

test("5: createCoalescer runs once for a burst of requests, and once more for a call during a run", async () => {
  let runs = 0;
  let release: () => void = () => {};
  const c = createCoalescer(
    async () => {
      runs++;
      await new Promise<void>((r) => (release = r));
    },
    20,
  );
  for (let i = 0; i < 5; i++) c.request();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(runs, 1, "five live events, one refresh");
  const during = c.now();
  c.request();
  c.now();
  release();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(runs, 2, "calls during a run add exactly one more");
  release();
  await during;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(runs, 2, "the request made during the run was served by it");

  // A user action (now) cancels a pending live request instead of adding a second refresh.
  let n = 0;
  const d = createCoalescer(async () => void n++, 20);
  d.request();
  await d.now();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(n, 1);
});

test("5: one EventSource, one handler; the connect event does not refresh; refreshes go through the coalescer", () => {
  const s = script();
  assert.equal(s.split("new EventSource(").length - 1, 1);
  assert.equal(s.split("es.onmessage").length - 1, 1);
  assert.equal(/addEventListener\("message"/.test(s), false);
  assert.equal(s.split("connectSse();").length - 1, 1);
  assert.ok(s.includes('if (payload.type === "connected")'));
  assert.ok(s.includes("liveRefresh.request();"));
  assert.ok(s.includes("const liveRefresh = createCoalescer(refreshStateNow, 250);"));
  // The page calls /api/bootstrap from bootstrap() and the refresh only.
  assert.equal(s.split('api("/api/bootstrap")').length - 1, 2);
  assert.doesNotThrow(() => new vm.Script(s));
});

// ------------------------------------------------------------------ 6. messages

test(
  "6a: a refused chat send returns the reason; the page shows 'Turn not submitted'",
  withWeb(ZDR_CATALOG, async ({ chat, post }) => {
    const t = chat.newThread();
    const r = (await (await post(`/api/threads/${t.id}/send`, { text: "hello" })).json()) as { queued: boolean; jobId?: string; error?: string };
    assert.equal(r.queued, false);
    assert.equal(r.jobId, undefined);
    assert.match(r.error ?? "", /^The turn could not be submitted: Privacy level zdr: /);
    assert.ok(script().includes('showToast("Turn not submitted: " + (res.error'));
    assert.equal(script().includes('"Submitted batch turn " + res.jobId);'), true);
  }, zdr),
);

test("6b: only the current turn failure offers Retry; superseded failures are muted", () => {
  const entries = [
    { type: "user" },
    { type: "failure", purpose: "turn" },
    { type: "failure", purpose: "turn" },
    { type: "failure", purpose: "compact" },
    { type: "assistant" },
  ];
  assert.deepEqual(failureStates(entries, { message: "x" }), { 1: "superseded", 2: "retry", 3: "current" });
  // After Retry, lastFailure is cleared: the old banner loses its button.
  assert.deepEqual(failureStates(entries, undefined), { 1: "superseded", 2: "superseded", 3: "current" });
  assert.deepEqual(failureStates([{ type: "failure", purpose: "compact" }, { type: "compaction" }], undefined), { 0: "superseded" });
  const s = script();
  assert.ok(s.includes("const failures = failureStates(entries, detail.thread.lastFailure);"));
  assert.ok(s.includes('<details class="failure-note">'));
});

test("6c: switching studio tabs clears the previous tab's result", () => {
  const s = script();
  const at = s.indexOf("state.jobStudioKind = btn.dataset.kind;");
  assert.ok(at > 0);
  assert.ok(s.slice(at, at + 200).includes('document.getElementById("jobDryRunOutput").innerHTML = "";'));
});

test("6d: a job that never reached OpenRouter: remote deletion is not applicable (web and /batch show)", () => {
  const base = { route: undefined, remoteDeletion: undefined, privacy: { level: "zdr", route: "batch", enforcement: "x" } } as unknown as JobManifest;
  const refused = { ...base, localStatus: "failed", error: { code: "submission_rejected_auth", message: "m" } } as JobManifest;
  assert.equal(neverReachedOpenRouter(refused), true);
  assert.equal(retentionLine(refused, true), RETENTION_NOT_APPLICABLE);
  assert.equal(RETENTION_NOT_APPLICABLE, "Remote deletion: not applicable (never reached OpenRouter)");
  // A submit with an unknown outcome MAY have reached OpenRouter.
  const unknown = { ...base, localStatus: "failed", error: { code: "submission_unknown", message: "m" } } as JobManifest;
  assert.equal(neverReachedOpenRouter(unknown), false);
  assert.equal(retentionLine(unknown, true), RETENTION_KEPT);
  assert.equal(neverReachedOpenRouter({ ...refused, providerBatchId: "b1" }), false);
  assert.equal(neverReachedOpenRouter({ ...base, localStatus: "previewed" } as JobManifest), false);
  const s = script();
  assert.ok(s.includes("function neverReachedOpenRouter("));
  assert.ok(s.includes('if (neverReachedOpenRouter(j)) return "not applicable (never reached OpenRouter)";'));
});

// ------------------------------------------------------------------ 7. wording

test("7a: the routing policy names the settings instead of 'X not required'", () => {
  const cfg = makeConfig();
  assert.equal(formatPrivacyPolicy(cfg, { level: "zdr", accountNoTraining: false }), "routing.requireZdr: off; routing.requireNoDataCollection: off");
});

test("7b: .ipynb is a known text extension", () => {
  const root = tempWorkspace();
  try {
    writeFiles(root, { "n.ipynb": JSON.stringify({ cells: [{ cell_type: "code", source: "x = 1", outputs: [] }] }) });
    const p = buildContextPackage({ workspaceRoot: root, objective: "o", files: ["n.ipynb"], contexts: [], includeInstructions: false, format: "markdown", config: config(), knownSecrets: [], gitIgnored: () => new Set() });
    assert.equal(p.warnings.some((w) => w.includes("unrecognised extension")), false);
  } finally {
    rm(root);
  }
});

test("7c: an OpenRouter 401 says the API key was rejected, keeping the raw detail", async () => {
  const root = tempWorkspace();
  writeFiles(root, { "src/a.ts": "export const a = 1;\n" });
  try {
    const fake = new FakeOpenRouter();
    const service = makeService(root, fake);
    fake.submitReplies = [{ status: 401, body: { error: { code: 401, message: "User not found." } } }];
    const job = await service.createJob(await service.prepare({ objective: "o", files: ["src/a.ts"], contexts: [], format: "markdown", includeInstructions: true }), { previewOnly: false });
    assert.equal(job.error?.code, "submission_rejected_auth");
    assert.equal(job.error?.message, "API key rejected by OpenRouter (HTTP 401: User not found.)");
  } finally {
    rm(root);
  }
});

test(
  "7c: the chat failure text carries the same wording",
  withWeb(ZDR_CATALOG, async ({ chat, post, fake, store }) => {
    fake.submitReplies = [{ status: 401, body: { error: { code: 401, message: "User not found." } } }];
    const t = chat.newThread();
    const r = (await (await post(`/api/threads/${t.id}/send`, { text: "hi" })).json()) as { error?: string };
    assert.match(r.error ?? "", /API key rejected by OpenRouter \(HTTP 401: User not found\.\)$/);
    assert.match(store.read(t.id).lastFailure?.message ?? "", /API key rejected by OpenRouter \(HTTP 401: User not found\.\)$/);
  }),
);

test("7d: the privacy notice shows the settings URL once, as the link", () => {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const out = privacyNoticeHtml(PRIVACY_NOTICE, PRIVACY_SETTINGS_URL, esc);
  assert.equal(out.split("openrouter.ai/settings/privacy").length - 1, 2, "once in href, once as the link text");
  assert.equal(out.split("<a ").length - 1, 1);
  assert.ok(out.startsWith("Privacy levels only tighten"));
  assert.ok(script().includes("privacyNoticeHtml(text,"));
});

// ------------------------------------------------------------------ 8-10. layout, accessibility, minor

test("8: the Ask objective is a full-width block field under its label", () => {
  const page = html();
  assert.match(page, /<label for="askObjectiveInput" style="display:block;[^"]*">Objective \/ Prompt<\/label>\s*<textarea id="askObjectiveInput" class="form-control" style="display:block; width:100%;/);
});

test("9: job and thread rows are keyboard reachable; the main fields have labels", () => {
  const page = html();
  const s = script();
  assert.ok(s.includes(`'<div class="list-item ' + sel + '" role="button" tabindex="0" data-job-id="'`));
  assert.ok(s.includes(`'<div class="list-item ' + sel + '" role="button" tabindex="0" data-thread-id="'`));
  assert.ok(s.includes('if (ev.key === "Enter" || ev.key === " ")'));
  assert.equal(s.split("onActivateKey(row,").length - 1, 2);
  for (const id of ["chatModelInput", "jobModelInput", "askObjectiveInput", "datasetWorkflowSelect", "datasetInputPath", "metadataContextInput", "metadataTablesInput", "jobProviderPinInput", "jobFormatSelect", "chatModelPicker", "settingsDefaultModel"]) {
    assert.ok(page.includes(`<label for="${id}"`), `label for ${id}`);
  }
  for (const id of ["threadPrivacyLevel", "threadSearchInput", "jobStatusFilter", "workspaceInspectorFilter", "pickerSearchInput"]) {
    assert.match(page, new RegExp(`id="${id}" aria-label="[^"]+"`), `aria-label on ${id}`);
  }
});

test(
  "10a: the privacy panel shows the routing policy line",
  withWeb(ZDR_CATALOG, async ({ get }) => {
    assert.ok(html().includes('id="routingPolicyLine"'));
    assert.ok(script().includes('document.getElementById("routingPolicyLine").textContent = p.routing ? p.routing.policy : "";'));
    const p = (await (await get("/api/privacy")).json()) as { routing: { policy: string } };
    assert.equal(p.routing.policy, "routing.requireZdr: off; routing.requireNoDataCollection: off");
  }),
);

test("10b: the project's batch config and chat instructions are not offered in the workspace picker", () => {
  const root = tempWorkspace();
  try {
    writeFiles(root, { ".pi/batch.config.json": "{}", ".pi/BATCH_CHAT.md": "be brief", "src/a.ts": "x" });
    const entries = inspectWorkspaceFiles(root, config());
    for (const rel of [".pi/batch.config.json", ".pi/BATCH_CHAT.md"]) {
      const e = entries.find((x) => x.relPath === rel);
      assert.ok(e, rel);
      assert.equal(e.selectable, false);
      assert.equal(e.excludedLayer, "config");
    }
    assert.equal(entries.find((x) => x.relPath === "src/a.ts")?.selectable, true);
  } finally {
    rm(root);
  }
});

test("10c: the page has an inline favicon", () => {
  assert.match(html(), /<link rel="icon" href="data:image\/svg\+xml,/);
});
