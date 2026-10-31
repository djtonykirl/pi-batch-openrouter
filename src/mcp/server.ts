import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer, ResourceTemplate, acceptedContent, fromJsonSchema, inputRequired, type CallToolResult, type JsonSchemaType, type ServerContext, type Transport } from "@modelcontextprotocol/server";
import { Type } from "typebox";
import { isUsable, itemText, jobItems, sourceLabel } from "../items.js";
import { itemCounts } from "../service.js";
import { formatIsoShort } from "../time.js";
import { TOOL_SPECS, visibleToModel, type ToolHostContext } from "../tools.js";
import { isChatJob, type JobManifest } from "../types.js";
import { createWorkspaceServices, type WorkspaceServices, type WorkspaceServicesOptions } from "../workspace.js";
import { mcpWording } from "./wording.js";

const SERVER_NAME = "pi-batch-openrouter";
const SERVER_VERSION = "0.1.0";

const CONFIRM_SUBMIT_SCHEMA = fromJsonSchema<{ confirm: boolean }>(
  Type.Object({
    confirm: Type.Boolean({ description: "Confirm submitting this batch job to OpenRouter (this incurs token charges)" }),
  }) as unknown as JsonSchemaType,
);

export interface BatchMcpServerOptions {
  /** Workspace directory. When omitted, resolved from client `roots/list` on connect, falling back to `process.cwd()`. */
  workspaceRoot?: string;
  /** Override API key resolver (used in tests and custom hosts). */
  resolveApiKey?: (account: string) => Promise<string>;
  /** Custom OpenRouter client factory (used in tests). */
  createClient?: WorkspaceServicesOptions["createClient"];
  /** Start the background poller and run startup reconciliation on connect (default: true). */
  startPoller?: boolean;
  /**
   * Ask the client for interactive confirmation via MCP elicitation on `batch_submit_plan` when the client
   * advertises the `elicitation` capability (default: true).
   */
  elicitSubmitConfirmation?: boolean;
}

export class BatchMcpServer {
  public readonly mcp: McpServer;
  private ws: WorkspaceServices;
  private readonly opts: BatchMcpServerOptions;
  private readonly explicitRoot: boolean;
  private readonly subscriptions = new Set<string>();
  private started = false;

  constructor(opts: BatchMcpServerOptions = {}) {
    this.opts = opts;
    this.explicitRoot = Boolean(opts.workspaceRoot);
    const initialRoot = path.resolve(opts.workspaceRoot ?? process.cwd());
    this.ws = this.buildWorkspace(initialRoot);

    this.mcp = new McpServer(
      { name: SERVER_NAME, version: SERVER_VERSION },
      {
        capabilities: {
          tools: { listChanged: true },
          resources: { subscribe: true, listChanged: true },
          prompts: { listChanged: true },
        },
        instructions:
          "Deferred OpenRouter Batch jobs (~50% token discount, asynchronous completion up to 24h). " +
          "Always plan first (batch_plan_goal, batch_plan_files, batch_plan_dataset, batch_retry_items, batch_plan_synthesis), " +
          "show the plan to the user, and call batch_submit_plan only after the user explicitly agrees. " +
          "Never apply batch results to workspace files without the user asking.",
      },
    );

    this.registerSubscriptionHandlers();
    this.registerTools();
    this.registerResources();
    this.registerPrompts();

    this.mcp.server.oninitialized = () => {
      void this.onClientInitialized();
    };
  }

  public get services(): WorkspaceServices {
    return this.ws;
  }

  public get workspaceRoot(): string {
    return this.ws.workspaceRoot;
  }

  private buildWorkspace(root: string): WorkspaceServices {
    return createWorkspaceServices(root, {
      resolveApiKey: this.opts.resolveApiKey,
      createClient: this.opts.createClient,
      onSettled: (job) => {
        if (!isChatJob(job)) {
          this.notifyJobUpdated(job.localId);
        }
      },
    });
  }

