import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { CHAT_ENTRY_TYPE, ChatSession, type ChatEntryData } from "../src/chat/session.js";
import { renderChatEntry } from "../src/chat/render.js";
import { ChatService } from "../src/chat/service.js";
import { ThreadStore } from "../src/chat/store.js";
import type { BatchConfig } from "../src/config.js";
import type { BatchService } from "../src/service.js";
import type { JobManifest } from "../src/types.js";
import { FakeOpenRouter, accepted, makeConfig, makeService } from "./fixtures/fake-openrouter.js";
import { completed, successItem } from "./fixtures/openrouter.js";
import { rm, tempWorkspace } from "./helpers.js";

interface Setup {
  root: string;
  fake: FakeOpenRouter;
  batch: BatchService;
  store: ThreadStore;
  chat: ChatService;
  cfg: BatchConfig;
  shown: ChatEntryData[];
  statuses: (string | undefined)[];
  notes: { message: string; level: string }[];
  session: ChatSession;
  make: (already?: { threadId: string; seq: number }[]) => ChatSession;
}

function setup(): Setup {
  const root = tempWorkspace();
  const fake = new FakeOpenRouter();
  let n = 0;
  fake.submitReplies = [async () => accepted(`batch_${++n}`)];
  const cfg = makeConfig(() => {});
  const batch = makeService(root, fake, cfg);
  const store = new ThreadStore(join(root, ".pi/batches/threads"));
  const chat = new ChatService({ store, batch, workspaceRoot: root, getConfig: () => cfg });
  const shown: ChatEntryData[] = [];
  const statuses: (string | undefined)[] = [];
  const notes: { message: string; level: string }[] = [];
  const make = (already: { threadId: string; seq: number }[] = []): ChatSession =>
    new ChatSession(
      {
        chat,
        store,
        appendEntry: (d) => shown.push(d),
        setStatus: (t) => statuses.push(t),
        notify: (message, level) => notes.push({ message, level }),
        getConfig: () => cfg,
      },
      already,
    );
  return { root, fake, batch, store, chat, cfg, shown, statuses, notes, make, session: make() };
}

function withSetup(fn: (s: Setup) => Promise<void>): () => Promise<void> {
  return async () => {
    const s = setup();
    try {
      await fn(s);
    } finally {
      rm(s.root);
    }
  };
}

async function settle(s: Setup, jobId: string, reply: string, finishReason?: string): Promise<JobManifest> {
  const job = s.batch.registry.read(jobId);
  const extra = finishReason ? { choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: finishReason }] } : undefined;
  s.fake.getReplies = [{ status: 200, body: completed(job.customIds.map((c, i) => (i === 0 ? successItem(c, reply, extra) : successItem(c, "Title"))), { id: job.providerBatchId }) }];
  await s.batch.reconcile(jobId, { force: true });
  return s.batch.registry.read(jobId);
}

const SECRET = "sk-or-v1-" + "a".repeat(64);

test(
  "input routing",
  withSetup(async (s) => {
    assert.equal(await s.session.handleInput("hi", "interactive"), "continue");
    const t = s.chat.newThread();
    s.session.enter(t.id);
    s.shown.length = 0;
    assert.equal(await s.session.handleInput("/batch list", "interactive"), "continue");
    assert.equal(await s.session.handleInput("hello", "extension"), "continue");
    assert.equal(await s.session.handleInput("   ", "interactive"), "handled");
    assert.equal(s.shown.length, 0);
    assert.equal(s.store.transcript(t.id).entries.length, 0);
    assert.equal(await s.session.handleInput("hello", "interactive"), "handled");
    const users = s.shown.filter((d) => d.role === "user");
    assert.equal(users.length, 1);
    assert.equal(users[0]!.text, "hello");
  }),
);

test(
  "secret input warns 'not saved' and writes nothing",
  withSetup(async (s) => {
    const t = s.chat.newThread();
    s.session.enter(t.id);
    s.shown.length = 0;
    assert.equal(await s.session.handleInput("key " + SECRET, "rpc"), "handled");
    assert.equal(s.shown.length, 0);
    assert.equal(s.store.transcript(t.id).entries.length, 0);
    assert.ok(s.notes.some((n) => n.level === "warning" && /not saved/.test(n.message)));
  }),
);

