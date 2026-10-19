import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { parseArgs, tokenize, type ParsedArgs } from "./args.js";
import { saveConfigUpdate } from "./config.js";
import { BatchDashboardComponent, TextViewerComponent, describeJob, itemsCell } from "./dashboard.js";
import { discoverBatchModels } from "./models.js";
import { INJECTED_MESSAGE_TYPE, type BatchRuntime } from "./runtime.js";
import { jobItems, sourceLabel } from "./items.js";
import { CHECK_LOCK_WAIT_MS, DuplicateActiveRequestError, SubmissionBlockedError, formatUsage, itemCounts, type InjectMode, type PreparedAsk, type PreparedDatasetRun, type PreparedPlan, type PreparedSynthesis } from "./service.js";
import { cmdBatchArtifact } from "./artifact-commands.js";
import { cmdMetadata } from "./metadata-commands.js";
import { ArtifactError } from "./artifacts/service.js";
import { formatLegacyInventory } from "./legacy.js";
import { BUILTIN_WORKFLOWS, WorkflowNotFoundError, discoverWorkflows, findWorkflow, formatDiagnostics, validateWorkflowFile } from "./workflows/definition.js";
import { ACTIVE_STATUSES, LOCAL_STATUSES, TERMINAL_STATUSES, type LocalStatus } from "./state.js";
import { formatIsoShort } from "./time.js";
import type { JobManifest } from "./types.js";

const SUBCOMMANDS: Record<string, { desc: string; nonTerminal: boolean }> = {
  "--global": { desc: "Save the following setting globally (~/.pi/agent/)", nonTerminal: true },
  ask: { desc: "Submit a deferred goal: ask [--file p] [--context dir] \"objective\"", nonTerminal: true },
  goal: { desc: "Alias of ask", nonTerminal: true },
  list: { desc: "List jobs from local state [--status active|ready|...] [--limit n]", nonTerminal: false },
  show: { desc: "Show job details", nonTerminal: true },
  read: { desc: "Read a retrieved result [--full|--raw]", nonTerminal: true },
  inject: { desc: "Inject a result into this conversation [--summary|--full]", nonTerminal: true },
  check: { desc: "Reconcile active jobs with OpenRouter now", nonTerminal: false },
  cancel: { desc: "Request cancellation (history kept)", nonTerminal: true },
  retry: { desc: "Re-run a finished job as a new linked job [--model slug]", nonTerminal: true },
  submit: { desc: "Submit a job created with --preview", nonTerminal: true },
  run: { desc: "Run a workflow: run <project-workflow> --input data.csv [--preview] | run map-files --file a --prompt \"...\"", nonTerminal: true },
  workflow: { desc: "Project workflows: workflow list | show <name> | validate <name> | validate --file <path>", nonTerminal: true },
  export: { desc: "Export a finished job's results: export <id> --format jsonl|csv [--out path] [--overwrite]", nonTerminal: true },
  artifact: { desc: "Write a controlled file from a validated result: artifact <id> [--synthesis|--item n] --format markdown|html|pdf|text [--template t] [--out path]", nonTerminal: true },
  metadata: { desc: "Databricks table descriptions/column comments: metadata plan", nonTerminal: true },
  "import-legacy": { desc: "Inventory a pre-Release-1 jobs.json (read-only): import-legacy <path> --preview", nonTerminal: true },
  items: { desc: "List a job's request items", nonTerminal: true },
  item: { desc: "Inspect one item: item <id> <n|custom_id|path> [--text] [--raw]", nonTerminal: true },
  "retry-items": { desc: "Re-run failed/selected items as a new linked job: retry-items <id> --failed | --item n", nonTerminal: true },
  synthesize: { desc: "Synthesize a finished workflow job as a new linked job [--allow-partial] [--preview]", nonTerminal: true },
  view: { desc: "Open interactive TUI dashboard", nonTerminal: false },
  model: { desc: "Select default batch model", nonTerminal: true },
  provider: { desc: "Select default OpenRouter account (Pi provider alias)", nonTerminal: true },
  help: { desc: "Show /batch usage", nonTerminal: false },
};

const ID_COMMANDS: Record<string, (j: JobManifest) => boolean> = {
  show: () => true,
  read: (j) => j.localStatus === "ready" || j.localStatus === "partial" || j.localStatus === "corrupt" || j.localStatus === "failed",
  inject: (j) => j.localStatus === "ready" || j.localStatus === "partial",
  cancel: (j) => ACTIVE_STATUSES.has(j.localStatus) || j.localStatus === "previewed",
  retry: (j) => TERMINAL_STATUSES.has(j.localStatus),
  submit: (j) => j.localStatus === "previewed",
  items: () => true,
  item: () => true,
  "retry-items": (j) => TERMINAL_STATUSES.has(j.localStatus),
  synthesize: (j) => j.kind !== "synthesis" && (j.localStatus === "ready" || j.localStatus === "partial"),
  export: (j) => TERMINAL_STATUSES.has(j.localStatus),
  artifact: (j) => j.localStatus === "ready" || j.localStatus === "partial",
};

const HELP = `/batch — deferred OpenRouter Batch goals

  ask [options] "<objective>"        submit (alias: goal)
      --file <path>                  include a file (repeatable; blocks if excluded/binary/secret)
      --context <path>               include a file or directory (repeatable; excluded files skipped & listed)
      --model <slug>  --account <pi-provider-alias>  --provider <upstream-slug pin>
      --format markdown|json  --preview  --no-instructions
  workflow list                      built-in and project workflows (.pi/batch-workflows/*.yaml)
  workflow show <name>               definition summary, hashes, diagnostics
  workflow validate <name> | --file <path>
  run <workflow> --input <file> [options]
                                     one request per dataset row (CSV/JSONL), all in ONE batch
      --id <source-id> (repeatable)  or  --from-row <n> --to-row <m>
      --model  --account  --provider  --preview
  export <id> --format jsonl|csv [--out <path>] [--overwrite] [--job-only]
                                     write results with provenance (default: job's exports/ folder)
  artifact <id> [--synthesis|--item <sel>] --format markdown|html|pdf|text [--template <name>]
      [--out <path>] [--overwrite] [--allow-partial]
                                     controlled file from validated results (see /artifact help)
  metadata plan --context <context.md> --input <tables.jsonl> [--preview]
                                     Databricks table descriptions and column comments (see /batch metadata help)
  import-legacy <jobs.json> --preview
                                     read-only inventory of pre-Release-1 jobs (import itself is deferred)
  run map-files [options] --prompt "<objective>"
                                     one request per file, all in ONE batch
      --file <path> (repeatable)  --context <dir>  --group-size <n>
      --model  --account  --provider  --format  --preview  --no-instructions
  submit <id>                        submit a job created with --preview
  list [--status active|ready|failed|<status>|all] [--limit n]
  show <id>                          local + provider status, usage, items, linked jobs
  items <id>                         item inventory (and combined coverage with retries)
  item <id> <n|custom_id|path> [--text] [--raw]
  read <id> [--full|--raw|--items|--item <sel>|--synthesis]
  inject <id> [--item <sel>|--synthesis] [--summary|--full]
                                     add a result to THIS conversation's context
  check [id]                         reconcile with OpenRouter now
  cancel <id>                        request cancellation; history is kept
  retry <id> [--model <slug>]        new linked job from the exact original request
  retry-items <id> --failed | --item <sel> ... [--model <slug>] [--preview]
  synthesize <id> [--allow-partial] [--model] [--account] [--provider] [--preview]
  view                               TUI dashboard
  [--global] model [slug]            default batch model
  [--global] provider [alias]        default Pi account for the API key

IDs accept a unique suffix, e.g. "A7C2". Results are advisory and never applied to files automatically.`;