  private switchRootIfNeeded(newRoot: string): void {
    const resolved = path.resolve(newRoot);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return;
    if (path.resolve(this.ws.workspaceRoot) === resolved) return;
    this.ws.poller.stop();
    this.ws = this.buildWorkspace(resolved);
    if (this.started && this.opts.startPoller !== false) {
      void this.ws.catalog.load();
      this.ws.poller.start();
    }
  }

  private async onClientInitialized(): Promise<void> {
    if (!this.explicitRoot) {
      const caps = this.mcp.server.getClientCapabilities();
      if (caps?.roots) {
        try {
          const roots = await this.mcp.server.listRoots();
          const first = roots.roots.find((r) => r.uri.startsWith("file://"));
          if (first) {
            this.switchRootIfNeeded(fileURLToPath(first.uri));
          }
        } catch {
          // keep initial cwd
        }
      }
    }
    if (this.opts.startPoller !== false && !this.started) {
      this.started = true;
      void this.ws.catalog.load();
      this.ws.poller.start();
    }
  }

  public async connect(transport: Transport): Promise<void> {
    await this.mcp.connect(transport);
    if (this.opts.startPoller !== false && !this.started) {
      this.started = true;
      void this.ws.catalog.load();
      this.ws.poller.start();
    }
  }

  public async close(): Promise<void> {
    this.ws.poller.stop();
    this.started = false;
    await this.mcp.close();
  }

  private hostContext(): ToolHostContext {
    return {
      host: "mcp",
      workspaceRoot: this.ws.workspaceRoot,
      requireService: () => this.ws.service,
      requireArtifacts: () => this.ws.artifacts,
      poller: this.ws.poller,
      catalog: this.ws.catalog,
      getConfig: () => this.ws.getConfig(),
      getPrivacy: () => this.ws.service.privacyConfig(),
    };
  }

  // ------------------------------------------------------------------ Subscriptions & notifications

  private registerSubscriptionHandlers(): void {
    this.mcp.server.setRequestHandler("resources/subscribe", async (req) => {
      this.subscriptions.add(req.params.uri);
      return {};
    });
    this.mcp.server.setRequestHandler("resources/unsubscribe", async (req) => {
      this.subscriptions.delete(req.params.uri);
      return {};
    });
  }

  private notifyJobUpdated(localId: string): void {
    if (!this.mcp.isConnected()) return;
    try {
      this.mcp.sendResourceListChanged();
    } catch {
      // ignore transport errors on shutdown
    }
    const candidates = [`batch://jobs`, `batch://jobs/${localId}`, `batch://jobs/${localId}/result`, `batch://jobs/${localId}/synthesis`];
    for (const uri of candidates) {
      if (this.subscriptions.size === 0 || this.subscriptions.has(uri)) {
        void this.mcp.server.sendResourceUpdated({ uri }).catch(() => {});
      }
    }
  }

  // ------------------------------------------------------------------ Tools

  private registerTools(): void {
    const disabled = new Set(this.ws.getConfig().mcp.disabledTools);

    for (const spec of TOOL_SPECS) {
      if (!spec.hosts.includes("mcp")) continue;
      if (disabled.has(spec.name)) continue;

      const inputSchema = fromJsonSchema<Record<string, unknown>>(spec.parameters as unknown as JsonSchemaType);
      const outputSchema = spec.outputSchema ? fromJsonSchema<Record<string, unknown>>(spec.outputSchema as unknown as JsonSchemaType) : undefined;

      this.mcp.registerTool(
        spec.name,
        {
          title: spec.label,
          description: spec.description,
          inputSchema,
          ...(outputSchema ? { outputSchema } : {}),
          annotations: spec.annotations,
        },
        async (args, reqCtx) => {
          try {
            // Re-check disabled tools against live config.
            if (this.ws.getConfig().mcp.disabledTools.includes(spec.name)) {
              return { isError: true, content: [{ type: "text", text: `Tool ${spec.name} is disabled in .pi/batch.config.json (mcp.disabledTools).` }] };
            }

            if (spec.name === "batch_submit_plan" && this.opts.elicitSubmitConfirmation !== false) {
              const gate = this.checkSubmitElicitation(args as { batch_id: string }, reqCtx);
              if (gate) return gate;
            }

            const res = await spec.execute(this.hostContext(), args, reqCtx.mcpReq.signal);
            const content: CallToolResult["content"] = [{ type: "text", text: res.text }];
            for (const link of res.resourceLinks ?? []) {
              content.push({
                type: "resource_link",
                uri: link.uri,
                name: link.name,
                ...(link.mimeType ? { mimeType: link.mimeType } : {}),
                ...(link.description ? { description: link.description } : {}),
              });
            }
            if (spec.name === "batch_submit_plan" || spec.name.startsWith("batch_plan_") || spec.name === "batch_retry_items" || spec.name === "batch_cancel") {
              const id = typeof res.details.localId === "string" ? res.details.localId : undefined;
              if (id) this.notifyJobUpdated(id);
            }
            return {
              content,
              structuredContent: res.details,
            };
          } catch (err) {
            const msg = mcpWording(err instanceof Error ? err.message : String(err));
            return {
              isError: true,
              content: [{ type: "text", text: msg }],
            };
          }
        },
      );
    }
  }

