import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { BatchMcpServer, type BatchMcpServerOptions } from "../src/mcp/server.js";
import { mcpWording } from "../src/mcp/wording.js";
import { OpenRouterBatchClient } from "../src/openrouter/client.js";
import { TOOL_SPECS } from "../src/tools.js";
import { FAKE_KEY, FakeOpenRouter, accepted } from "./fixtures/fake-openrouter.js";
import { completed, failedItem, successItem } from "./fixtures/openrouter.js";
import { rm, tempWorkspace, writeFiles } from "./helpers.js";

interface ConnectedMcp {
  client: Client;
  server: BatchMcpServer;
  fake: FakeOpenRouter;
  close(): Promise<void>;
}

async function connectMcp(
  root: string,
  opts: Partial<BatchMcpServerOptions> & {
    clientCapabilities?: Record<string, unknown>;
    elicitAction?: "accept" | "decline";
    elicitConfirm?: boolean;
    roots?: string[];
  } = {},
): Promise<ConnectedMcp> {
  const fake = new FakeOpenRouter();
  const server = new BatchMcpServer({
    workspaceRoot: opts.roots ? undefined : root,
    resolveApiKey: opts.resolveApiKey ?? (async () => FAKE_KEY),
    createClient: (apiKey, timeoutMs) => new OpenRouterBatchClient({ apiKey, fetchImpl: fake.fetch, timeoutMs }),
    startPoller: opts.startPoller ?? false,
    elicitSubmitConfirmation: opts.elicitSubmitConfirmation ?? false,
  });

  const caps: Record<string, unknown> = { ...(opts.clientCapabilities ?? {}) };
  if (opts.elicitAction) caps.elicitation = {};
  if (opts.roots) caps.roots = {};

  const client = new Client({ name: "mcp-test-client", version: "1.0.0" }, { capabilities: caps });

  if (opts.elicitAction) {
    client.setRequestHandler("elicitation/create", async () => ({
      action: opts.elicitAction!,
      ...(opts.elicitAction === "accept" ? { content: { confirm: opts.elicitConfirm ?? true } } : {}),
    }));
  }
  if (opts.roots) {
    client.setRequestHandler("roots/list", async () => ({
      roots: opts.roots!.map((r) => ({ uri: pathToFileURL(r).href, name: path.basename(r) })),
    }));
  }

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    server,
    fake,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function textOf(result: { content?: unknown }): string {
  const blocks = (result.content ?? []) as Array<{ type: string; text?: string }>;
  return blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
}

test("MCP tool list: exposes plan-confirm-submit tools, omits batch_submit_goal, and carries schemas and annotations", async () => {
  const root = tempWorkspace();
  try {
    const m = await connectMcp(root);
    try {
      const { tools } = await m.client.listTools();
      const names = tools.map((t) => t.name);
      // Decision 1: direct one-step submit is never exposed over MCP.
      assert.ok(!names.includes("batch_submit_goal"), "batch_submit_goal must not be exposed on MCP");
      const expected = TOOL_SPECS.filter((s) => s.hosts.includes("mcp")).map((s) => s.name);
      assert.deepEqual(names.sort(), expected.sort());

      const planGoal = tools.find((t) => t.name === "batch_plan_goal")!;
      assert.equal(planGoal.annotations?.readOnlyHint, true);
      assert.equal(planGoal.inputSchema.type, "object");
      assert.ok(planGoal.outputSchema);

      const submitPlan = tools.find((t) => t.name === "batch_submit_plan")!;
      assert.equal(submitPlan.annotations?.readOnlyHint, false);
      assert.equal(submitPlan.annotations?.openWorldHint, true);

      const cancel = tools.find((t) => t.name === "batch_cancel")!;
      assert.equal(cancel.annotations?.destructiveHint, true);
    } finally {
      await m.close();
    }
  } finally {
    rm(root);
  }
});

test("MCP end-to-end: batch_plan_goal -> batch_submit_plan -> batch_check_jobs -> batch_read_result + resources", async () => {
  const root = tempWorkspace();
  writeFiles(root, {
    "src/auth.ts": "export function verifyToken(t: string): boolean { return t.length > 10; }\n",
  });
  try {
    const m = await connectMcp(root);
    try {
      // 1. Plan (free, read-only)
      const planned = await m.client.callTool({
        name: "batch_plan_goal",
        arguments: { prompt: "Audit token verification for weaknesses", files: ["src/auth.ts"] },
      });
      assert.ok(!planned.isError, textOf(planned));
      const planStruct = planned.structuredContent as { localId: string; requests: number; files: number };
      assert.match(planStruct.localId, /^B-\d{8}-[A-Z0-9]{4}$/);
      assert.equal(planStruct.requests, 1);
      assert.equal(planStruct.files, 1);
      assert.equal(m.fake.requests.length, 0, "planning must not make any network call");
      assert.match(textOf(planned), /batch_submit_plan/);
      assert.doesNotMatch(textOf(planned), /\/batch submit/);

      const jobId = planStruct.localId;

      // 2. Submit (cost-bearing)
      m.fake.submitReplies = [accepted("batch_mcp_1")];
      const submitted = await m.client.callTool({
        name: "batch_submit_plan",
        arguments: { batch_id: jobId },
      });
      assert.ok(!submitted.isError, textOf(submitted));
      assert.equal((submitted.structuredContent as { providerBatchId: string }).providerBatchId, "batch_mcp_1");
      assert.equal(m.fake.accepted.length, 1);

      // 3. List locally (no network)
      const listed = await m.client.callTool({ name: "batch_list_jobs", arguments: { status: "active" } });
      assert.equal((listed.structuredContent as { count: number }).count, 1);

      // 4. Check jobs reconciles with OpenRouter -> ready
      const cid = m.server.services.service.registry.read(jobId).customIds[0]!;
      m.fake.getReplies = [{ status: 200, body: completed([successItem(cid, "## Audit\n\nConstant-time check missing.")], { id: "batch_mcp_1" }) }];
      const checked = await m.client.callTool({ name: "batch_check_jobs", arguments: { batch_id: jobId } });
      assert.ok(!checked.isError, textOf(checked));
      assert.equal((checked.structuredContent as { localStatus: string }).localStatus, "ready");
      const hasLink = (checked.content as Array<{ type: string; uri?: string }>).some((c) => c.type === "resource_link" && c.uri === `batch://jobs/${jobId}/result`);
      assert.ok(hasLink, "batch_check_jobs should include a resource_link when ready");

      // 5. Read result (replaces /batch inject)
      const read = await m.client.callTool({ name: "batch_read_result", arguments: { batch_id: jobId, mode: "summary" } });
      assert.ok(!read.isError, textOf(read));
      assert.match(textOf(read), /Constant-time check missing/);
      assert.equal(m.server.services.service.registry.read(jobId).injectionCount, 1);

      // 6. Resources: batch://jobs, batch://jobs/{id}, batch://jobs/{id}/result
      const resList = await m.client.listResources();
      assert.ok(resList.resources.some((r) => r.uri === "batch://jobs"));
      assert.ok(resList.resources.some((r) => r.uri === `batch://jobs/${jobId}/result`));

      const jobRes = await m.client.readResource({ uri: `batch://jobs/${jobId}` });
      const detail = JSON.parse((jobRes.contents[0] as { text: string }).text);
      assert.equal(detail.localId, jobId);
      assert.equal(detail.status, "ready");

      const resultRes = await m.client.readResource({ uri: `batch://jobs/${jobId}/result` });
      assert.match((resultRes.contents[0] as { text: string }).text, /Constant-time check missing/);
    } finally {
      await m.close();
    }
  } finally {
    rm(root);
  }
});

test("MCP map-files, retry_items, synthesis, export and artifact_create workflow", async () => {
  const root = tempWorkspace();
  writeFiles(root, {
    "src/a.ts": "export const a = 1;\n",
    "src/b.ts": "export const b = 2;\n",
  });
  try {
    const m = await connectMcp(root);
    try {
      const planned = await m.client.callTool({
        name: "batch_plan_files",
        arguments: { prompt: "Review module", files: ["src/a.ts", "src/b.ts"] },
      });
      assert.ok(!planned.isError, textOf(planned));
      const jobId = (planned.structuredContent as { localId: string }).localId;

      m.fake.submitReplies = [accepted("batch_map_1")];
      await m.client.callTool({ name: "batch_submit_plan", arguments: { batch_id: jobId } });

      const cids = m.server.services.service.registry.read(jobId).customIds;
      // Item 1 succeeds, item 2 fails -> partial
      m.fake.getReplies = [{ status: 200, body: completed([successItem(cids[0]!, "a.ts looks fine."), failedItem(cids[1]!)], { id: "batch_map_1" }) }];
      await m.client.callTool({ name: "batch_check_jobs", arguments: { batch_id: jobId } });
      assert.equal(m.server.services.service.registry.read(jobId).localStatus, "partial");

      const itemsOut = await m.client.callTool({ name: "batch_get_items", arguments: { batch_id: jobId } });
      assert.match(textOf(itemsOut), /batch_read_result/);
      assert.doesNotMatch(textOf(itemsOut), /\/batch item /);

      // Synthesis without allow_partial is blocked and rewrites the hint to MCP tool names
      const blockedSyn = await m.client.callTool({ name: "batch_plan_synthesis", arguments: { batch_id: jobId } });
      assert.equal(blockedSyn.isError, true);
      assert.match(textOf(blockedSyn), /batch_retry_items/);
      assert.doesNotMatch(textOf(blockedSyn), /\/batch retry-items/);

      // Plan and submit retry for failed item 2
      const retryPlan = await m.client.callTool({ name: "batch_retry_items", arguments: { batch_id: jobId, failed: true } });
      assert.ok(!retryPlan.isError, textOf(retryPlan));
      const retryId = (retryPlan.structuredContent as { localId: string; requests: number }).localId;
      assert.equal((retryPlan.structuredContent as { requests: number }).requests, 1);

      m.fake.submitReplies = [accepted("batch_retry_1")];
      await m.client.callTool({ name: "batch_submit_plan", arguments: { batch_id: retryId } });
      const retryCid = m.server.services.service.registry.read(retryId).customIds[0]!;
      m.fake.getReplies = [{ status: 200, body: completed([successItem(retryCid, "b.ts is clean on retry.")], { id: "batch_retry_1" }) }];
      await m.client.callTool({ name: "batch_check_jobs", arguments: { batch_id: retryId } });

      // Now synthesis succeeds with full combined coverage (2/2, 1 from retry)
      const synPlan = await m.client.callTool({ name: "batch_plan_synthesis", arguments: { batch_id: jobId } });
      assert.ok(!synPlan.isError, textOf(synPlan));
      const synId = (synPlan.structuredContent as { localId: string; includedItems: number }).localId;
      assert.equal((synPlan.structuredContent as { includedItems: number }).includedItems, 2);

      m.fake.submitReplies = [accepted("batch_syn_1")];
      await m.client.callTool({ name: "batch_submit_plan", arguments: { batch_id: synId } });
      const synCid = m.server.services.service.registry.read(synId).customIds[0]!;
      m.fake.getReplies = [{ status: 200, body: completed([successItem(synCid, "# Combined Review\n\nBoth modules pass.")], { id: "batch_syn_1" }) }];
      await m.client.callTool({ name: "batch_check_jobs", arguments: { batch_id: synId } });

      const synRead = await m.client.callTool({ name: "batch_read_result", arguments: { batch_id: jobId, mode: "synthesis" } });
      assert.ok(!synRead.isError, textOf(synRead));
      assert.match(textOf(synRead), /Combined Review/);

      // Export combined results to JSONL
      const exported = await m.client.callTool({
        name: "batch_export",
        arguments: { batch_id: jobId, format: "jsonl", out: "exports/out.jsonl" },
      });
      assert.ok(!exported.isError, textOf(exported));
      assert.ok(fs.existsSync(path.join(root, "exports", "out.jsonl")));

      // Create Markdown artifact from synthesis
      const art = await m.client.callTool({
        name: "artifact_create",
        arguments: { job_id: jobId, synthesis: true, format: "markdown", out: "reports/review.md" },
      });
      assert.ok(!art.isError, textOf(art));
      assert.ok(fs.existsSync(path.join(root, "reports", "review.md")));
    } finally {
      await m.close();
    }
  } finally {
    rm(root);
  }
});

test("MCP safety gates: secret blocking, elicitation confirmation/cancellation, maxRequestsPerSubmit, and disabledTools", async () => {
  const root = tempWorkspace();
  const leakedKey = "sk-or-v1-" + "dead".repeat(16);
  writeFiles(root, {
    "src/clean.ts": "export const x = 1;\n",
    "src/secret.ts": `const k = "${leakedKey}";\n`,
    ".pi/batch.config.json": JSON.stringify({
      schemaVersion: 1,
      mcp: { maxRequestsPerSubmit: 1, disabledTools: ["batch_cancel"] },
    }),
  });
  try {
    // 1. Secret scan blocks planning and never echoes the secret value.
    const m1 = await connectMcp(root, { elicitSubmitConfirmation: true, elicitAction: "decline" });
    try {
      const tools = await m1.client.listTools();
      assert.ok(!tools.tools.some((t) => t.name === "batch_cancel"), "disabledTools must hide batch_cancel");

      const secretAttempt = await m1.client.callTool({
        name: "batch_plan_goal",
        arguments: { prompt: "check", files: ["src/secret.ts"] },
      });
      assert.equal(secretAttempt.isError, true);
      assert.ok(!textOf(secretAttempt).includes(leakedKey), "error output must never contain the secret value");

      // 2. Elicitation decline aborts submission without calling OpenRouter.
      const plan1 = await m1.client.callTool({
        name: "batch_plan_goal",
        arguments: { prompt: "check clean", files: ["src/clean.ts"] },
      });
      const id1 = (plan1.structuredContent as { localId: string }).localId;
      const declined = await m1.client.callTool({ name: "batch_submit_plan", arguments: { batch_id: id1 } });
      assert.equal(declined.isError, true);
      assert.match(textOf(declined), /cancelled by the user/);
      assert.equal(m1.fake.requests.length, 0);
      assert.equal(m1.server.services.service.registry.read(id1).localStatus, "previewed");

      // 3. maxRequestsPerSubmit blocks a 2-request map-files plan even before elicitation/submission.
      writeFiles(root, { "src/clean2.ts": "export const y = 2;\n" });
      const plan2 = await m1.client.callTool({
        name: "batch_plan_files",
        arguments: { prompt: "check two", files: ["src/clean.ts", "src/clean2.ts"] },
      });
      const id2 = (plan2.structuredContent as { localId: string }).localId;
      const mAccept = await connectMcp(root, { elicitSubmitConfirmation: true, elicitAction: "accept", elicitConfirm: true });
      try {
        const capped = await mAccept.client.callTool({ name: "batch_submit_plan", arguments: { batch_id: id2 } });
        assert.equal(capped.isError, true);
        assert.match(textOf(capped), /maxRequestsPerSubmit/);
        assert.equal(mAccept.fake.requests.length, 0);

        // Accepting elicitation for the 1-request plan submits it.
        mAccept.fake.submitReplies = [accepted("batch_elicit_ok")];
        const ok = await mAccept.client.callTool({ name: "batch_submit_plan", arguments: { batch_id: id1 } });
        assert.ok(!ok.isError, textOf(ok));
        assert.equal(mAccept.fake.accepted.length, 1);
      } finally {
        await mAccept.close();
      }
    } finally {
      await m1.close();
    }
  } finally {
    rm(root);
  }
});

test("MCP roots/list fallback resolves workspace when --cwd is omitted, and prompts return structured guidance", async () => {
  const root = tempWorkspace();
  writeFiles(root, { "src/index.ts": "export const ok = true;\n" });
  try {
    const m = await connectMcp(root, { roots: [root] });
    try {
      // Wait briefly for oninitialized -> listRoots() to complete.
      for (let i = 0; i < 20 && path.resolve(m.server.workspaceRoot) !== path.resolve(root); i++) {
        await new Promise((r) => setTimeout(r, 15));
      }
      assert.equal(path.resolve(m.server.workspaceRoot), path.resolve(root));

      const prompts = await m.client.listPrompts();
      assert.deepEqual(prompts.prompts.map((p) => p.name).sort(), ["bring-result", "review-files", "status"]);
      const p = await m.client.getPrompt({ name: "review-files", arguments: { objective: "find bugs", files: "src/index.ts" } });
      assert.match((p.messages[0]!.content as { text: string }).text, /batch_plan_files/);
    } finally {
      await m.close();
    }
  } finally {
    rm(root);
  }
});

test("MCP stdio child process: handshake succeeds and stdout carries only valid JSON-RPC frames", async () => {
  const root = tempWorkspace();
  try {
    const cliPath = path.resolve(".test-build/src/mcp/cli.js");
    const child = spawn(process.execPath, [cliPath, "--cwd", root], { stdio: ["pipe", "pipe", "pipe"] });
    const stdoutLines: string[] = [];
    let buffer = "";

    const firstResponse = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("stdio initialize timed out")), 10_000);
      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        let idx: number;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          stdoutLines.push(line);
          try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            if (parsed.id === 1) {
              clearTimeout(timer);
              resolve(parsed);
            }
          } catch (err) {
            clearTimeout(timer);
            reject(new Error(`Non-JSON-RPC line on stdout: ${line} (${(err as Error).message})`));
          }
        }
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    const initReq = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "stdio-test", version: "1.0.0" },
      },
    };
    child.stdin.write(JSON.stringify(initReq) + "\n");

    const resp = await firstResponse;
    assert.equal(resp.jsonrpc, "2.0");
    assert.equal((resp.result as { serverInfo: { name: string } }).serverInfo.name, "pi-batch-openrouter");
    for (const line of stdoutLines) {
      const parsed = JSON.parse(line) as { jsonrpc?: string };
      assert.equal(parsed.jsonrpc, "2.0");
    }

    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
  } finally {
    rm(root);
  }
});

test("mcpWording rewrites Pi slash commands to MCP tool names", () => {
  assert.match(mcpWording("No batch job B-1. Use /batch list to see known jobs."), /batch_list_jobs/);
  assert.match(mcpWording("Use /batch check to reconcile now."), /batch_check_jobs/);
  assert.match(mcpWording("Details: /batch item B-20261018-ABCD <n>"), /batch_read_result/);
});