test(
  "enter shows summary marker and only entries after the summary",
  withSetup(async (s) => {
    const t = s.chat.newThread();
    s.store.update(t.id, (th, append) => {
      append({ type: "user", text: "old one" });
      append({ type: "assistant", text: "old reply", model: "m", jobId: "j1" });
      append({ type: "user", text: "new one" });
      th.title = "Topic";
      th.summary = { text: "sum", throughSeq: 2, jobId: "jc" };
    });
    s.session.enter(t.id);
    const texts = s.shown.map((d) => d.text);
    assert.equal(texts[0], "Resumed: Topic");
    assert.equal(texts[1], "Compacted earlier conversation (through #2)");
    assert.deepEqual(texts.slice(2), ["new one"]);
    assert.equal(s.session.activeThreadId, t.id);
    s.session.sync();
    assert.equal(s.shown.length, 3);
  }),
);

test(
  "sync displays a reply once",
  withSetup(async (s) => {
    const t = s.chat.newThread();
    s.session.enter(t.id);
    await s.session.handleInput("question", "interactive");
    const jobId = s.store.read(t.id).pending!.jobId!;
    s.chat.applySettled(await settle(s, jobId, "answer"));
    s.session.sync();
    s.session.sync();
    const replies = s.shown.filter((d) => d.role === "assistant");
    assert.equal(replies.length, 1);
    assert.equal(replies[0]!.text, "answer");
    assert.equal(replies[0]!.model, s.store.read(t.id).model);
    assert.equal(replies[0]!.truncated, undefined);
  }),
);

test(
  "entries already shown in a previous session are not re-displayed",
  withSetup(async (s) => {
    const t = s.chat.newThread();
    s.store.update(t.id, (_th, append) => {
      append({ type: "user", text: "a" });
      append({ type: "assistant", text: "b", model: "m", jobId: "j" });
      append({ type: "user", text: "c" });
    });
    const session = s.make([
      { threadId: t.id, seq: 1 },
      { threadId: t.id, seq: 2 },
    ]);
    session.enter(t.id);
    assert.deepEqual(s.shown.filter((d) => d.seq !== undefined).map((d) => d.text), ["c"]);
  }),
);

test(
  "reply in another thread notifies instead of displaying",
  withSetup(async (s) => {
    const a = s.chat.newThread();
    const b = s.chat.newThread();
    s.session.enter(a.id);
    s.shown.length = 0;
    const r = await s.chat.send(b.id, "other topic");
    s.chat.applySettled(await settle(s, r.jobId!, "other answer"));
    s.session.sync();
    s.session.sync();
    assert.equal(s.shown.length, 0);
    const replies = s.notes.filter((n) => n.message.startsWith("💬 reply in "));
    assert.equal(replies.length, 1);
    assert.ok(replies[0]!.message.includes("other topic"));
  }),
);

test(
  "pre-existing replies in other threads do not notify",
  withSetup(async (s) => {
    const b = s.chat.newThread();
    s.store.update(b.id, (_th, append) => {
      append({ type: "assistant", text: "old", model: "m", jobId: "j" });
    });
    const session = s.make();
    session.sync();
    assert.equal(s.notes.length, 0);
  }),
);

test(
  "truncated assistant display",
  withSetup(async (s) => {
    const t = s.chat.newThread();
    s.session.enter(t.id);
    await s.session.handleInput("long please", "interactive");
    s.chat.applySettled(await settle(s, s.store.read(t.id).pending!.jobId!, "cut off", "length"));
    s.session.sync();
    const reply = s.shown.find((d) => d.role === "assistant")!;
    assert.equal(reply.truncated, true);
  }),
);