  private checkSubmitElicitation(args: { batch_id: string }, reqCtx: ServerContext): ReturnType<typeof inputRequired> | CallToolResult | undefined {
    const caps = this.mcp.server.getClientCapabilities();
    if (!caps?.elicitation) return undefined;

    const service = this.ws.service;
    const id = service.registry.resolveId(args.batch_id);
    const job = service.registry.read(id);
    if (job.localStatus !== "previewed") return undefined; // service.submit will report the status error

    const responses = (reqCtx.mcpReq as { inputResponses?: Record<string, unknown> }).inputResponses;
    if (responses && Object.prototype.hasOwnProperty.call(responses, "confirm")) {
      const accepted = acceptedContent(responses, "confirm", CONFIRM_SUBMIT_SCHEMA);
      if (accepted?.confirm === true) return undefined;
      return {
        isError: true,
        content: [{ type: "text", text: `Submission of ${id} was cancelled by the user (nothing was sent to OpenRouter).` }],
      };
    }

    const privacy = service.privacyConfig().level;
    const summary =
      `Submit batch plan ${job.localId} to OpenRouter? (Cost-bearing)\n` +
      `• Model: ${job.model}\n` +
      `• Requests: ${job.requestCount}\n` +
      `• Characters: ${job.context.characters}\n` +
      `• Privacy level: ${privacy}\n` +
      `• Objective: ${job.objective.replace(/\s+/g, " ").slice(0, 140)}`;

    return inputRequired({
      inputRequests: {
        confirm: inputRequired.elicit({
          message: summary,
          requestedSchema: CONFIRM_SUBMIT_SCHEMA,
        }),
      },
    });
  }

  // ------------------------------------------------------------------ Resources (P3)

