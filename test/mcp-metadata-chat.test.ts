import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { resolveThreadRef } from "../src/chat/mcp-threads.js";
import { BatchMcpServer } from "../src/mcp/server.js";
import { initAgentInstructions } from "../src/mcp/init.js";
import { mcpWording } from "../src/mcp/wording.js";
import { locateMetadataFile, missingContextMessage } from "../src/metadata/locate.js";
import { OpenRouterBatchClient } from "../src/openrouter/client.js";
import { choosePlanner, looksLikeMetadataRequest, resolveRequestPaths } from "../src/request.js";
import { FAKE_KEY, FakeOpenRouter, accepted } from "./fixtures/fake-openrouter.js";
import { TABLES, metadataWorkspace, proposalFor } from "./fixtures/metadata.js";
import { completed, successItem } from "./fixtures/openrouter.js";
import { rm, tempWorkspace, writeFiles } from "./helpers.js";

interface Connected {
  client: Client;
  server: BatchMcpServer;
  fake: FakeOpenRouter;
  /** Messages of every elicitation form the server sent. */
  elicited: string[];
  close(): Promise<void>;
}

async function connect(root: string, opts: { elicit?: "accept" | "decline" } = {}): Promise<Connected> {
  const fake = new FakeOpenRouter();
  const server = new BatchMcpServer({
    workspaceRoot: root,
    resolveApiKey: async () => FAKE_KEY,
    createClient: (apiKey, timeoutMs) => new OpenRouterBatchClient({ apiKey, fetchImpl: fake.fetch, timeoutMs }),
    startPoller: false,
    elicitSubmitConfirmation: opts.elicit !== undefined,
  });
  const elicited: string[] = [];
  const client = new Client({ name: "mcp-test-client", version: "1.0.0" }, { capabilities: opts.elicit ? { elicitation: {} } : {} });
  if (opts.elicit) {
    client.setRequestHandler("elicitation/create", async (req) => {
      elicited.push(String((req.params as { message?: unknown }).message ?? ""));
      return { action: opts.elicit!, ...(opts.elicit === "accept" ? { content: { confirm: true } } : {}) };
    });
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    server,
    fake,
    elicited,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function textOf(result: { content?: unknown }): string {
  return ((result.content ?? []) as Array<{ type: string; text?: string }>)
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
}

const WORKFLOW = [
  "schemaVersion: 1",
  "name: triage-tickets",
  "input:",
  "  type: jsonl",
  "  idField: id",
  "  fields: [id, body]",
  "request:",
  "  prompt: |",
  "    Triage ticket {{id}}: {{body}}",
  "output:",
  "  type: markdown",
].join("\n");

function plan(root: string, request: string, extra: { mode?: "auto" | "metadata"; files?: string[] } = {}) {
  const classified = resolveRequestPaths(root, request, extra.files);
  return choosePlanner({ workspaceRoot: root, request, mode: extra.mode, classified, expandedFileCount: classified.files.length });
}

// ------------------------------------------------------------------ planner routing

test("planner: a metadata request over a tables file is routed to the metadata workflow, never to goal or a project workflow", () => {
  const root = metadataWorkspace({ ".pi/batch-workflows/triage-tickets.yaml": WORKFLOW });
  try {
    const both = plan(root, "Write column comments for the tables in `metadata/beverage/tables.jsonl` using `metadata/beverage/context.md`");
    assert.equal(both.kind, "metadata");
    assert.equal(both.datasetInput, "metadata/beverage/tables.jsonl");

    // Only the tables file named, and exactly one .jsonl project workflow exists: this used to be claimed by it.
    for (const request of [
      "Generate Unity Catalog metadata for metadata/beverage/tables.jsonl",
      "Databricks table descriptions for metadata/beverage/tables.jsonl please",
      "produce metadata proposals from metadata/beverage/tables.jsonl",
    ]) {
      assert.equal(plan(root, request).kind, "metadata", request);
    }

    // A project workflow the request names still wins.
    assert.equal(plan(root, "Run triage-tickets on metadata/beverage/tables.jsonl to check the column comments").kind, "dataset");
    // The explicit mode needs a tables file.
    assert.throws(() => plan(root, "document the finance tables", { mode: "metadata" }), /Pass the tables file/);
    assert.equal(plan(root, "anything", { mode: "metadata", files: ["metadata/beverage/tables.jsonl"] }).kind, "metadata");
  } finally {
    rm(root);
  }
});

test("planner: wording alone does not make a metadata request, and an unnamed workflow is inferred only when the dataset has its fields", () => {
  assert.equal(looksLikeMetadataRequest("Review the column comments in schema.sql"), true);
  assert.equal(looksLikeMetadataRequest("Summarise each markdown file"), false);
  const root = tempWorkspace();
  writeFiles(root, {
    "schema.sql": "create table t (a int);\n",
    "data/tickets.jsonl": `${JSON.stringify({ id: "t1", body: "Cannot log in" })}\n`,
    "data/other.jsonl": `${JSON.stringify({ sku: "x", price: 3 })}\n`,
    ".pi/batch-workflows/triage-tickets.yaml": WORKFLOW,
  });
  try {
    // No tables file: metadata wording falls through to the ordinary planners.
    assert.equal(plan(root, "Review the column comments in schema.sql").kind, "goal");
    // The one .jsonl workflow is inferred for a dataset that has its fields...
    const hit = plan(root, "Process data/tickets.jsonl");
    assert.equal(hit.kind, "dataset");
    assert.equal(hit.workflow, "triage-tickets");
    // ...and not for an unrelated .jsonl file that merely shares the extension.
    assert.equal(plan(root, "Process data/other.jsonl").kind, "goal");
  } finally {
    rm(root);
  }
});

test("locateMetadataFile: paths pass through, one name match is used and reported, several or none are refused with candidates", () => {
  const root = metadataWorkspace({ "metadata/finance/context.md": "# Finance\n", "metadata/finance/tables.jsonl": "{}\n" });
  try {
    assert.deepEqual(locateMetadataFile(root, "metadata/beverage/tables.jsonl", "tables"), { path: "metadata/beverage/tables.jsonl" });
    const found = locateMetadataFile(root, "the finance tables", "tables");
    assert.equal(found.path, "metadata/finance/tables.jsonl");
    assert.match(found.note!, /Using metadata\/finance\/tables\.jsonl/);
    assert.equal(locateMetadataFile(root, "beverage context", "context").path, "metadata/beverage/context.md");
    assert.throws(() => locateMetadataFile(root, "context", "context"), /more than one \.md file[\s\S]*beverage\/context\.md[\s\S]*finance\/context\.md/);
    assert.throws(() => locateMetadataFile(root, "marketing tables", "tables"), /No tables file[\s\S]*\.jsonl files here:[\s\S]*finance\/tables\.jsonl/);
    // The nearest context file is listed first, but never chosen.
    assert.match(missingContextMessage(root, "metadata/finance/tables.jsonl"), /never guessed[\s\S]*- metadata\/finance\/context\.md\n\s+- metadata\/beverage\/context\.md/);
  } finally {
    rm(root);
  }
});

// ------------------------------------------------------------------ metadata over MCP

test("MCP metadata: batch_request and metadata_plan plan the validated workflow; summary, review, approved draft and validation work by natural reference", async () => {
  const root = metadataWorkspace();
  const m = await connect(root);
  try {
    // 1. A missing context is refused with the candidates, and nothing is saved.
    const noContext = await m.client.callTool({ name: "metadata_plan", arguments: { input: "beverage tables" } });
    assert.equal(noContext.isError, true);
    assert.match(textOf(noContext), /never guessed[\s\S]*metadata\/beverage\/context\.md/);
    assert.equal(m.server.services.service.registry.list().jobs.length, 0);

    // 2. batch_request routes the plain-English request to the metadata workflow (one request per table).
    const routed = await m.client.callTool({
      name: "batch_request",
      arguments: { name: "beverage metadata", request: "Write column comments for the tables in `metadata/beverage/tables.jsonl` using `metadata/beverage/context.md`" },
    });
    assert.ok(!routed.isError, textOf(routed));
    const r = routed.structuredContent as { localId: string; planner: string; requests: number; tablesWithSamples: number; standards: boolean };
    assert.equal(r.planner, "metadata");
    assert.equal(r.requests, 3);
    assert.equal(r.tablesWithSamples, 2);
    assert.equal(r.standards, false);
    assert.match(textOf(routed), /one request per table/);
    assert.match(textOf(routed), /2 tables include sample values/);
    assert.doesNotMatch(textOf(routed), /\/batch (?:metadata|submit)/, "MCP output names tools, not Pi commands");
    assert.equal(m.fake.requests.length, 0, "planning must not make any network call");
    const job = m.server.services.service.registry.read(r.localId);
    assert.equal(job.workflow?.name, "databricks-metadata");
    assert.equal(job.localStatus, "previewed");

    // 3. Half of standards mode is refused in MCP wording.
    const half = await m.client.callTool({ name: "metadata_plan", arguments: { input: "beverage tables", context: "beverage context", domain: "beverage" } });
    assert.equal(half.isError, true);
    assert.match(textOf(half), /standards mode needs both domain and uc_prefix/);

    // 4. Submit, finish, then the metadata tools by natural reference.
    m.fake.submitReplies = [accepted("batch_md")];
    const submitted = await m.client.callTool({ name: "batch_submit_plan", arguments: { batch_id: "beverage metadata" } });
    assert.ok(!submitted.isError, textOf(submitted));
    const ids = m.server.services.service.registry.read(r.localId).customIds;
    m.fake.getReplies = [{ status: 200, body: completed(TABLES.map((t, i) => successItem(ids[i]!, JSON.stringify(proposalFor(t.table)))), { id: "batch_md" }) }];
    const checked = await m.client.callTool({ name: "batch_check_jobs", arguments: { batch_id: r.localId } });
    assert.equal((checked.structuredContent as { localStatus: string }).localStatus, "ready", textOf(checked));

    const summary = await m.client.callTool({ name: "metadata_summary", arguments: { batch_id: "the latest metadata job" } });
    assert.ok(!summary.isError, textOf(summary));
    assert.deepEqual(summary.structuredContent, { localId: r.localId, status: "ready", tables: 3, proposals: 3, withoutProposal: 0, standards: false });
    assert.match(textOf(summary), /metadata_write_review/);
    assert.doesNotMatch(textOf(summary), /\/batch metadata/);

    const review = await m.client.callTool({ name: "metadata_write_review", arguments: { batch_id: "latest", out: "metadata/beverage/review.md" } });
    assert.ok(!review.isError, textOf(review));
    assert.match(fs.readFileSync(path.join(root, "metadata/beverage/review.md"), "utf8"), /# Metadata proposal/);
    const again = await m.client.callTool({ name: "metadata_write_review", arguments: { batch_id: "latest", out: "metadata/beverage/review.md" } });
    assert.equal(again.isError, true);
    assert.match(textOf(again), /overwrite: true/);

    const draft = await m.client.callTool({ name: "metadata_write_approved", arguments: { batch_id: "beverage metadata", out: "metadata/beverage/approved.jsonl" } });
    assert.ok(!draft.isError, textOf(draft));
    assert.equal((draft.structuredContent as { tables: number; problems: number }).tables, 3);
    assert.equal((draft.structuredContent as { problems: number }).problems, 0);
    assert.match(textOf(draft), /DRAFT/);

    const valid = await m.client.callTool({ name: "metadata_validate_approved", arguments: { file: "metadata/beverage/approved.jsonl" } });
    assert.ok(!valid.isError, textOf(valid));
    assert.equal((valid.structuredContent as { valid: boolean }).valid, true);

    // A broken handoff is reported as a result, not thrown away as a tool failure.
    fs.appendFileSync(path.join(root, "metadata/beverage/approved.jsonl"), "{not json\n");
    const invalid = await m.client.callTool({ name: "metadata_validate_approved", arguments: { file: "metadata/beverage/approved.jsonl" } });
    assert.ok(!invalid.isError, textOf(invalid));
    assert.equal((invalid.structuredContent as { valid: boolean }).valid, false);
    assert.match(textOf(invalid), /NOT valid[\s\S]*not valid JSON/);

    // The metadata tools refuse a job of another kind.
    writeFiles(root, { "src/a.ts": "export const a = 1;\n" });
    const goal = await m.client.callTool({ name: "batch_plan_goal", arguments: { prompt: "Audit a", files: ["src/a.ts"] } });
    const other = await m.client.callTool({ name: "metadata_summary", arguments: { batch_id: (goal.structuredContent as { localId: string }).localId } });
    assert.equal(other.isError, true);
    assert.match(textOf(other), /not a databricks-metadata job/);
  } finally {
    await m.close();
    rm(root);
  }
});

test("MCP metadata: the submit confirmation form shows tables, standards mode and sample values", async () => {
  const root = metadataWorkspace();
  const m = await connect(root, { elicit: "accept" });
  try {
    const planned = await m.client.callTool({ name: "metadata_plan", arguments: { input: "metadata/beverage/tables.jsonl", context: "metadata/beverage/context.md" } });
    assert.ok(!planned.isError, textOf(planned));
    m.fake.submitReplies = [accepted("batch_md_e")];
    const submitted = await m.client.callTool({ name: "batch_submit_plan", arguments: { batch_id: "latest" } });
    assert.ok(!submitted.isError, textOf(submitted));
    assert.equal(m.elicited.length, 1);
    assert.match(m.elicited[0]!, /Databricks metadata: 3 table\(s\) from metadata\/beverage\/tables\.jsonl/);
    assert.match(m.elicited[0]!, /UC standards mode: off/);
    assert.match(m.elicited[0]!, /Sample values: sent as given for 2 table\(s\)/);
  } finally {
    await m.close();
    rm(root);
  }
});

// ------------------------------------------------------------------ chat over MCP

test("MCP chat: start records a budget, send is billed within it, read fetches the reply; Pi and web threads stay invisible", async () => {
  const root = tempWorkspace();
  const m = await connect(root);
  try {
    let n = 0;
    m.fake.submitReplies = [async () => accepted(`batch_chat_${++n}`)];
    const chat = m.server.services.chat;
    const store = m.server.services.chatStore;

    // A thread the user opened elsewhere is not reachable from MCP.
    const own = chat.newThread();
    const hidden = await m.client.callTool({ name: "chat_read", arguments: { thread: own.id } });
    assert.equal(hidden.isError, true);
    assert.match(textOf(hidden), /No chat thread has been started from here/);

    const started = await m.client.callTool({ name: "chat_start", arguments: { title: "caching design", max_turns: 1 } });
    assert.ok(!started.isError, textOf(started));
    const s = started.structuredContent as { threadId: string; turnBudget: number };
    assert.equal(s.turnBudget, 1);
    assert.deepEqual(store.read(s.threadId).mcp, { turnBudget: 1, turnsUsed: 0 });
    assert.equal(m.fake.requests.length, 0, "starting a thread sends nothing");

    const sent = await m.client.callTool({ name: "chat_send", arguments: { thread: "the caching chat", message: "Should the cache be write-through?" } });
    assert.ok(!sent.isError, textOf(sent));
    assert.equal((sent.structuredContent as { turnsUsed: number }).turnsUsed, 1);
    assert.equal(m.fake.accepted.length, 1);
    assert.match(textOf(sent), /chat_read/);

    // One turn at a time, and the reply is not there yet.
    const early = await m.client.callTool({ name: "chat_send", arguments: { message: "And eviction?" } });
    assert.equal(early.isError, true);
    assert.match(textOf(early), /reply is still pending/);
    const jobId = store.read(s.threadId).pending!.jobId!;
    const job = m.server.services.service.registry.read(jobId);
    m.fake.getReplies = [{ status: 200, body: completed([successItem(job.customIds[0]!, "Write-through, with a TTL.")], { id: job.providerBatchId }) }];

    // chat_read looks for the reply and applies it to the thread.
    const read = await m.client.callTool({ name: "chat_read", arguments: {} });
    assert.ok(!read.isError, textOf(read));
    const rs = read.structuredContent as { status: string; messages: number; lastSeq: number };
    assert.equal(rs.status, "idle");
    assert.equal(rs.messages, 2);
    assert.match(textOf(read), /Write-through, with a TTL\./);
    const since = await m.client.callTool({ name: "chat_read", arguments: { thread: "latest", since_seq: rs.lastSeq } });
    assert.equal((since.structuredContent as { messages: number }).messages, 0);

    // The agreed budget is spent: nothing further is sent.
    const over = await m.client.callTool({ name: "chat_send", arguments: { message: "And eviction?" } });
    assert.equal(over.isError, true);
    assert.match(textOf(over), /All 1 turn the user agreed to/);
    assert.equal(m.fake.accepted.length, 1);

    // The thread is a resource; the user's own thread is not listed.
    const uris = (await m.client.listResources()).resources.map((r) => r.uri);
    assert.ok(uris.includes(`batch://threads/${s.threadId}`));
    assert.ok(!uris.includes(`batch://threads/${own.id}`));
    const res = await m.client.readResource({ uri: `batch://threads/${s.threadId}` });
    assert.match((res.contents[0] as { text: string }).text, /Write-through, with a TTL\./);

    // A secret in the message is refused and does not spend a turn.
    const second = await m.client.callTool({ name: "chat_start", arguments: { title: "keys" } });
    const sid = (second.structuredContent as { threadId: string }).threadId;
    const leaked = await m.client.callTool({ name: "chat_send", arguments: { thread: sid, message: `my key is ${"sk-or-v1-" + "a".repeat(64)}` } });
    assert.equal(leaked.isError, true);
    assert.equal(store.read(sid).mcp!.turnsUsed, 0);
    assert.equal(m.fake.accepted.length, 1);

    // Ambiguous and unknown references are refused with the candidates.
    assert.throws(() => resolveThreadRef(store, "nothing like this"), /couldn't find a chat thread[\s\S]*caching design/);
    assert.equal(resolveThreadRef(store, "latest").id, sid);
  } finally {
    await m.close();
    rm(root);
  }
});

test("MCP chat: chat_start asks the user through elicitation and creates nothing when they decline", async () => {
  const root = tempWorkspace();
  const m = await connect(root, { elicit: "decline" });
  try {
    const declined = await m.client.callTool({ name: "chat_start", arguments: { title: "pricing", max_turns: 3 } });
    assert.equal(declined.isError, true);
    assert.match(textOf(declined), /cancelled by the user/);
    assert.match(m.elicited[0]!, /Up to 3 turn\(s\) may be sent without asking again/);
    assert.equal(m.server.services.chatStore.list().length, 0);
  } finally {
    await m.close();
    rm(root);
  }
});

test("MCP poller is settle-only for Pi and web threads: replies are applied, queued messages are not sent unless mcp.sendQueuedChat is on", async () => {
  for (const sendQueued of [false, true]) {
    const root = tempWorkspace();
    if (sendQueued) writeFiles(root, { ".pi/batch.config.json": JSON.stringify({ mcp: { sendQueuedChat: true } }) });
    const m = await connect(root);
    try {
      let n = 0;
      m.fake.submitReplies = [async () => accepted(`batch_q_${++n}`)];
      const { chat, chatStore, service } = m.server.services;
      const thread = chat.newThread(); // a thread the user opened in Pi or the web UI
      const first = await chat.send(thread.id, "first");
      assert.ok(first.jobId);
      assert.equal((await chat.send(thread.id, "typed while the reply was pending")).queued, true);
      assert.equal(m.fake.accepted.length, 1);

      const job = service.registry.read(first.jobId!);
      m.fake.getReplies = [{ status: 200, body: completed([successItem(job.customIds[0]!, "reply one")], { id: job.providerBatchId }) }];
      await service.reconcile(job.localId, { force: true });
      await chat.tick();

      // Either way the reply is applied to the thread.
      assert.ok(chatStore.transcript(thread.id).entries.some((e) => e.type === "assistant" && e.text === "reply one"));
      if (sendQueued) {
        const deadline = Date.now() + 5000;
        while (m.fake.accepted.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
        assert.equal(m.fake.accepted.length, 2, "with mcp.sendQueuedChat the queued message goes out");
      } else {
        await new Promise((r) => setTimeout(r, 50));
        assert.equal(m.fake.accepted.length, 1, "the MCP process must not bill a turn nobody confirmed in it");
        assert.equal(chatStore.read(thread.id).pending, undefined);
      }
    } finally {
      await m.close();
      rm(root);
    }
  }
});

// ------------------------------------------------------------------ wording and init

test("mcpWording rewrites metadata, overwrite and chat command hints", () => {
  assert.equal(mcpWording("Review: /batch metadata review B-1 --out <file.md>"), 'Write the review with metadata_write_review (batch_id: "B-1").');
  assert.match(mcpWording("Retry them (/batch retry-items B-1 --failed), or pass --allow-partial to include them with their existing values unchanged."), /batch_retry_items[\s\S]*allow_partial: true/);
  assert.equal(mcpWording("x already exists; nothing was written (use --overwrite)."), "x already exists; nothing was written (pass overwrite: true).");
  assert.equal(mcpWording("The turn failed. Use /batch chat retry."), "The turn failed. Resend it with chat_send (retry: true).");
});

test("init reports installed files that differ from the packaged version as outdated", () => {
  const root = tempWorkspace();
  try {
    assert.deepEqual(initAgentInstructions({ workspaceRoot: root, client: "claude" }).outdated, []);
    const unchanged = initAgentInstructions({ workspaceRoot: root, client: "claude" });
    assert.deepEqual([unchanged.skipped.length, unchanged.outdated.length], [1, 0]);
    const file = path.join(root, ".claude", "skills", "pi-batch", "SKILL.md");
    assert.match(fs.readFileSync(file, "utf8"), /metadata_plan[\s\S]*chat_start/);
    fs.writeFileSync(file, "# an older copy\n");
    const stale = initAgentInstructions({ workspaceRoot: root, client: "claude" });
    assert.deepEqual(stale.outdated, [".claude/skills/pi-batch/SKILL.md"]);
    assert.equal(fs.readFileSync(file, "utf8"), "# an older copy\n", "nothing is replaced without --force");
    assert.deepEqual(initAgentInstructions({ workspaceRoot: root, client: "claude", overwrite: true }).written, [".claude/skills/pi-batch/SKILL.md"]);
  } finally {
    rm(root);
  }
});
