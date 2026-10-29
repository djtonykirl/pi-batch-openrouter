import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ArtifactService } from "../src/artifacts/service.js";
import { ArtifactStore } from "../src/artifacts/store.js";
import { CHAT_RETRY_HINT, ChatService, PROJECT_INSTRUCTIONS_FILE, SUBMISSION_UNKNOWN, SUBMISSION_UNKNOWN_ADVICE } from "../src/chat/service.js";
import { approvedGapsMessage } from "../src/metadata/outputs.js";
import { immediateZdrRefusal, resolveBatchProvider } from "../src/privacy/policy.js";
import { ThreadStore } from "../src/chat/store.js";
import type { BatchConfig } from "../src/config.js";
import { ModelCatalog, type CatalogData } from "../src/models/catalog.js";
import { OpenRouterBatchClient } from "../src/openrouter/client.js";
import { MAX_CONSECUTIVE_429 } from "../src/openrouter/immediate.js";
import { BatchPoller } from "../src/poller.js";
import { JobRegistry } from "../src/registry.js";
import { BatchService, IMMEDIATE_CHAT_ONLY } from "../src/service.js";
import { BatchWebServer } from "../src/web/server.js";
import { inflightHeadline, messageNumbers, metadataWrittenText, renderWebUiHtml } from "../src/web/ui.js";
import { webWording, webWordingPayload } from "../src/web/wording.js";
import { FAKE_KEY, FakeOpenRouter, accepted, makeConfig } from "./fixtures/fake-openrouter.js";
import { rm, tempWorkspace } from "./helpers.js";

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

const EMPTY_CATALOG = { models: [], zdr: [], batchEndpoints: {}, freeEndpoints: {} } as CatalogData;