export function registerBatchCommand(rt: BatchRuntime): void {
  rt.pi.registerCommand("batch", {
    description: "Deferred OpenRouter Batch goals and multi-request workflows: ask, run, list, show, items, read, inject, retry, synthesize",
    getArgumentCompletions: async function completions(prefix: string): Promise<AutocompleteItem[] | null> {
      // `--global` prefix: complete the remainder, then re-prefix suggestions.
      const trimmedPrefix = prefix.trimStart();
      if (trimmedPrefix.startsWith("--global")) {
        const afterGlobal = trimmedPrefix.slice(8).trimStart();
        const hasTrailingSpace = trimmedPrefix.length > 8 || /\s$/.test(prefix);
        if (!hasTrailingSpace && afterGlobal === "") {
          return [{ value: "--global ", label: "--global", description: SUBCOMMANDS["--global"]!.desc }];
        }
        const sub = await completions(afterGlobal);
        if (!sub) return null;
        const out = sub.filter((i) => i.label !== "--global").map((i) => ({ ...i, value: `--global ${i.value}` }));
        return out.length > 0 ? out : null;
      }

      const tokens = prefix.split(/\s+/).filter(Boolean);
      const trailingSpace = /\s$/.test(prefix);
      const normalizedPrefix = tokens.join(" ").toLowerCase() + (trailingSpace && tokens.length === 1 ? " " : "");
      const firstToken = tokens[0]?.toLowerCase();
      const pastFirst = tokens.length > 1 || (trailingSpace && tokens.length === 1);

      if (pastFirst && firstToken) {
        const service = rt.service;
        const idFilter = ID_COMMANDS[firstToken];
        if (idFilter && service && tokens.length <= 2) {
          const items = service.registry
            .list()
            .jobs.filter(idFilter)
            .map((j) => ({
              value: `${firstToken} ${j.localId}`,
              label: j.localId,
              description: `${j.localStatus} · ${j.objective.replace(/\s+/g, " ").slice(0, 40)}`,
            }));
          const filtered = items.filter((i) => i.value.toLowerCase().startsWith(normalizedPrefix.trimEnd().toLowerCase()) || trailingSpace);
          return filtered.length > 0 ? filtered : null;
        }

        if (firstToken === "provider") {
          const ctx = rt.ctx;
          const current = rt.loaded.config.defaultAccount;
          const providers = new Set<string>(["openrouter"]);
          if (ctx) {
            for (const m of ctx.modelRegistry.getAll()) {
              if (m.provider === "openrouter" || m.provider.startsWith("openrouter-")) providers.add(m.provider);
            }
          }
          const items = [...providers].map((p) => ({
            value: `provider ${p}`,
            label: p === current ? `${p} ✓` : p,
            description: p === current ? "Account provider · active" : "Account provider",
          }));
          const filtered = items.filter((i) => i.value.toLowerCase().startsWith(normalizedPrefix.trimEnd()));
          return filtered.length > 0 ? filtered : null;
        }

        if (firstToken === "model") {
          const ctx = rt.ctx;
          const currentModel = rt.loaded.config.defaultModel;
          let options = ctx ? discoverBatchModels(ctx) : [];
          const forAccount = options.filter((m) => m.provider === rt.loaded.config.defaultAccount);
          if (forAccount.length > 0) options = forAccount;
          const items = options.map((opt) => ({
            value: `model ${opt.modelId}`,
            label: `${opt.modelId}${opt.modelId === currentModel ? " ✓" : ""}`,
            description: `[${opt.provider}]${opt.modelId === currentModel ? " · active" : ""}`,
          }));
          const filtered = items.filter((i) => i.value.toLowerCase().startsWith(normalizedPrefix.trimEnd()));
          return filtered.length > 0 ? filtered : null;
        }
        return null;
      }

      const typed = (tokens[0] ?? "").toLowerCase();
      const items: AutocompleteItem[] = [];
      for (const [name, meta] of Object.entries(SUBCOMMANDS)) {
        if (name.toLowerCase().startsWith(typed)) {
          items.push({ value: meta.nonTerminal ? `${name} ` : name, label: name, description: meta.desc });
        }
      }
      return items.length > 0 ? items : null;
    },

    handler: async (args: string, ctx: ExtensionCommandContext) => {
      try {
        await dispatch(rt, args, ctx);
      } catch (err) {
        const e = err as Error;
        const level = err instanceof SubmissionBlockedError || err instanceof DuplicateActiveRequestError || err instanceof WorkflowNotFoundError || err instanceof ArtifactError ? "warning" : "error";
        rt.notify(e.message, level);
      }
    },
  });
}

async function dispatch(rt: BatchRuntime, args: string, ctx: ExtensionCommandContext): Promise<void> {
  const allTokens = tokenize(args);
  const isGlobal = allTokens.some((t) => t.toLowerCase() === "--global");
  const tokens = allTokens.filter((t) => t.toLowerCase() !== "--global");
  const sub = tokens[0]?.toLowerCase() ?? "view";
  const rest = tokens.slice(1);

  if (rt.loaded.errors.length > 0 && sub !== "help") {
    rt.notify(`Batch config problems (defaults used for invalid values):\n- ${rt.loaded.errors.join("\n- ")}`, "warning");
  }

  switch (sub) {
    case "ask":
    case "goal":
      return cmdAsk(rt, rest, ctx);
    case "submit":
      return cmdSubmit(rt, rest);
    case "run":
    case "plan":
      return cmdRun(rt, rest, ctx, sub === "plan");
    case "workflow":
    case "workflows":
      return cmdWorkflow(rt, rest, ctx);
    case "export":
      return cmdExport(rt, rest);
    case "artifact":
      return cmdBatchArtifact(rt, rest);
    case "metadata":
      return cmdMetadata(rt, rest, ctx);
    case "import-legacy":
      return cmdImportLegacy(rt, rest, ctx);
    case "items":
      return cmdItems(rt, rest, ctx);
    case "item":
      return cmdItem(rt, rest, ctx);
    case "retry-items":
      return cmdRetryItems(rt, rest);
    case "synthesize":
    case "synthesise":
      return cmdSynthesize(rt, rest, ctx);
    case "list":
    case "ls":
      return cmdList(rt, rest);
    case "show":
      return cmdShow(rt, rest, ctx);
    case "read":
      return cmdRead(rt, rest, ctx);
    case "inject":
      return cmdInject(rt, rest);
    case "check":
      return cmdCheck(rt, rest);
    case "cancel":
      return cmdCancel(rt, rest);
    case "retry":
      return cmdRetry(rt, rest);
    case "view":
    case "ui":
    case "dashboard":
      return cmdView(rt, ctx);
    case "model":
      return cmdSetting(rt, "defaultModel", rest, isGlobal);
    case "provider":
    case "account":
      return cmdSetting(rt, "defaultAccount", rest, isGlobal);
    case "help":
      return showText(rt, ctx, "/batch help", HELP);
    default:
      rt.notify(`Unknown subcommand: ${sub}. Try /batch help`, "warning");
  }
}