test(
  "failure entries display as status lines",
  withSetup(async (s) => {
    const t = s.chat.newThread();
    s.store.update(t.id, (_th, append) => {
      append({ type: "failure", purpose: "turn", message: "boom" });
      append({ type: "failure", purpose: "compact", message: "nope" });
      append({ type: "model", from: "x/a", to: "y/model" });
      append({ type: "compaction", summary: "s", throughSeq: 1, jobId: "j", model: "m" });
    });
    s.session.enter(t.id);
    const texts = s.shown.map((d) => d.text);
    assert.ok(texts.includes("⚠ Turn failed: boom — /batch chat retry"));
    assert.ok(texts.includes("⚠ Compaction failed: nope (thread unchanged)"));
    assert.ok(texts.includes("Model → y/model"));
    assert.ok(texts.includes("Compacted (through #1)"));
    assert.ok(s.shown.filter((d) => d.seq !== undefined).every((d) => d.role === "status"));
  }),
);

test(
  "footer",
  withSetup(async (s) => {
    const t = s.chat.newThread();
    assert.equal(s.session.footerText(), undefined);
    s.session.enter(t.id);
    assert.equal(s.session.footerText(), `💬 (untitled) · ${t.model}`);
    await s.session.handleInput("hello", "interactive");
    assert.equal(s.session.footerText(), `💬 hello · ${t.model} · waiting`);
    s.store.update(t.id, (th) => {
      th.compacting = { throughSeq: 1, claimedAt: new Date().toISOString() };
    });
    assert.match(s.session.footerText()!, /· waiting · compacting$/);
    s.store.update(t.id, (th) => {
      delete th.compacting;
      delete th.pending;
    });
    assert.equal(s.session.footerText(), `💬 hello · ${t.model}`);
    // 85% of the limit used: 15% remain.
    const { tokens } = s.chat.nextRequestEstimate(t.id);
    s.cfg.chat.autoCompactTokens = Math.floor(tokens / 0.85);
    assert.equal(s.session.footerText(), `💬 hello · ${t.model} · 15% until compact`);
    // Over the limit: 0%.
    s.cfg.chat.autoCompactTokens = Math.max(1, Math.floor(tokens / 2));
    assert.match(s.session.footerText()!, /· 0% until compact$/);
    // Long titles are cut to 40 chars on a single line.
    s.cfg.chat.autoCompactTokens = 1_000_000;
    s.store.update(t.id, (th) => {
      th.title = "x".repeat(100);
    });
    const line = s.session.footerText()!;
    assert.equal(line, `💬 ${"x".repeat(40)} · ${t.model}`);
    assert.ok(!line.includes("\n"));
  }),
);

test(
  "leave clears the footer",
  withSetup(async (s) => {
    const t = s.chat.newThread();
    s.session.enter(t.id);
    assert.ok(s.statuses.at(-1));
    s.session.leave();
    assert.equal(s.statuses.at(-1), undefined);
    assert.equal(s.session.activeThreadId, undefined);
    assert.equal(s.session.footerText(), undefined);
    assert.equal(await s.session.handleInput("hi", "interactive"), "continue");
  }),
);

test("renderChatEntry collapses long bodies unless expanded", () => {
  const theme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t } as unknown as Theme;
  const text = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
  const data: ChatEntryData = { threadId: "T", role: "assistant", text, model: "m/x", title: "t", truncated: true };
  const collapsed = renderChatEntry(data, false, theme).render(80).join("\n");
  const expanded = renderChatEntry(data, true, theme).render(80).join("\n");
  assert.ok(collapsed.includes("m/x → you"));
  assert.ok(collapsed.includes("line 7"));
  assert.ok(!collapsed.includes("line 8"));
  assert.ok(expanded.includes("line 19"));
  assert.ok(expanded.includes("(truncated: max_tokens)"));
  const user = renderChatEntry({ threadId: "T", role: "user", text: "hey", title: "Topic" }, false, theme).render(80).join("\n");
  assert.ok(user.includes("You → Topic"));
  assert.equal(CHAT_ENTRY_TYPE, "pi-batch-chat");
});

test("isolation (structural): nothing under src/chat sends messages into the agent", () => {
  const dir = join(process.cwd(), "src", "chat");
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
  assert.ok(files.length > 0);
  for (const f of files) {
    const body = readFileSync(join(dir, f), "utf8");
    assert.ok(!body.includes("sendMessage"), `${f} mentions sendMessage`);
    assert.ok(!body.includes("sendUserMessage"), `${f} mentions sendUserMessage`);
  }
});