/** A standalone-like web server over a stub catalog (as in web-ui-fixes.test.ts). */
function withWeb(fn: (e: Env) => Promise<void>, data: CatalogData = EMPTY_CATALOG, over: (c: BatchConfig) => void = () => {}): () => Promise<void> {
  return async () => {
    const root = tempWorkspace();
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

const page = () => renderWebUiHtml({ csrfToken: "t", workspaceRoot: "/w", nonce: "n" });

// ------------------------------------------------------------------ 4a: in-flight banner

test("4a: a rate-limited free-model turn names the route, the retry time and the attempt", () => {
  const at = new Date(2026, 9, 28, 14, 15, 0);
  assert.equal(
    inflightHeadline("turn", { route: "immediate", nextPollAt: at.toISOString(), consecutivePollFailures: 5 }, 8),
    "⏳ Free-model turn rate-limited by OpenRouter; retrying at 14:15 (rate limit 5 of 8)",
  );
  assert.equal(inflightHeadline("turn", { route: "immediate", consecutivePollFailures: 0 }, 8), "⏳ Free-model turn in flight");
  assert.equal(inflightHeadline("turn", { route: "batch", consecutivePollFailures: 0 }, 8), "⏳ Batch turn in flight");
  assert.equal(inflightHeadline("turn", undefined, 8), "⏳ Batch turn in flight");
  assert.equal(inflightHeadline("compaction", { route: "batch" }, 8), "⏳ Compaction in flight");
  // A batch compaction with failed polls (consecutivePollFailures > 0) is not called rate-limited.
  assert.equal(inflightHeadline("compaction", { route: "immediate", nextPollAt: at.toISOString(), consecutivePollFailures: 3 }, 8), "⏳ Compaction in flight");
});

test("4a: a poll problem comes first for every kind and route, with the retry time", () => {
  const at = new Date(2026, 9, 28, 9, 5, 0).toISOString();
  const err = { message: "HTTP 502: bad gateway" };
  assert.equal(inflightHeadline("turn", { route: "batch", nextPollAt: at, consecutivePollFailures: 2, lastPollError: err }, 8), "⚠ Batch turn: poll problem: HTTP 502: bad gateway; retrying at 09:05");
  assert.equal(inflightHeadline("turn", { route: "immediate", nextPollAt: at, consecutivePollFailures: 2, lastPollError: err }, 8), "⚠ Free-model turn: poll problem: HTTP 502: bad gateway; retrying at 09:05");
  assert.equal(inflightHeadline("compaction", { route: "batch", nextPollAt: at, lastPollError: err }, 8), "⚠ Compaction: poll problem: HTTP 502: bad gateway; retrying at 09:05");
  assert.equal(inflightHeadline("compaction", { route: "batch", lastPollError: err }, 8), "⚠ Compaction: poll problem: HTTP 502: bad gateway");
});

test("4a: the page embeds inflightHeadline with the real cap and no longer says 'Batch Turn in Flight'", () => {
  const html = page();
  assert.ok(html.includes(inflightHeadline.toString()));
  assert.ok(html.includes(`const MAX_RATE_LIMITS = ${MAX_CONSECUTIVE_429};`));
  assert.ok(html.includes("inflightHeadline(p ? \"turn\" : \"compaction\", activeJob, MAX_RATE_LIMITS)"));
  assert.ok(!html.includes("Batch Turn in Flight"));
});

// ------------------------------------------------------------------ 5: web messages name page controls, not commands

test("5: webWording rewords the real builders' messages for the page; other text is unchanged", () => {
  assert.equal(
    webWording(approvedGapsMessage(["a", "b"], 3, "B-1")),
    "2 of 3 table(s) have no usable proposal: a, b.\nRetry the failed items (Retry Failed Items button on this job), or tick Allow partial to include them with their existing values unchanged.",
  );
  assert.equal(webWording(`The reply job B-1 can no longer be read (gone). ${CHAT_RETRY_HINT}`), "The reply job B-1 can no longer be read (gone). Use Retry Turn.");
  assert.match(webWording(SUBMISSION_UNKNOWN_ADVICE), /only if the turn was not billed, use Retry anyway \(a plain retry is refused/);
  assert.doesNotMatch(webWording(SUBMISSION_UNKNOWN_ADVICE), /\/batch/);
  assert.equal(webWording(IMMEDIATE_CHAT_ONLY), "Free models run only in Batch Chat; batch jobs and workflows need a batch model");
  assert.equal(webWording(immediateZdrRefusal(undefined, "x/y:free")!), "Privacy level zdr: model catalog not loaded this session, so ZDR endpoints can't be verified (use Refresh models)");
  const noTraining = resolveBatchProvider({ level: "no-training", model: "x/y", accountNoTraining: false });
  assert.doesNotMatch(webWording(noTraining.ok ? "" : noTraining.reason), /\/batch/);
  assert.match(webWording(noTraining.ok ? "" : noTraining.reason), /\(attest in Workspace & Settings\)/);
  assert.equal(webWording("sample values will be sent at privacy level standard; consider /batch privacy zdr"), "sample values will be sent at privacy level standard; consider setting the privacy level to zdr in Workspace & Settings");
  assert.equal(webWording("Nothing to compact yet."), "Nothing to compact yet.");
});

test("5: webWordingPayload rewords message fields only, never transcript text or other strings", () => {
  const hint = CHAT_RETRY_HINT;
  const out = webWordingPayload({
    error: hint,
    warnings: [hint],
    entries: [{ type: "user", text: hint }],
    entries2: [{ blocked: hint }],
    privacy: { reason: hint },
    other: { reason: hint },
    catalog: { text: "models fresh (batch endpoints unknown for 1 model; /batch privacy refresh retries)" },
  }) as Record<string, unknown>;
  assert.deepEqual(out, {
    error: "Use Retry Turn.",
    warnings: ["Use Retry Turn."],
    entries: [{ type: "user", text: hint }],
    entries2: [{ blocked: "Use Retry Turn." }],
    privacy: { reason: "Use Retry Turn." },
    other: { reason: hint },
    catalog: { text: "models fresh (batch endpoints unknown for 1 model; Refresh models retries)" },
  });
});

test(
  "5: a refused web retry (secret in the project instructions) says 'then use Retry Turn.'",
  withWeb(async ({ root, chat, store, post }) => {
    const t = chat.newThread();
    store.update(t.id, (th) => {
      th.lastFailure = { purpose: "turn", code: "provider_error", message: "x", at: new Date().toISOString() };
    });
    fs.mkdirSync(join(root, ".pi"), { recursive: true });
    fs.writeFileSync(join(root, PROJECT_INSTRUCTIONS_FILE), "token ghp_abcdefghijklmnopqrstuvwxyz0123456789\n");
    const r = await post(`/api/threads/${t.id}/retry`, {});
    assert.equal(r.status, 400);
    const err = ((await r.json()) as { error: string }).error;
    assert.match(err, /, then use Retry Turn\.$/);
    assert.doesNotMatch(err, /\/batch chat/);
  }),
);

test("5: the CLI keeps its wording (the message builders are unchanged)", () => {
  assert.match(SUBMISSION_UNKNOWN_ADVICE, /\/batch chat retry --force/);
});

test(
  "5: the web thread view and web errors use page wording; the stored transcript keeps the CLI text",
  withWeb(async ({ chat, store, get, post }) => {
    const t = chat.newThread();
    store.update(t.id, (th, append) => {
      th.lastFailure = { purpose: "turn", code: SUBMISSION_UNKNOWN, message: "The turn failed. Use /batch chat retry.", at: new Date().toISOString() };
      append({ type: "failure", purpose: "turn", code: SUBMISSION_UNKNOWN, message: "The turn failed. Use /batch chat retry." });
    });
    const detail = (await (await get(`/api/threads/${t.id}`)).json()) as { thread: { lastFailure: { message: string } }; entries: Array<{ type: string; message?: string }> };
    assert.equal(detail.thread.lastFailure.message, "The turn failed. Use Retry Turn.");
    assert.equal(detail.entries.find((e) => e.type === "failure")!.message, "The turn failed. Use Retry Turn.");
    assert.equal(store.read(t.id).lastFailure!.message, "The turn failed. Use /batch chat retry.", "stored unchanged");

    const r = await post(`/api/threads/${t.id}/retry`, {});
    assert.equal(r.status, 400);
    const err = ((await r.json()) as { error: string }).error;
    assert.match(err, /use Retry anyway \(a plain retry is refused/);
    assert.doesNotMatch(err, /\/batch chat retry/);
  }),
);

// ------------------------------------------------------------------ 6: metadata handoff success line

test("6: the success line names the path, the artifact and (approved) the counts, as the CLI does", () => {
  assert.equal(
    metadataWrittenText("review", { path: "metadata/review.md", artifactId: "A-1", gaps: 2 }),
    "✅ Review written: metadata/review.md (artifact A-1)\n2 table(s) without a usable proposal are listed in it\nProposed metadata has not been applied to Databricks.",
  );
  assert.equal(
    metadataWrittenText("approved", { path: "metadata/approved.jsonl", artifactId: "A-2", sha256: "abc", tables: 3, counts: { keptExisting: 4, fromProposal: 5, nullApproved: 1 } }),
    "✅ Draft handoff written: metadata/approved.jsonl (artifact A-2, sha256 abc)\n3 table(s); values: 4 existing kept, 5 from proposals, 1 null\nThis is a draft for review; edit approved_* values, then validate it. Nothing has been applied to Databricks.",
  );
});

test("6: the result survives the live refresh that writing a file triggers (the card restores it)", () => {
  const html = page();
  assert.ok(html.includes(metadataWrittenText.toString()));
  assert.ok(html.includes("escapeHtml(metadataWrittenText(\"review\", res))"));
  assert.ok(html.includes("escapeHtml(metadataWrittenText(\"approved\", res))"));
  assert.ok(html.includes("state.metadataCard = {"), "metadataOutput keeps the result in state");
  assert.ok(html.includes("'<div id=\"metadataActionOutput\">' + (saved ? saved.html : \"\") + \"</div>\""), "metadataActionsCard restores it");
});

// ------------------------------------------------------------------ 8a: the top bar never wraps

test("8a: the top bar keeps one line: the badge truncates with its full text as a tooltip", () => {
  const html = page();
  assert.ok(html.includes(".topbar > * { white-space: nowrap; }"));
  assert.ok(html.includes("#badgePill { max-width: 260px; overflow: hidden; text-overflow: ellipsis; }"));
  assert.ok(html.includes("pill.title = pill.textContent;"));
});

// ------------------------------------------------------------------ 9: compact without window.prompt

test("9: Compact opens an in-page form (delegated data-action), never window.prompt, and is guarded against a second start", () => {
  const html = page();
  assert.ok(!/prompt\("Optional focus/.test(html), "no window.prompt");
  assert.ok(html.includes('id="compactThreadBtn" data-action="openCompactForm" data-args="[]"'));
  assert.ok(html.includes('id="compactSubmitBtn" data-action="submitCompact" data-args="[]"'));
  assert.ok(html.includes('id="compactCancelBtn" data-action="cancelCompact" data-args="[]"'));
  assert.ok(html.includes('<textarea id="compactFocusInput"'));
  assert.ok(html.includes('"openCompactForm", "submitCompact", "cancelCompact",'), "registered with the delegated click handler");
  assert.ok(html.includes("if (!state.activeThreadId || compactInFlight) return;"), "a second click while one runs does nothing");
  assert.ok(html.includes('document.getElementById("compactSubmitBtn").disabled = busy;'));
  assert.ok(!html.includes('getElementById("compactThreadBtn").addEventListener'), "no second, direct listener");
});

test(
  "9: the server refuses a second compaction while one is claimed (one at a time)",
  withWeb(async ({ chat, store, post }) => {
    const t = chat.newThread();
    store.update(t.id, (th) => {
      th.compacting = { throughSeq: 1, claimedAt: new Date().toISOString() };
    });
    const r = await post(`/api/threads/${t.id}/compact`, {});
    assert.equal(r.status, 400);
    assert.match(((await r.json()) as { error: string }).error, /Already compacting/);
  }),
);

// ------------------------------------------------------------------ 7: duplicate toasts

test("7: a toast already on screen is not added again", () => {
  const html = page();
  assert.ok(html.includes("if (Array.from(c.children).some((t) => t.textContent === msg)) return;"));
});

// ------------------------------------------------------------------ 10b: message numbers

test("10b: only user and assistant messages are numbered; model switches don't shift them", () => {
  const entries = [
    { type: "model", seq: 1 },
    { type: "model", seq: 2 },
    { type: "user", seq: 3 },
    { type: "assistant", seq: 4 },
    { type: "title", seq: 5 },
    { type: "user", seq: 6 },
    { type: "assistant", seq: 7 },
  ];
  const n = messageNumbers(entries);
  assert.deepEqual(n.of, { 3: 1, 4: 2, 6: 3, 7: 4 });
  assert.equal(n.through(5), 2);
  assert.equal(n.through(7), 4);
  assert.equal(n.through(0), 0);
  const html = page();
  assert.ok(html.includes(messageNumbers.toString()));
  assert.ok(html.includes("<strong>You</strong> · #' + numbers.of[e.seq]"));
  assert.ok(html.includes("(through #' + numbers.through(e.throughSeq)"));
});

// ------------------------------------------------------------------ 10c: job studio model default

const GEMINI = "google/gemini-3.8-flash";
const CLAUDE = "anthropic/claude-opus-5.5";
const ZDR_CATALOG = {
  models: [
    { id: `${GEMINI}:batch`, name: "Gemini (batch)", free: false },
    { id: `${CLAUDE}:batch`, name: "Claude (batch)", free: false },
    { id: "f/free:free", name: "Free", free: true },
  ],
  zdr: [
    { model: GEMINI, provider: "google-vertex/global" },
    { model: "f/free", provider: "p" },
  ],
  batchEndpoints: { [GEMINI]: ["google-vertex/global"], [CLAUDE]: ["anthropic"] },
  freeEndpoints: { "f/free": ["p"] },
} as CatalogData;

test(
  "10c: at zdr the job studio's model defaults to the first selectable batch model, with the new-thread notice text",
  withWeb(
    async ({ get }) => {
      const p = (await (await get("/api/privacy")).json()) as { defaultModelRefusal?: string; jobModelFallback?: { id: string; notice: string } };
      assert.ok(p.defaultModelRefusal);
      assert.deepEqual(p.jobModelFallback, {
        id: GEMINI,
        notice: `Model set to ${GEMINI} [batch, ZDR]: the default model ${CLAUDE} is refused at privacy level zdr (${p.defaultModelRefusal}).`,
      });
    },
    ZDR_CATALOG,
    (c) => {
      c.privacy.level = "zdr";
    },
  ),
);

test(
  "10c: no fallback when the default is selectable; the page applies the fallback only to an untouched field",
  withWeb(async ({ get }) => {
    const p = (await (await get("/api/privacy")).json()) as { jobModelFallback?: unknown };
    assert.equal(p.jobModelFallback, undefined);
    const html = page();
    assert.ok(html.includes("const untouched = input.value === def || (!!state.jobModelAuto && input.value === state.jobModelAuto);"));
    assert.ok(html.includes('<div id="jobModelNotice"'));
  }, ZDR_CATALOG),
);

test("5: Retry Failed Items also renders for a one-request job with an unusable item", () => {
  assert.ok(page().includes('(j.requestCount > 1 || (j.items || []).some((it) => ["failed", "corrupt", "missing"].includes(it.status)))'));
});

test("compact form closes when another thread is selected", () => {
  assert.ok(page().includes("if (state.activeThreadId !== threadId) {\n        document.getElementById(\"chatModelAlert\").innerHTML = \"\";\n        window.cancelCompact();"));
});