function requireId(rt: BatchRuntime, rest: string[], usage: string): string {
  const raw = rest.find((t) => !t.startsWith("--"));
  if (!raw) throw new Error(`Usage: ${usage}`);
  return rt.requireService().registry.resolveId(raw);
}

// ------------------------------------------------------------------ ask

async function cmdAsk(rt: BatchRuntime, rest: string[], ctx: ExtensionCommandContext): Promise<void> {
  const service = rt.requireService();
  const parsed = parseArgs(rest, {
    values: ["model", "account", "provider", "format"],
    repeatable: ["file", "context"],
    booleans: ["preview", "no-instructions"],
  });
  if (parsed.errors.length > 0) throw new Error(`/batch ask: ${parsed.errors.join("; ")}`);
  const format = (parsed.values.format ?? "markdown").toLowerCase();
  if (format !== "markdown" && format !== "json") throw new Error("--format must be markdown or json");
  const objective = parsed.positionals.join(" ").trim();
  if (!objective) throw new Error('Usage: /batch ask [--file <path>] [--context <dir>] "<objective>"');

  const prepared = await service.prepare({
    objective,
    files: parsed.lists.file ?? [],
    contexts: parsed.lists.context ?? [],
    model: parsed.values.model,
    account: parsed.values.account,
    providerPin: parsed.values.provider,
    format,
    includeInstructions: !parsed.booleans.has("no-instructions"),
  });
  const previewOnly = parsed.booleans.has("preview");
  const config = rt.loaded.config;
  const preview = formatPreview(prepared, previewOnly);

  if (prepared.blockers.length > 0) {
    // Nothing is persisted or sent when blocked.
    throw new SubmissionBlockedError(`${preview}\n\n${prepared.blockers.join("\n\n")}`);
  }
  if (previewOnly) {
    const job = await service.createJob(prepared, { previewOnly: true });
    rt.notify(`${preview}\n\nPreview saved as ${job.localId} (not submitted).\nInspect: ${service.registry.jobDir(job.localId)}\nSubmit:  /batch submit ${job.localId}`, "info");
    return;
  }
  if (config.submission.requireConfirmation && ctx.hasUI) {
    const ok = await ctx.ui.confirm("Submit batch goal?", preview);
    if (!ok) {
      rt.notify("Submission cancelled; nothing was sent.", "info");
      return;
    }
  } else if (config.submission.showPreview) {
    rt.notify(preview, "info");
  }

  const job = await service.createJob(prepared, { previewOnly: false });
  rt.poller.updateBadge();
  if (job.localStatus === "submitted") {
    rt.notify(
      `✅ Accepted by OpenRouter (${job.providerStatus ?? "?"}) — this is queued, not completed.\n` +
        `Job: ${job.localId}   Provider batch: ${job.providerBatchId}\n` +
        `Track: /batch show ${job.localId}   (polled in the background; survives restarts)`,
      "info",
    );
  } else {
    rt.notify(`❌ ${job.localId} ${job.localStatus}: ${job.error?.message ?? "unknown error"}\nHistory kept: /batch show ${job.localId}`, "error");
  }
}

function formatPreview(p: PreparedAsk, previewOnly: boolean): string {
  const lines = [
    previewOnly ? "Batch goal preview (not submitted)" : "Submitting batch goal",
    "",
    `Objective:    ${p.options.objective.replace(/\s+/g, " ").slice(0, 100)}`,
    `Model:        ${p.model}`,
    `Account:      ${p.account}${p.pin ? `   Provider pin: ${p.pin.only.join(",")} (no fallbacks)` : ""}`,
    `Files:        ${p.pkg.files.length}${p.pkg.files.length ? `  (${p.pkg.files.slice(0, 5).map((f) => f.relPath).join(", ")}${p.pkg.files.length > 5 ? ", …" : ""})` : ""}`,
    `Characters:   ${p.pkg.characters}  (context package; not a token count)`,
    `Excluded:     ${p.pkg.excluded.length}${p.pkg.excluded.length ? `  (${p.pkg.excluded.slice(0, 4).map((e) => `${e.relPath} [${e.layer}]`).join(", ")}${p.pkg.excluded.length > 4 ? ", …" : ""})` : ""}`,
    `Secrets:      ${p.pkg.secretFindings.length === 0 ? "none detected" : `${p.pkg.secretFindings.length} potential finding(s)`}`,
    `Warnings:     ${p.pkg.warnings.length === 0 ? "none" : p.pkg.warnings.join("; ")}`,
  ];
  return lines.join("\n");
}

async function cmdSubmit(rt: BatchRuntime, rest: string[]): Promise<void> {
  const id = requireId(rt, rest, "/batch submit <id>");
  const drift = rt.requireService().workflowDrift(id);
  if (drift) rt.notify(`⚠ ${drift}`, "warning");
  const job = await rt.requireService().submit(id);
  rt.poller.updateBadge();
  rt.notify(
    job.localStatus === "submitted"
      ? `✅ ${id} accepted by OpenRouter (${job.providerStatus}); provider batch ${job.providerBatchId}.`
      : `❌ ${id} ${job.localStatus}: ${job.error?.message ?? ""}`,
    job.localStatus === "submitted" ? "info" : "error",
  );
}

// ----------------------------------------------------------- list / show

const STATUS_GROUPS: Record<string, (s: LocalStatus) => boolean> = {
  all: () => true,
  active: (s) => ACTIVE_STATUSES.has(s),
  done: (s) => TERMINAL_STATUSES.has(s),
};

function cmdList(rt: BatchRuntime, rest: string[]): void {
  const parsed = parseArgs(rest, { values: ["status", "limit"] });
  if (parsed.errors.length) throw new Error(`/batch list: ${parsed.errors.join("; ")}`);
  const status = (parsed.values.status ?? "all").toLowerCase();
  const filter = STATUS_GROUPS[status] ?? ((s: LocalStatus) => s === status);
  if (!STATUS_GROUPS[status] && !(LOCAL_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`Unknown status "${status}". Use active, done, all, or one of: ${LOCAL_STATUSES.join(", ")}`);
  }
  const limit = parsed.values.limit ? Number.parseInt(parsed.values.limit, 10) : 20;
  if (!Number.isFinite(limit) || limit <= 0) throw new Error("--limit must be a positive integer");

  const { jobs, unreadable } = rt.requireService().registry.list();
  const shown = jobs.filter((j) => filter(j.localStatus)).slice(0, limit);
  if (shown.length === 0 && unreadable.length === 0) {
    rt.notify(status === "all" ? "No batch jobs in this project. Use /batch ask \"<objective>\"." : `No jobs with status ${status}.`, "info");
    return;
  }
  const lines = [`LOCAL ID          LOCAL STATUS       PROVIDER     ITEMS   MODEL                      CREATED            OBJECTIVE`];
  for (const j of shown) {
    lines.push(
      `${j.localId.padEnd(17)} ${(j.localStatus + (j.injectedAt ? "↩" : "")).padEnd(18)} ${(j.providerStatus ?? "-").padEnd(12)} ${itemsCell(j).padEnd(7)} ${j.model.slice(0, 26).padEnd(26)} ${formatIsoShort(j.createdAt).padEnd(18)} ${j.objective.replace(/\s+/g, " ").slice(0, 40)}`,
    );
  }
  for (const u of unreadable) lines.push(`${u.localId.padEnd(17)} UNREADABLE         ${u.reason}`);
  const total = jobs.filter((j) => filter(j.localStatus)).length;
  if (total > shown.length) lines.push(`… ${total - shown.length} more (use --limit)`);
  rt.notify(lines.join("\n"), "info");
}

