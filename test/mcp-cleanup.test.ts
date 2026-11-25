import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { BatchMcpServer } from "../src/mcp/server.js";
import { JobRegistry } from "../src/registry.js";
import { FAKE_KEY, FakeOpenRouter } from "./fixtures/fake-openrouter.js";
import { mkJob } from "./fixtures/cleanup.js";
import { OpenRouterBatchClient } from "../src/openrouter/client.js";
import { rm, tempWorkspace } from "./helpers.js";

async function connect(root: string, opts: { elicit?: "accept" | "decline" } = {}) {
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
    elicited,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

const textOf = (r: { content?: unknown }) =>
  ((r.content ?? []) as Array<{ type: string; text?: string }>)
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");

/** A workspace with one finished job created before the server starts (so its registry sees it). */
function withJob(createdAt?: string) {
  const root = tempWorkspace();
  const registry = new JobRegistry(path.join(root, ".pi", "batches"));
  const job = mkJob(registry, createdAt ? { createdAt } : {});
  return { root, job, exists: () => fs.existsSync(path.join(root, ".pi", "batches", job.localId)) };
}

test("cleanup_plan deletes nothing and returns a plan id; cleanup_apply deletes the listed items", async () => {
  const w = withJob();
  const m = await connect(w.root);
  try {
    const plan = await m.client.callTool({ name: "cleanup_plan", arguments: { refs: [w.job.localId] } });
    const details = plan.structuredContent as { planId: string; toDelete: number };
    assert.equal(details.toDelete, 1);
    assert.ok(textOf(plan).includes(w.job.localId));
    assert.equal(w.exists(), true);
    const applied = await m.client.callTool({ name: "cleanup_apply", arguments: { plan_id: details.planId } });
    assert.match(textOf(applied), /1 deleted, 0 skipped/);
    assert.equal(w.exists(), false);
  } finally {
    await m.close();
    rm(w.root);
  }
});

test("cleanup_plan with no arguments plans a 7 day clean", async () => {
  const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
  const w = withJob(old);
  const young = mkJob(new JobRegistry(path.join(w.root, ".pi", "batches")));
  const m = await connect(w.root);
  try {
    const plan = await m.client.callTool({ name: "cleanup_plan", arguments: {} });
    const text = textOf(plan);
    assert.ok(text.includes(w.job.localId));
    assert.ok(!text.includes(young.localId));
  } finally {
    await m.close();
    rm(w.root);
  }
});

test("cleanup_apply with an unknown plan id reports a re-plan error", async () => {
  const w = withJob();
  const m = await connect(w.root);
  try {
    const r = await m.client.callTool({ name: "cleanup_apply", arguments: { plan_id: "nope" } });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /re-plan/);
  } finally {
    await m.close();
    rm(w.root);
  }
});

test("cleanup_apply asks the client once; a decline deletes nothing, an accept deletes", async () => {
  const w = withJob();
  const declined = await connect(w.root, { elicit: "decline" });
  try {
    const { structuredContent } = await declined.client.callTool({ name: "cleanup_plan", arguments: { refs: [w.job.localId] } });
    const planId = (structuredContent as { planId: string }).planId;
    const r = await declined.client.callTool({ name: "cleanup_apply", arguments: { plan_id: planId } });
    assert.equal(r.isError, true);
    assert.equal(declined.elicited.length, 1);
    assert.ok(declined.elicited[0]!.includes(w.job.localId));
    assert.equal(w.exists(), true);
  } finally {
    await declined.close();
  }
  const accepted = await connect(w.root, { elicit: "accept" });
  try {
    const { structuredContent } = await accepted.client.callTool({ name: "cleanup_plan", arguments: { refs: [w.job.localId] } });
    const planId = (structuredContent as { planId: string }).planId;
    await accepted.client.callTool({ name: "cleanup_apply", arguments: { plan_id: planId } });
    assert.equal(accepted.elicited.length, 1);
    assert.equal(w.exists(), false);
  } finally {
    await accepted.close();
    rm(w.root);
  }
});
