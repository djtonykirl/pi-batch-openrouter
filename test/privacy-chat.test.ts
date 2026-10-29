import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { ChatService } from "../src/chat/service.js";
import { ChatSession } from "../src/chat/session.js";
import { formatContext } from "../src/chat/commands.js";
import { ThreadStore } from "../src/chat/store.js";
import type { BatchConfig } from "../src/config.js";
import { ModelCatalog } from "../src/models/catalog.js";
import { OpenRouterBatchClient } from "../src/openrouter/client.js";
import type { ZdrEndpoint } from "../src/privacy/policy.js";
import { JobRegistry } from "../src/registry.js";
import { BatchService } from "../src/service.js";
import { FAKE_KEY, FakeOpenRouter, accepted, makeConfig } from "./fixtures/fake-openrouter.js";
import { chatCompletion } from "./fixtures/openrouter.js";
import { rm, tempWorkspace } from "./helpers.js";
import { batchEndpointsMatchingZdr } from "./fixtures/catalog.js";

interface Ctx {
  root: string;
  fake: FakeOpenRouter;
  cfg: BatchConfig;
  batch: BatchService;
  store: ThreadStore;
  chat: ChatService;
}

const ZDR: ZdrEndpoint[] = [{ model: "y/model", provider: "azure/eu" }];

function withChat(opts: { zdr?: ZdrEndpoint[] | Error }, fn: (c: Ctx) => Promise<void>): () => Promise<void> {
  return async () => {
    const root = tempWorkspace();
    try {
      const fake = new FakeOpenRouter();
      let n = 0;
      fake.submitReplies = [async () => accepted(`batch_${++n}`)];
      const cfg = makeConfig(() => {});
      const zdr = opts.zdr ?? ZDR;
      const catalog = new ModelCatalog({
        fetch: async () => {
          if (zdr instanceof Error) throw zdr;
          return { models: [], zdr, batchEndpoints: batchEndpointsMatchingZdr(zdr), freeEndpoints: batchEndpointsMatchingZdr(zdr) };
        },
        file: join(root, "catalog.json"),
      });
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
      await fn({ root, fake, cfg, batch, store, chat });
    } finally {
      rm(root);
    }
  };
}

test(
  "thread level can be raised, not lowered below project",
  withChat({}, async ({ chat, store, cfg }) => {
    const t = chat.newThread();
    assert.equal(chat.effectiveLevel(t.id), "standard");
    chat.raisePrivacy(t.id, "no-training");
    assert.equal(chat.effectiveLevel(t.id), "no-training");
    assert.equal(store.read(t.id).privacyLevel, "no-training");
    assert.ok(store.transcript(t.id).entries.some((e) => e.type === "status" && /no-training/.test(e.text)));
    assert.throws(() => chat.raisePrivacy(t.id, "no-training"), /can't lower a thread below its current level/);
    assert.throws(() => chat.raisePrivacy(t.id, "standard"), /can't lower a thread below its current level/);
    cfg.privacy.level = "zdr";
    assert.throws(() => chat.raisePrivacy(t.id, "no-training"), /can't lower a thread below its current level/);
    assert.equal(chat.effectiveLevel(t.id), "zdr");
  }),
);

test(
  "project lowered keeps a higher thread level",
  withChat({}, async ({ chat, cfg, batch }) => {
    const t = chat.newThread();
    await chat.setModel(t.id, "y/model");
    chat.raisePrivacy(t.id, "zdr");
    cfg.privacy.level = "standard";
    assert.equal(chat.effectiveLevel(t.id), "zdr");
    const r = await chat.send(t.id, "hello");
    assert.ok(r.jobId, "sent");
    const job = batch.registry.read(r.jobId!);
    assert.equal(job.privacy?.level, "zdr");
  }),
);

test(
  "setModel refuses a model the level blocks, and stores the route for :free",
  withChat({}, async ({ chat, store, cfg }) => {
    const t = chat.newThread();
    cfg.privacy.level = "no-training";
    await assert.rejects(chat.setModel(t.id, "y/model"), /Privacy level no-training: /);
    assert.notEqual(store.read(t.id).model, "y/model");
    await chat.setModel(t.id, "z/other:free");
    assert.equal(store.read(t.id).model, "z/other:free");
    assert.equal(store.read(t.id).route, "immediate");

    cfg.privacy.level = "zdr";
    await assert.rejects(chat.setModel(t.id, "z/other:free"), /Privacy level zdr: /);
    await assert.rejects(chat.setModel(t.id, "q/none"), /Privacy level zdr: /);
    await chat.setModel(t.id, "y/model");
    assert.equal(store.read(t.id).route, "batch");
    await chat.setModel(t.id, "y/model:free");
    assert.equal(store.read(t.id).route, "immediate");
  }),
);

test(
  "setModel at zdr refuses when the catalog failed to load",
  withChat({ zdr: new Error("down") }, async ({ chat, cfg }) => {
    const t = chat.newThread();
    cfg.privacy.level = "zdr";
    await assert.rejects(chat.setModel(t.id, "y/model"), /Privacy level zdr: /);
  }),
);

test(
  "a free-model turn goes immediate and settles",
  withChat({}, async ({ chat, store, fake, batch, cfg }) => {
    fake.chatReplies = [{ status: 200, body: chatCompletion("Free hello!") }];
    cfg.privacy.level = "no-training";
    const t = chat.newThread();
    await chat.setModel(t.id, "z/other:free");
    const r = await chat.send(t.id, "hi");
    assert.equal(batch.registry.read(r.jobId!).route, "immediate");
    assert.equal(batch.registry.read(r.jobId!).privacy?.level, "no-training");
    const replies = store.transcript(t.id).entries.filter((e) => e.type === "assistant");
    assert.equal(replies.length, 1);
    assert.equal(replies[0]!.type === "assistant" && replies[0]!.text, "Free hello!");
    assert.deepEqual(fake.chatBodies()[0]!.provider as Record<string, unknown>, { data_collection: "deny" });
  }),
);

test(
  "footer shows the privacy badge and free",
  withChat({}, async ({ chat, store, cfg }) => {
    const session = new ChatSession(
      { chat, store, appendEntry: () => {}, setStatus: () => {}, notify: () => {}, getConfig: () => cfg },
      [],
    );
    const t = chat.newThread();
    session.enter(t.id);
    assert.equal(session.footerText(), `💬 (untitled) · ${t.model}`);
    chat.raisePrivacy(t.id, "zdr");
    assert.equal(session.footerText(), `💬 (untitled) · ${t.model} · 🔒 zdr`);
    await chat.setModel(t.id, "y/model:free");
    assert.equal(session.footerText(), `💬 (untitled) · y/model:free · 🔒 zdr · free`);
    const u = chat.newThread();
    chat.raisePrivacy(u.id, "no-training");
    session.enter(u.id);
    assert.match(session.footerText()!, / · 🔒 no-train$/);
  }),
);

test(
  "context shows the batch retention line",
  withChat({}, async ({ chat, cfg }) => {
    const t = chat.newThread();
    const est = chat.nextRequestEstimate(t.id);
    assert.match(formatContext(est, chat.batchRetentionLine(t.id)), /Batch jobs are kept up to 30 days/);
    chat.raisePrivacy(t.id, "no-training");
    assert.match(formatContext(est, chat.batchRetentionLine(t.id)), /Batch jobs are held at OpenRouter until finished; deleted after retrieval/);
    cfg.privacy.deleteRemoteBatches = false;
    assert.match(formatContext(est, chat.batchRetentionLine(t.id)), /kept up to 30 days/);
  }),
);