async function cmdShow(rt: BatchRuntime, rest: string[], ctx: ExtensionCommandContext): Promise<void> {
  const service = rt.requireService();
  const id = requireId(rt, rest, "/batch show <id>");
  const job = service.registry.read(id);
  const events = service.registry.events(id).slice(-8);
  const lines = [
    ...describeJob(job, service.registry.jobDir(id)),
    "",
    "  Recent events:",
    ...events.map(
      (e) => `   ${formatIsoShort(e.eventAt)}  ${e.eventType}${e.previousStatus ? ` ${e.previousStatus} → ${e.newStatus}` : ""}${e.details ? ` ${JSON.stringify(e.details).slice(0, 120)}` : ""}`,
    ),
  ];
  if (job.usage) lines.push("", `  Usage: ${formatUsage(job.usage)}`);
  const items = jobItems(service.registry, job);
  if (items.length > 1 || job.workflow || job.kind === "synthesis") {
    const c = itemCounts(items.map((i) => i.status));
    lines.push("", `  Items: ${items.length} (completed ${c.completed}, failed ${c.failed}, corrupt ${c.corrupt}, missing ${c.missing})   /batch items ${id}`);
    if (job.usage && items.length > 1 && !items.some((i) => i.usage)) {
      lines.push("  Item-level usage: not reported by the provider (only the batch totals above; never apportioned)");
    }
  }
  const { retries, syntheses } = service.linkedJobs(id);
  for (const r of retries) lines.push(`  Linked retry:     ${r.localId} (${r.localStatus}, ${r.retryMode === "items" ? `${r.requestCount} item(s)` : "full re-run"})`);
  for (const s of syntheses) lines.push(`  Linked synthesis: ${s.localId} (${s.localStatus})`);
  const artifacts = rt.artifacts?.list({ jobId: id }) ?? [];
  for (const a of artifacts.slice(0, 10)) lines.push(`  Artifact:         ${a.artifactId} ${a.format} ${a.status} -> ${a.output?.path ?? "-"} (${a.source.state})`);
  if (artifacts.length > 10) lines.push(`  … ${artifacts.length - 10} more artifacts (/artifact list --job ${id})`);
  const available = rt.artifacts?.availableDefault(job);
  if (available && !artifacts.some((a) => a.output?.path === available.filename)) lines.push(`  Artifact available (not generated): /batch artifact ${id}   -> ${available.format} ${available.filename}`);
  if (job.synthesis) {
    lines.push(
      "",
      `  Synthesis of:     ${job.synthesis.sourceJobId}`,
      `  Coverage:         ${job.synthesis.included.length} of ${job.synthesis.expectedItems} item(s) included${job.synthesis.allowPartial ? " (partial explicitly allowed)" : ""}`,
      ...job.synthesis.excluded.map((e) => `    excluded item ${e.sourceOrdinal} ${sourceLabel(e)}: ${e.reason}`),
    );
  }
  await showText(rt, ctx, `Batch ${id}`, lines.join("\n"));
}

// ----------------------------------------------------------- read/inject

async function cmdRead(rt: BatchRuntime, rest: string[], ctx: ExtensionCommandContext): Promise<void> {
  const parsed = parseArgs(rest, { values: ["item"], booleans: ["full", "raw", "items", "synthesis"] });
  if (parsed.errors.length) throw new Error(`/batch read: ${parsed.errors.join("; ")}`);
  const chosen = ["full", "raw", "items", "synthesis"].filter((b) => parsed.booleans.has(b)).length + (parsed.values.item ? 1 : 0);
  if (chosen > 1) throw new Error("Use only one of --full, --raw, --items, --item <sel>, --synthesis");
  const id = requireId(rt, parsed.positionals, "/batch read <id> [--full|--raw|--items|--item <sel>|--synthesis]");
  const service = rt.requireService();
  const r = parsed.values.item
    ? service.describeItem(id, parsed.values.item, { text: true })
    : parsed.booleans.has("items")
      ? service.readAllItems(id)
      : parsed.booleans.has("synthesis")
        ? service.readSynthesis(id)
        : service.read(id, parsed.booleans.has("raw") ? "raw" : parsed.booleans.has("full") ? "full" : "default");
  await showText(rt, ctx, r.title, r.body);
}

function cmdInject(rt: BatchRuntime, rest: string[]): void {
  const parsed = parseArgs(rest, { values: ["item"], booleans: ["summary", "full", "synthesis"] });
  if (parsed.errors.length) throw new Error(`/batch inject: ${parsed.errors.join("; ")}`);
  if (parsed.booleans.has("full") && parsed.booleans.has("summary")) throw new Error("Use either --summary or --full, not both");
  if (parsed.values.item && parsed.booleans.has("synthesis")) throw new Error("Use either --item or --synthesis, not both");
  const id = requireId(rt, parsed.positionals, "/batch inject <id> [--item <sel>|--synthesis] [--summary|--full]");
  injectJob(rt, id, parsed.booleans.has("full") ? "full" : parsed.booleans.has("summary") ? "summary" : "default", {
    ...(parsed.values.item ? { item: parsed.values.item } : {}),
    ...(parsed.booleans.has("synthesis") ? { synthesis: true } : {}),
  });
}

export function injectJob(rt: BatchRuntime, id: string, mode: InjectMode, target: { item?: string; synthesis?: boolean } = {}): void {
  const service = rt.requireService();
  const built = service.buildInjection(id, mode, target);
  if (!built.ok) {
    rt.notify(built.message, "warning");
    return;
  }
  const injectedId = built.injectedJobId;
  // Supported Pi mechanism: a custom message stored in the session and sent to the
  // model as context. No triggerTurn: the user decides when the model responds.
  rt.pi.sendMessage({
    customType: INJECTED_MESSAGE_TYPE,
    content: built.content,
    display: true,
    details: {
      localId: injectedId,
      mode,
      bounded: built.bounded,
      characters: built.characters,
      ...(target.item ? { item: target.item } : {}),
      ...(target.synthesis ? { synthesisOf: id } : {}),
    },
  });
  service.recordInjection(injectedId, { mode, characters: built.characters, bounded: built.bounded });
  rt.poller.updateBadge();
  const what = `${injectedId}${target.item ? ` item ${target.item}` : ""}${target.synthesis ? ` (synthesis of ${id})` : ""}`;
  rt.notify(
    `Injected ${what} into the conversation (${built.characters} characters${built.bounded ? ", bounded excerpt" : ""}). It will be part of the model's context on your next message.`,
    "info",
  );
}


// ------------------------------------------------ check / cancel / retry

