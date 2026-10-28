import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { ArtifactService } from "../src/artifacts/service.js";
import { ArtifactStore } from "../src/artifacts/store.js";
import { ChatService, SUBMISSION_UNKNOWN, SUBMISSION_UNKNOWN_ADVICE } from "../src/chat/service.js";
import { ThreadStore } from "../src/chat/store.js";
import type { BatchConfig } from "../src/config.js";
import { ModelCatalog, type CatalogData } from "../src/models/catalog.js";
import { OpenRouterBatchClient } from "../src/openrouter/client.js";
import { MAX_CONSECUTIVE_429 } from "../src/openrouter/immediate.js";
import { BatchPoller } from "../src/poller.js";
import { JobRegistry } from "../src/registry.js";
import { BatchService } from "../src/service.js";
import { BatchWebServer } from "../src/web/server.js";
import { inflightHeadline, renderWebUiHtml } from "../src/web/ui.js";
import { webWording } from "../src/web/wording.js";
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
    "⏳ Free-model turn rate-limited by OpenRouter; retrying at 14:15 (attempt 5 of 8)",
  );
  assert.equal(inflightHeadline("turn", { route: "immediate", consecutivePollFailures: 0 }, 8), "⏳ Free-model turn in flight");
  assert.equal(inflightHeadline("turn", { route: "batch", consecutivePollFailures: 0 }, 8), "⏳ Batch turn in flight");
  assert.equal(inflightHeadline("turn", undefined, 8), "⏳ Batch turn in flight");
  assert.equal(
    inflightHeadline("turn", { route: "batch", consecutivePollFailures: 2, lastPollError: { message: "HTTP 502" } }, 8),
    "⏳ Batch turn in flight (last status check failed: HTTP 502)",
  );
  assert.equal(inflightHeadline("compaction", { route: "batch" }, 8), "⏳ Compaction in flight");
});

test("4a: the page embeds inflightHeadline with the real cap and no longer says 'Batch Turn in Flight'", () => {
  const html = page();
  assert.ok(html.includes(inflightHeadline.toString()));
  assert.ok(html.includes(`const MAX_RATE_LIMITS = ${MAX_CONSECUTIVE_429};`));
  assert.ok(html.includes("inflightHeadline(p ? \"turn\" : \"compaction\", activeJob, MAX_RATE_LIMITS)"));
  assert.ok(!html.includes("Batch Turn in Flight"));
});

// ------------------------------------------------------------------ 5: web messages name page controls, not commands

test("5: webWording maps each terminal hint to the page control; other text is unchanged", () => {
  assert.equal(
    webWording("2 of 3 table(s) have no usable proposal: a, b.\nRetry them (/batch retry-items B-1 --failed), or pass --allow-partial to include them with their existing values unchanged."),
    "2 of 3 table(s) have no usable proposal: a, b.\nRetry the failed items (Retry Failed Items button on this job), or tick Allow partial to include them with their existing values unchanged.",
  );
  assert.equal(webWording("The reply job B-1 can no longer be read (gone). Use /batch chat retry."), "The reply job B-1 can no longer be read (gone). Use Retry Turn.");
  assert.equal(webWording("Nothing was sent. Fix .pi/x.md, then /batch chat retry."), "Nothing was sent. Fix .pi/x.md, then use Retry Turn.");
  assert.match(webWording(SUBMISSION_UNKNOWN_ADVICE), /only if the turn was not billed, use Retry anyway \(a plain retry is refused/);
  assert.equal(webWording("Do not resubmit before checking /batch show B-7."), "Do not resubmit before checking job B-7 (Inspect).");
  assert.equal(webWording("Nothing to compact yet."), "Nothing to compact yet.");
});

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