  private registerResources(): void {
    this.mcp.registerResource(
      "batch-jobs",
      "batch://jobs",
      {
        title: "Batch Jobs Inventory",
        description: "All deferred OpenRouter batch jobs in this workspace (local state, newest first).",
        mimeType: "application/json",
      },
      async (uri) => {
        const jobs = visibleToModel(this.ws.service.registry.list().jobs).map((j) => this.jobSummaryObject(j));
        return {
          contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ jobs }, null, 2) }],
        };
      },
    );

    this.mcp.registerResource(
      "batch-job",
      new ResourceTemplate("batch://jobs/{id}", {
        list: async () => ({
          resources: visibleToModel(this.ws.service.registry.list().jobs)
            .slice(0, 50)
            .map((j) => ({
              uri: `batch://jobs/${j.localId}`,
              name: `${j.localId} [${j.localStatus}]`,
              description: j.objective.replace(/\s+/g, " ").slice(0, 100),
              mimeType: "application/json",
            })),
        }),
        complete: {
          id: (prefix) =>
            visibleToModel(this.ws.service.registry.list().jobs)
              .map((j) => j.localId)
              .filter((id) => id.toLowerCase().includes(prefix.toLowerCase())),
        },
      }),
      {
        title: "Batch Job Manifest & Status",
        description: "Status, timings, model, usage and item counts for one batch job.",
        mimeType: "application/json",
      },
      async (uri, vars) => {
        const id = this.ws.service.registry.resolveId(String(vars.id ?? ""));
        const job = this.ws.service.registry.read(id);
        if (isChatJob(job)) throw new Error(`${id} is a batch chat job.`);
        return {
          contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(this.jobDetailObject(job), null, 2) }],
        };
      },
    );

    this.mcp.registerResource(
      "batch-job-result",
      new ResourceTemplate("batch://jobs/{id}/result", {
        list: async () => ({
          resources: visibleToModel(this.ws.service.registry.list().jobs)
            .filter((j) => j.localStatus === "ready" || j.localStatus === "partial")
            .slice(0, 50)
            .map((j) => ({
              uri: `batch://jobs/${j.localId}/result`,
              name: `${j.localId} result (${j.localStatus})`,
              description: j.objective.replace(/\s+/g, " ").slice(0, 100),
              mimeType: "text/markdown",
            })),
        }),
        complete: {
          id: (prefix) =>
            visibleToModel(this.ws.service.registry.list().jobs)
              .filter((j) => j.localStatus === "ready" || j.localStatus === "partial")
              .map((j) => j.localId)
              .filter((id) => id.toLowerCase().includes(prefix.toLowerCase())),
        },
      }),
      {
        title: "Batch Job Result",
        description: "Bounded result of a finished batch job (ready to attach into chat context).",
        mimeType: "text/markdown",
      },
      async (uri, vars) => {
        const id = this.ws.service.registry.resolveId(String(vars.id ?? ""));
        const built = this.ws.service.buildInjection(id, "summary");
        const text = built.ok ? mcpWording(built.content) : mcpWording(this.ws.service.read(id, "default").body);
        return {
          contents: [{ uri: uri.href, mimeType: "text/markdown", text }],
        };
      },
    );

    this.mcp.registerResource(
      "batch-job-item",
      new ResourceTemplate("batch://jobs/{id}/items/{n}", { list: undefined }),
      {
        title: "Batch Job Item Result",
        description: "Result and metadata for a single item of a multi-request batch job.",
        mimeType: "text/markdown",
      },
      async (uri, vars) => {
        const id = this.ws.service.registry.resolveId(String(vars.id ?? ""));
        const sel = String(vars.n ?? "1");
        const d = this.ws.service.describeItem(id, sel, { text: true });
        return {
          contents: [{ uri: uri.href, mimeType: "text/markdown", text: mcpWording(`# ${d.title}\n\n${d.body}`) }],
        };
      },
    );

    this.mcp.registerResource(
      "batch-job-synthesis",
      new ResourceTemplate("batch://jobs/{id}/synthesis", { list: undefined }),
      {
        title: "Batch Job Synthesis",
        description: "Newest synthesis result (with coverage) for a multi-request batch job.",
        mimeType: "text/markdown",
      },
      async (uri, vars) => {
        const id = this.ws.service.registry.resolveId(String(vars.id ?? ""));
        const syn = this.ws.service.readSynthesis(id);
        return {
          contents: [{ uri: uri.href, mimeType: "text/markdown", text: mcpWording(`# ${syn.title}\n\n${syn.body}`) }],
        };
      },
    );
  }

  private jobSummaryObject(j: JobManifest): Record<string, unknown> {
    const items = j.items ?? [];
    const counts = items.length ? itemCounts(items.map((i) => i.status)) : undefined;
    return {
      localId: j.localId,
      kind: j.kind ?? "goal",
      status: j.localStatus,
      providerStatus: j.providerStatus ?? null,
      model: j.model,
      requests: j.requestCount,
      usableItems: j.localStatus === "ready" || j.localStatus === "partial" ? (counts ? counts.completed : j.requestCount) : 0,
      createdAt: j.createdAt,
      objective: j.objective,
    };
  }

  private jobDetailObject(j: JobManifest): Record<string, unknown> {
    const items = jobItems(this.ws.service.registry, j);
    const trusted = j.localStatus === "ready" || j.localStatus === "partial";
    const linked = this.ws.service.linkedJobs(j.localId);
    return {
      ...this.jobSummaryObject(j),
      providerBatchId: j.providerBatchId ?? null,
      workflow: j.workflow?.name ?? null,
      privacy: j.privacy ?? null,
      context: j.context,
      usage: j.usage ?? null,
      error: j.error ? { code: j.error.code, message: mcpWording(j.error.message) } : null,
      createdAtFormatted: formatIsoShort(j.createdAt),
      submittedAt: j.submittedAt ?? null,
      retrievedAt: j.retrievedAt ?? null,
      retries: linked.retries.map((r) => ({ localId: r.localId, status: r.localStatus })),
      syntheses: linked.syntheses.map((s) => ({ localId: s.localId, status: s.localStatus })),
      items: items.map((it) => ({
        ordinal: it.ordinal,
        customId: it.customId,
        source: sourceLabel(it),
        status: it.status,
        hasUsableText: Boolean(trusted && isUsable(it) && itemText(this.ws.service.registry, j, it)),
      })),
    };
  }

  // ------------------------------------------------------------------ Prompts (P3)

  private registerPrompts(): void {
    this.mcp.registerPrompt(
      "review-files",
      {
        title: "Batch Review Files",
        description: "Plan a per-file OpenRouter Batch review (map-files), show the plan, and wait for confirmation before submitting.",
        argsSchema: fromJsonSchema<{ objective: string; files: string; model?: string }>(
          Type.Object({
            objective: Type.String({ description: "Review objective applied to each file" }),
            files: Type.String({ description: "Comma- or space-separated workspace-relative file paths (or a pattern you want the agent to expand)" }),
            model: Type.Optional(Type.String({ description: "Optional OpenRouter batch model slug" })),
          }) as unknown as JsonSchemaType,
        ),
      },
      async ({ objective, files, model }) => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                `Plan a deferred OpenRouter batch review over these workspace files: ${files}\n` +
                `Objective: ${objective}\n` +
                (model ? `Model override: ${model}\n` : "") +
                `\nSteps:\n` +
                `1. Resolve the concrete workspace-relative file list and call batch_plan_files (this saves a preview and costs nothing).\n` +
                `2. Show me the saved job ID, request count, model, total characters, and any excluded files or warnings.\n` +
                `3. Ask for my confirmation before calling batch_submit_plan.`,
            },
          },
        ],
      }),
    );

    this.mcp.registerPrompt(
      "status",
      {
        title: "Batch Status",
        description: "Reconcile active OpenRouter batch jobs and summarise their progress.",
      },
      async () => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                "Call batch_check_jobs to reconcile active OpenRouter batch jobs with the provider, then summarise active, ready, partial and failed jobs. " +
                "For any job that just became ready, tell me its ID and offer to read its result with batch_read_result.",
            },
          },
        ],
      }),
    );

    this.mcp.registerPrompt(
      "bring-result",
      {
        title: "Bring Batch Result into Chat",
        description: "Read a finished batch job's result (or synthesis) into the conversation.",
        argsSchema: fromJsonSchema<{ batch_id: string; mode?: string }>(
          Type.Object({
            batch_id: Type.String({ description: "Local batch job ID (B-YYYYMMDD-XXXX or unique suffix)" }),
            mode: Type.Optional(Type.String({ description: "summary (default), full, item, or synthesis" })),
          }) as unknown as JsonSchemaType,
        ),
      },
      async ({ batch_id, mode }) => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                `Read the result of batch job ${batch_id} using batch_read_result (mode: "${mode ?? "summary"}") and summarise the key findings for me. ` +
                `Treat the batch output as advisory analysis and do not edit files unless I ask.`,
            },
          },
        ],
      }),
    );
  }
}