async function cmdCheck(rt: BatchRuntime, rest: string[]): Promise<void> {
  const service = rt.requireService();
  const raw = rest.find((t) => !t.startsWith("--"));
  if (raw) {
    const id = service.registry.resolveId(raw);
    const o = await service.reconcile(id, { force: true, waitForLockMs: CHECK_LOCK_WAIT_MS });
    rt.poller.updateBadge();
    const job = service.registry.read(id);
    const busy = o.skipped === "locked" ? ` — another check has held this job for over ${CHECK_LOCK_WAIT_MS / 1000}s; showing the last known state` : "";
    rt.notify(
      `${id}: ${job.localStatus}${job.providerStatus ? ` (provider: ${job.providerStatus})` : ""}${busy}${o.error ? `\nLast check failed: ${o.error}` : ""}`,
      o.error ? "warning" : "info",
    );
    return;
  }
  rt.notify("Checking batch jobs with OpenRouter…", "info");
  const outcomes = await rt.poller.checkNow(true);
  if (outcomes.length === 0) {
    rt.notify("No active batch jobs.", "info");
    return;
  }
  const lines = outcomes.map((o) => `${o.localId}: ${o.status}${o.skipped === "locked" ? " (busy)" : ""}${o.error ? ` — ${o.error}` : ""}`);
  rt.notify(lines.join("\n"), outcomes.some((o) => o.error) ? "warning" : "info");
}

async function cmdCancel(rt: BatchRuntime, rest: string[]): Promise<void> {
  const id = requireId(rt, rest, "/batch cancel <id>");
  const { message } = await rt.requireService().cancel(id);
  rt.poller.updateBadge();
  rt.notify(`${id}: ${message}`, "info");
}

async function cmdRetry(rt: BatchRuntime, rest: string[]): Promise<void> {
  const parsed = parseArgs(rest, { values: ["model"] });
  if (parsed.errors.length) throw new Error(`/batch retry: ${parsed.errors.join("; ")}`);
  const id = requireId(rt, parsed.positionals, "/batch retry <id> [--model <slug>]");
  const job = await rt.requireService().retry(id, { model: parsed.values.model });
  rt.poller.updateBadge();
  rt.notify(
    job.localStatus === "submitted"
      ? `✅ Retry ${job.localId} (retry #${job.retryCount} of ${id}, model ${job.model}) accepted by OpenRouter. Original job kept unchanged.`
      : `❌ Retry ${job.localId} ${job.localStatus}: ${job.error?.message ?? ""}`,
    job.localStatus === "submitted" ? "info" : "error",
  );
}

// ------------------------------------------------------ workflows / items

async function cmdRun(rt: BatchRuntime, rest: string[], ctx: ExtensionCommandContext, forcePreview: boolean): Promise<void> {
  const service = rt.requireService();
  const parsed = parseArgs(rest, {
    values: ["model", "account", "provider", "format", "prompt", "group-size", "input", "from-row", "to-row"],
    repeatable: ["file", "context", "id"],
    booleans: ["preview", "no-instructions"],
  });
  if (parsed.errors.length > 0) throw new Error(`/batch run: ${parsed.errors.join("; ")}`);
  const [workflow, ...words] = parsed.positionals;
  if (!workflow) throw new Error('Usage: /batch run <workflow> --input <file> [--preview]   or   /batch run map-files --file <path> --prompt "<objective>"');
  if (workflow.toLowerCase() !== "map-files") return runDataset(rt, workflow, parsed, ctx, forcePreview);
  for (const flag of ["input", "from-row", "to-row"]) if (parsed.values[flag] !== undefined) throw new Error(`--${flag} applies to dataset workflows, not map-files`);
  if (parsed.lists.id) throw new Error("--id applies to dataset workflows, not map-files");
  const format = (parsed.values.format ?? "markdown").toLowerCase();
  if (format !== "markdown" && format !== "json") throw new Error("--format must be markdown or json");
  const objective = (parsed.values.prompt ?? words.join(" ")).trim();
  if (!objective) throw new Error('/batch run map-files: give the shared objective with --prompt "<objective>"');
  let groupSize = 1;
  if (parsed.values["group-size"] !== undefined) {
    groupSize = Number(parsed.values["group-size"]);
    if (!Number.isInteger(groupSize) || groupSize < 1) throw new Error("--group-size must be a positive integer");
  }

  const plan = await service.planMapFiles({
    objective,
    files: parsed.lists.file ?? [],
    contexts: parsed.lists.context ?? [],
    groupSize,
    model: parsed.values.model,
    account: parsed.values.account,
    providerPin: parsed.values.provider,
    format,
    includeInstructions: !parsed.booleans.has("no-instructions"),
  });
  const previewOnly = forcePreview || parsed.booleans.has("preview");
  const preview = formatPlanPreview(plan, previewOnly);
  if (plan.blockers.length > 0) {
    // Nothing is persisted or sent when blocked.
    throw new SubmissionBlockedError(`${preview}\n\nPLAN BLOCKED — nothing was saved or sent:\n\n${plan.blockers.join("\n\n")}`);
  }
  if (previewOnly) {
    const job = await service.createWorkflowJob(plan, { previewOnly: true });
    rt.notify(`${preview}\n\nPlan saved as ${job.localId} (not submitted).\nInspect: ${service.registry.jobDir(job.localId)}\nSubmit:  /batch submit ${job.localId}`, "info");
    return;
  }
  const config = rt.loaded.config;
  if (config.submission.requireConfirmation && ctx.hasUI) {
    if (!(await ctx.ui.confirm(`Submit ${plan.items.length} request(s) as one batch?`, preview))) {
      rt.notify("Submission cancelled; nothing was sent.", "info");
      return;
    }
  } else if (config.submission.showPreview) {
    rt.notify(preview, "info");
  }
  const job = await service.createWorkflowJob(plan, { previewOnly: false });
  rt.poller.updateBadge();
  notifySubmitted(rt, job, `${job.requestCount} request(s) in one batch`);
}

function positiveIntFlag(parsed: ParsedArgs, name: string): number | undefined {
  const raw = parsed.values[name];
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Error(`--${name} must be a positive integer`);
  return Number(raw);
}

async function runDataset(rt: BatchRuntime, workflow: string, parsed: ParsedArgs, ctx: ExtensionCommandContext, forcePreview: boolean): Promise<void> {
  const service = rt.requireService();
  for (const flag of ["format", "prompt", "group-size"]) if (parsed.values[flag] !== undefined) throw new Error(`--${flag} applies to map-files; a project workflow defines its own prompt and output`);
  if (parsed.lists.file || parsed.lists.context) throw new Error("--file/--context apply to map-files; give the dataset with --input <file>");
  if (parsed.booleans.has("no-instructions")) throw new Error("--no-instructions applies to map-files");
  if (parsed.positionals.length > 1) throw new Error(`/batch run ${workflow}: unexpected argument ${JSON.stringify(parsed.positionals[1])}`);
  const input = parsed.values.input;
  if (!input) throw new Error(`Usage: /batch run ${workflow} --input <file.csv|file.jsonl> [--id <source-id> ...] [--from-row n --to-row m] [--preview]`);
  const prepared = await service.planDataset({
    workflow,
    input,
    ids: parsed.lists.id,
    fromRow: positiveIntFlag(parsed, "from-row"),
    toRow: positiveIntFlag(parsed, "to-row"),
    model: parsed.values.model,
    account: parsed.values.account,
    providerPin: parsed.values.provider,
  });
  const previewOnly = forcePreview || parsed.booleans.has("preview");
  const preview = formatDatasetPreview(prepared, previewOnly);
  if (prepared.blockers.length > 0) {
    throw new SubmissionBlockedError(`${preview}\n\nPLAN BLOCKED — nothing was saved or sent:\n\n${prepared.blockers.join("\n\n")}`);
  }
  if (previewOnly) {
    const job = await service.createDatasetJob(prepared, { previewOnly: true });
    rt.notify(`${preview}\n\nPlan saved as ${job.localId} (not submitted).\nInspect: ${service.registry.jobDir(job.localId)}\nSubmit:  /batch submit ${job.localId}`, "info");
    return;
  }
  const config = rt.loaded.config;
  if (config.submission.requireConfirmation && ctx.hasUI) {
    if (!(await ctx.ui.confirm(`Submit ${prepared.plan!.items.length} request(s) as one batch?`, preview))) {
      rt.notify("Submission cancelled; nothing was sent.", "info");
      return;
    }
  } else if (config.submission.showPreview) {
    rt.notify(preview, "info");
  }
  const job = await service.createDatasetJob(prepared, { previewOnly: false });
  rt.poller.updateBadge();
  notifySubmitted(rt, job, `${job.requestCount} request(s) in one batch`);
}

export function formatDatasetPreview(p: PreparedDatasetRun, previewOnly: boolean): string {
  const def = p.definition;
  const plan = p.plan;
  const c = plan?.counts;
  const sel = p.options.ids?.length
    ? `--id ${p.options.ids.join(", ")}`
    : p.options.fromRow !== undefined || p.options.toRow !== undefined
      ? `rows ${p.options.fromRow ?? 1}-${p.options.toRow ?? "end"}`
      : "all rows";
  const lines = [
    p.blockers.length > 0 ? "Dataset workflow plan (BLOCKED)" : previewOnly ? "Dataset workflow plan (not submitted)" : "Submitting dataset workflow",
    "",
    `Workflow:          ${p.options.workflow}${p.entry ? ` (project: ${p.entry.file})` : ""}`,
    ...(p.entry?.definitionSha256 ? [`Definition:        sha256 ${p.entry.definitionSha256}`] : []),
  ];
  if (def && plan) {
    lines.push(
      `Dataset:           ${plan.dataset.type} ${plan.dataset.path}  (${plan.dataset.bytes} bytes, sha256 ${plan.dataset.sha256})`,
      `Selection:         ${sel}`,
      `Rows:              ${c!.totalRows} parsed · ${c!.selectedRows} selected · ${c!.excludedRows} excluded · ${c!.invalidRows} invalid${c!.blankLines ? ` · ${c!.blankLines} blank line(s) ignored` : ""}`,
      `Source IDs:        field ${def.input.idField} · ${c!.missingIds} missing · ${c!.duplicateIds} duplicate`,
      `Requests planned:  ${c!.plannedRequests}`,
      `Fields sent:       ${def.input.fields.join(", ")}  (only these reach the model; other columns are not read into prompts)`,
      `Model:             ${p.model}`,
      `Account:           ${p.account}`,
      `Provider pin:      ${p.pin ? `${p.pin.only.join(",")} (no fallbacks)` : "none"}`,
      `Output:            ${def.output.type === "json" ? "json — validated locally against the workflow's JSON Schema; invalid output makes the item corrupt" : "markdown"}`,
      `Characters:        ${plan.totalCharacters} provider-bound (not a token count; no cost estimate is made)`,
      `Largest item:      ${plan.largest ? `${plan.largest.characters} characters (${plan.largest.label})` : "-"}`,
      `Limits (local):    requests ${p.limits.maxRequests} · rows ${p.limits.maxRows} · per item ${p.limits.maxCharactersPerItem} · total ${p.limits.maxTotalCharacters} characters`,
      `Secrets:           ${plan.secretFindings.length === 0 ? "none detected" : `${plan.secretFindings.length} potential finding(s)`} (scanned: exactly the provider-bound messages)`,
      `Synthesis:         ${def.synthesis.enabled ? "enabled (run /batch synthesize <id> after it finishes)" : "disabled by the workflow"}`,
      `Plan SHA-256:      ${plan.planSha256 || "-"}`,
      `Warnings:          ${p.warnings.length === 0 ? "none" : p.warnings.join("; ")}`,
    );
    if (plan.items.length > 0) {
      lines.push("", "Items:");
      for (const it of plan.items.slice(0, 30)) lines.push(`  ${String(it.ordinal).padStart(3, "0")}  ${String(it.characters).padStart(8)} chars  ${sourceLabel(it)}`);
      if (plan.items.length > 30) lines.push(`  … ${plan.items.length - 30} more (all listed in request/dataset.json)`);
    }
  }
  return lines.join("\n");
}

// --------------------------------------------------------- workflow / export

async function cmdWorkflow(rt: BatchRuntime, rest: string[], ctx: ExtensionCommandContext): Promise<void> {
  const service = rt.requireService();
  const parsed = parseArgs(rest, { values: ["file"] });
  if (parsed.errors.length) throw new Error(`/batch workflow: ${parsed.errors.join("; ")}`);
  const [action = "list", name] = parsed.positionals;
  const root = service.workspaceRoot;
  if (action === "list") {
    const catalog = discoverWorkflows(root);
    const lines = ["BUILT-IN", ...BUILTIN_WORKFLOWS.map((b) => `  ${b.name.padEnd(28)} ${b.description}`), "", `PROJECT (${catalog.dir}/)`];
    if (catalog.entries.length === 0) lines.push("  none");
    for (const e of catalog.entries) {
      lines.push(`  ${e.name.padEnd(28)} ${e.valid ? "valid  " : "INVALID"} ${e.valid ? `${e.definition!.input.type} → ${e.definition!.output.type}${e.definition!.description ? `  ${e.definition!.description}` : ""}` : `${e.diagnostics.length} problem(s): /batch workflow validate ${e.name}`}`);
    }
    await showText(rt, ctx, "Batch workflows", lines.join("\n"));
    return;
  }
  if (action === "validate") {
    if (parsed.values.file && name) throw new Error("Use either /batch workflow validate <name> or --file <path>, not both");
    const entry = parsed.values.file ? validateWorkflowFile(root, parsed.values.file, rt.loaded.config) : name ? findWorkflow(root, name) : undefined;
    if (!entry) throw new Error("Usage: /batch workflow validate <name> | --file <path>");
    const warn = entry.warnings.length ? `\nWarnings:\n${formatDiagnostics(entry.warnings)}` : "";
    if (entry.valid) rt.notify(`✅ ${entry.file} is a valid workflow definition (${entry.name}).\nDefinition SHA-256: ${entry.definitionSha256}\nResolved SHA-256:   ${entry.resolvedSha256}${warn}`, "info");
    else rt.notify(`❌ ${entry.file} is not a valid workflow definition:\n${formatDiagnostics(entry.diagnostics)}${warn}`, "warning");
    return;
  }
  if (action === "show") {
    if (!name) throw new Error("Usage: /batch workflow show <name>");
    const builtin = BUILTIN_WORKFLOWS.find((b) => b.name === name);
    if (builtin) {
      await showText(rt, ctx, `Workflow ${name} (built-in)`, `${builtin.description}\n\nUsage: ${builtin.usage}`);
      return;
    }
    const e = findWorkflow(root, name);
    const lines = [`  File               ${e.file}`, `  Origin             project`, `  Status             ${e.valid ? "valid" : "INVALID"}`, `  Definition SHA-256 ${e.definitionSha256 ?? "-"}`];
    if (e.valid && e.definition) {
      const d = e.definition;
      lines.push(
        `  Resolved SHA-256   ${e.resolvedSha256}`,
        `  Description        ${d.description ?? "-"}`,
        `  Model              ${d.model.default ?? `(config default: ${rt.loaded.config.defaultModel})`}${d.model.provider ? `  pin ${d.model.provider}` : ""}`,
        `  Input              ${d.input.type}${d.input.delimiter && d.input.delimiter !== "," ? ` (delimiter ${JSON.stringify(d.input.delimiter)})` : ""}, ID field ${d.input.idField}`,
        `  Fields sent        ${d.input.fields.join(", ")}`,
        `  Output             ${d.output.type}`,
        `  Synthesis          ${d.synthesis.enabled ? "enabled" : "disabled"}`,
        `  Limits             ${Object.keys(d.limits).length ? Object.entries(d.limits).map(([k, v]) => `${k} ${v}`).join(", ") : "config defaults"}`,
        "",
        "  Prompt template:",
        ...d.request.prompt.split("\n").map((l) => `    ${l}`),
      );
      if (d.request.system) lines.push("", "  System prompt:", ...d.request.system.split("\n").map((l) => `    ${l}`));
      if (d.output.type === "json") lines.push("", "  Output schema:", ...JSON.stringify(d.output.schema, null, 2).split("\n").map((l) => `    ${l}`));
    } else {
      lines.push("", "  Problems:", formatDiagnostics(e.diagnostics));
    }
    if (e.warnings.length) lines.push("", "  Warnings:", formatDiagnostics(e.warnings));
    await showText(rt, ctx, `Workflow ${name}`, lines.join("\n"));
    return;
  }
  throw new Error(`Unknown workflow action "${action}". Use: /batch workflow list | show <name> | validate <name> | validate --file <path>`);
}

function cmdExport(rt: BatchRuntime, rest: string[]): void {
  const parsed = parseArgs(rest, { values: ["format", "out"], booleans: ["overwrite", "job-only"] });
  if (parsed.errors.length) throw new Error(`/batch export: ${parsed.errors.join("; ")}`);
  const id = requireId(rt, parsed.positionals, "/batch export <id> --format jsonl|csv [--out <path>] [--overwrite] [--job-only]");
  const format = (parsed.values.format ?? "").toLowerCase();
  if (format !== "jsonl" && format !== "csv") throw new Error("--format jsonl or --format csv is required");
  const rec = rt.requireService().exportResults(id, { format, out: parsed.values.out, overwrite: parsed.booleans.has("overwrite"), jobOnly: parsed.booleans.has("job-only") });
  rt.notify(`Exported ${rec.records} record(s) of ${id} as ${format}${rec.combined ? " (including results from linked retries)" : ""}:\n  ${rec.path}\n  sha256 ${rec.sha256}`, "info");
}

async function cmdImportLegacy(rt: BatchRuntime, rest: string[], ctx: ExtensionCommandContext): Promise<void> {
  const parsed = parseArgs(rest, { booleans: ["preview"] });
  if (parsed.errors.length) throw new Error(`/batch import-legacy: ${parsed.errors.join("; ")}`);
  const file = parsed.positionals[0];
  if (!file || parsed.positionals.length > 1) throw new Error("Usage: /batch import-legacy <path-to-jobs.json> --preview");
  if (!parsed.booleans.has("preview")) {
    throw new SubmissionBlockedError(
      "Importing legacy jobs is not available in this release; nothing was changed.\n" +
        "The legacy jobs.json is one global file with no record of which project each job belonged to, and it holds no raw\n" +
        "provider responses or submitted requests, so its records could only become unverifiable history in this project.\n" +
        `Use /batch import-legacy ${file} --preview for a read-only inventory.`,
    );
  }
  const inventory = rt.requireService().legacyInventory(file);
  await showText(rt, ctx, "Legacy jobs (preview)", formatLegacyInventory(inventory));
}

function formatPlanPreview(p: PreparedPlan, previewOnly: boolean): string {
  const groups = p.workflow.options.groupSize > 1;
  const excluded = p.pkg.excluded;
  const lines = [
    p.blockers.length > 0 ? "Workflow plan (BLOCKED)" : previewOnly ? "Workflow plan (not submitted)" : "Submitting workflow",
    "",
    `Workflow:          ${p.workflow.name} v${p.workflow.version}${groups ? ` (groups of ${p.workflow.options.groupSize})` : ""}`,
    `Objective:         ${p.options.objective.replace(/\s+/g, " ").slice(0, 100)}`,
    `Model:             ${p.model}`,
    `Account:           ${p.account}`,
    `Provider pin:      ${p.pin ? `${p.pin.only.join(",")} (no fallbacks)` : "none"}`,
    `Requests:          ${p.items.length}`,
    `Selected files:    ${p.pkg.files.length}`,
    `Total characters:  ${p.totalCharacters}  (prompt characters; not a token count)`,
    `Largest item:      ${p.largest ? `${p.largest.characters} characters (${p.largest.label})` : "-"}`,
    `Excluded files:    ${excluded.length}${excluded.length ? `  (${excluded.slice(0, 4).map((e) => `${e.relPath} [${e.layer}]`).join(", ")}${excluded.length > 4 ? ", …" : ""})` : ""}`,
    `Blocked files:     ${p.pkg.problems.length}`,
    `Secrets:           ${p.pkg.secretFindings.length === 0 ? "none detected" : `${p.pkg.secretFindings.length} potential finding(s)`}`,
    `Output mode:       ${p.options.format}`,
    `Synthesis:         not part of this job (run /batch synthesize <id> after it finishes)`,
    `Warnings:          ${p.pkg.warnings.length === 0 ? "none" : p.pkg.warnings.join("; ")}`,
  ];
  if (p.items.length > 0) {
    lines.push("", "Items:");
    for (const it of p.items.slice(0, 30)) lines.push(`  ${String(it.ordinal).padStart(3, "0")}  ${String(it.characters).padStart(8)} chars  ${sourceLabel(it)}`);
    if (p.items.length > 30) lines.push(`  … ${p.items.length - 30} more (all listed in request/plan.json)`);
  }
  return lines.join("\n");
}

function notifySubmitted(rt: BatchRuntime, job: JobManifest, what: string): void {
  if (job.localStatus === "submitted") {
    rt.notify(
      `✅ Accepted by OpenRouter (${job.providerStatus ?? "?"}) — ${what}; queued, not completed.\n` +
        `Job: ${job.localId}   Provider batch: ${job.providerBatchId}\n` +
        `Track: /batch show ${job.localId}   Items: /batch items ${job.localId}   (polled in the background; survives restarts)`,
      "info",
    );
  } else {
    rt.notify(`❌ ${job.localId} ${job.localStatus}: ${job.error?.message ?? "unknown error"}\nHistory kept: /batch show ${job.localId}`, "error");
  }
}

async function cmdItems(rt: BatchRuntime, rest: string[], ctx: ExtensionCommandContext): Promise<void> {
  const id = requireId(rt, rest, "/batch items <id>");
  await showText(rt, ctx, `Items of ${id}`, rt.requireService().describeItems(id));
}

async function cmdItem(rt: BatchRuntime, rest: string[], ctx: ExtensionCommandContext): Promise<void> {
  const parsed = parseArgs(rest, { booleans: ["text", "raw"] });
  if (parsed.errors.length) throw new Error(`/batch item: ${parsed.errors.join("; ")}`);
  const [rawId, selector] = parsed.positionals;
  if (!rawId || !selector) throw new Error("Usage: /batch item <id> <n|custom_id|path> [--text] [--raw]");
  const service = rt.requireService();
  const id = service.registry.resolveId(rawId);
  const r = service.describeItem(id, selector, { text: parsed.booleans.has("text"), raw: parsed.booleans.has("raw") });
  await showText(rt, ctx, r.title, r.body);
}

async function cmdRetryItems(rt: BatchRuntime, rest: string[]): Promise<void> {
  const parsed = parseArgs(rest, { values: ["model"], repeatable: ["item"], booleans: ["failed", "preview"] });
  if (parsed.errors.length) throw new Error(`/batch retry-items: ${parsed.errors.join("; ")}`);
  const id = requireId(rt, parsed.positionals, "/batch retry-items <id> --failed | --item <sel> [--item <sel>] [--model <slug>] [--preview]");
  const job = await rt.requireService().retryItems(id, {
    failed: parsed.booleans.has("failed"),
    selectors: parsed.lists.item ?? [],
    model: parsed.values.model,
    previewOnly: parsed.booleans.has("preview"),
  });
  rt.poller.updateBadge();
  const which = (job.items ?? []).map((i) => `${i.replaces?.ordinal ?? "?"}`).join(", ");
  if (job.localStatus === "previewed") {
    rt.notify(`Retry plan ${job.localId} saved (not submitted): ${job.requestCount} item(s) of ${id} [${which}], model ${job.model}.\nSubmit: /batch submit ${job.localId}`, "info");
    return;
  }
  notifySubmitted(rt, job, `retry of ${job.requestCount} item(s) of ${id} [${which}]; ${id} is kept unchanged`);
}

async function cmdSynthesize(rt: BatchRuntime, rest: string[], ctx: ExtensionCommandContext): Promise<void> {
  const parsed = parseArgs(rest, { values: ["model", "account", "provider"], booleans: ["allow-partial", "preview"] });
  if (parsed.errors.length) throw new Error(`/batch synthesize: ${parsed.errors.join("; ")}`);
  const id = requireId(rt, parsed.positionals, "/batch synthesize <id> [--allow-partial] [--model <slug>] [--preview]");
  const service = rt.requireService();
  const prepared = await service.prepareSynthesis(id, {
    allowPartial: parsed.booleans.has("allow-partial"),
    model: parsed.values.model,
    account: parsed.values.account,
    providerPin: parsed.values.provider,
  });
  const previewOnly = parsed.booleans.has("preview");
  const preview = formatSynthesisPreview(prepared, previewOnly);
  if (prepared.blockers.length > 0) {
    throw new SubmissionBlockedError(`${preview}\n\nSYNTHESIS BLOCKED — nothing was saved or sent:\n\n${prepared.blockers.join("\n\n")}`);
  }
  if (previewOnly) {
    const job = await service.createSynthesisJob(prepared, { previewOnly: true });
    rt.notify(`${preview}\n\nSynthesis saved as ${job.localId} (not submitted).\nSubmit: /batch submit ${job.localId}`, "info");
    return;
  }
  const config = rt.loaded.config;
  if (config.submission.requireConfirmation && ctx.hasUI) {
    if (!(await ctx.ui.confirm("Submit synthesis batch?", preview))) {
      rt.notify("Submission cancelled; nothing was sent.", "info");
      return;
    }
  } else if (config.submission.showPreview) {
    rt.notify(preview, "info");
  }
  const job = await service.createSynthesisJob(prepared, { previewOnly: false });
  rt.poller.updateBadge();
  notifySubmitted(rt, job, `synthesis of ${id}`);
}

function formatSynthesisPreview(p: PreparedSynthesis, previewOnly: boolean): string {
  const c = p.coverage;
  return [
    p.blockers.length > 0 ? "Synthesis plan (BLOCKED)" : previewOnly ? "Synthesis plan (not submitted)" : "Submitting synthesis",
    "",
    `Source job:        ${p.sourceJobId}`,
    `Model:             ${p.model}`,
    `Provider pin:      ${p.pin ? `${p.pin.only.join(",")} (no fallbacks)` : "none"}`,
    `Expected items:    ${c.expected}`,
    `Included items:    ${c.included}`,
    `Unusable items:    ${c.unusable.length}  (failed ${c.failed}, corrupt ${c.corrupt}, missing ${c.missing}${c.noResult ? `, no result ${c.noResult}` : ""})`,
    `Partial allowed:   ${c.allowPartial ? "yes" : "no"}`,
    `Package size:      ${p.characters} characters (not a token count)`,
    ...c.unusable.map((u) => `  - item ${u.sourceOrdinal} ${u.sourceLabel}: ${u.reason}`),
  ].join("\n");
}

// ------------------------------------------------------- settings / view

function cmdSetting(rt: BatchRuntime, key: "defaultModel" | "defaultAccount", rest: string[], isGlobal: boolean): void {
  const value = rest.join(" ").trim();
  const label = key === "defaultModel" ? "model" : "account (provider)";
  if (!value) {
    rt.notify(`Current default batch ${label}: ${rt.loaded.config[key]}${key === "defaultModel" ? ` [${rt.loaded.config.defaultAccount}]` : ""}`, "info");
    return;
  }
  const file = saveConfigUpdate({ [key]: value }, { cwd: rt.cwd, global: isGlobal });
  rt.reloadConfig();
  rt.notify(`Default batch ${label} set to: ${value} (${isGlobal ? "saved globally" : "saved for this project"}: ${file})`, "info");
}

async function cmdView(rt: BatchRuntime, ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI || ctx.mode !== "tui") {
    rt.notify("The dashboard is only available in TUI mode. Use /batch list instead.", "warning");
    return;
  }
  const service = rt.requireService();
  type Next = { kind: "read" | "inject"; id: string } | undefined;
  const next = await ctx.ui.custom<Next>((tui, _theme, _kb, done) => {
    const comp = new BatchDashboardComponent(
      service.registry.list().jobs,
      {
        refresh: async () => {
          await rt.poller.checkNow(true);
          return service.registry.list().jobs;
        },
        cancel: async (id) => {
          const { message } = await service.cancel(id);
          comp.updateJobs(service.registry.list().jobs);
          rt.poller.updateBadge();
          return message;
        },
        read: (id) => done({ kind: "read", id }),
        inject: (id) => done({ kind: "inject", id }),
        close: () => done(undefined),
      },
      () => tui.requestRender(),
    );
    return comp;
  });
  if (next?.kind === "read") {
    const { title, body } = service.read(next.id, "default");
    await showText(rt, ctx, title, body);
  } else if (next?.kind === "inject") {
    injectJob(rt, next.id, "default");
  }
}

/** Long text: scrollable viewer in TUI, notification elsewhere (RPC). Never enters model context. */
async function showText(rt: BatchRuntime, ctx: ExtensionCommandContext, title: string, body: string): Promise<void> {
  if (ctx.hasUI && ctx.mode === "tui") {
    await ctx.ui.custom<void>((_tui, _theme, _kb, done) => new TextViewerComponent(title, body, () => done(undefined), () => process.stdout.rows ?? 24));
    return;
  }
  rt.notify(`${title}\n\n${body}`, "info");
}
