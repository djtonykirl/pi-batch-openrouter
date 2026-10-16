import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { parseArgs, tokenize } from "./args.js";
import { saveConfigUpdate } from "./config.js";
import { BatchDashboardComponent, TextViewerComponent, describeJob } from "./dashboard.js";
import { discoverBatchModels } from "./models.js";
import { INJECTED_MESSAGE_TYPE, type BatchRuntime } from "./runtime.js";
import { DuplicateActiveRequestError, SubmissionBlockedError, formatUsage, type InjectMode, type PreparedAsk } from "./service.js";
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
};

const HELP = `/batch — deferred OpenRouter Batch goals

  ask [options] "<objective>"        submit (alias: goal)
      --file <path>                  include a file (repeatable; blocks if excluded/binary/secret)
      --context <path>               include a file or directory (repeatable; excluded files skipped & listed)
      --model <slug>  --account <pi-provider-alias>  --provider <upstream-slug pin>
      --format markdown|json  --preview  --no-instructions
  submit <id>                        submit a job created with --preview
  list [--status active|ready|failed|<status>|all] [--limit n]
  show <id>                          local + provider status, usage, artefact path
  read <id> [--full|--raw]           locally retrieved result (no network)
  inject <id> [--summary|--full]     add the result to THIS conversation's context
  check [id]                         reconcile with OpenRouter now
  cancel <id>                        request cancellation; history is kept
  retry <id> [--model <slug>]        new linked job from the exact original request
  view                               TUI dashboard
  [--global] model [slug]            default batch model
  [--global] provider [alias]        default Pi account for the API key

IDs accept a unique suffix, e.g. "A7C2". Results are advisory and never applied to files automatically.`;

export function registerBatchCommand(rt: BatchRuntime): void {
  rt.pi.registerCommand("batch", {
    description: "Deferred OpenRouter Batch goals: ask, list, show, read, inject, check, cancel, retry",
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
        const level = err instanceof SubmissionBlockedError || err instanceof DuplicateActiveRequestError ? "warning" : "error";
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
  const lines = [`LOCAL ID          LOCAL STATUS       PROVIDER     MODEL                      CREATED            OBJECTIVE`];
  for (const j of shown) {
    lines.push(
      `${j.localId.padEnd(17)} ${(j.localStatus + (j.injectedAt ? "↩" : "")).padEnd(18)} ${(j.providerStatus ?? "-").padEnd(12)} ${j.model.slice(0, 26).padEnd(26)} ${formatIsoShort(j.createdAt).padEnd(18)} ${j.objective.replace(/\s+/g, " ").slice(0, 40)}`,
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
  await showText(rt, ctx, `Batch ${id}`, lines.join("\n"));
}

// ----------------------------------------------------------- read/inject

async function cmdRead(rt: BatchRuntime, rest: string[], ctx: ExtensionCommandContext): Promise<void> {
  const parsed = parseArgs(rest, { booleans: ["full", "raw"] });
  if (parsed.errors.length) throw new Error(`/batch read: ${parsed.errors.join("; ")}`);
  if (parsed.booleans.has("full") && parsed.booleans.has("raw")) throw new Error("Use either --full or --raw, not both");
  const id = requireId(rt, parsed.positionals, "/batch read <id> [--full|--raw]");
  const mode = parsed.booleans.has("raw") ? "raw" : parsed.booleans.has("full") ? "full" : "default";
  const { title, body } = rt.requireService().read(id, mode);
  await showText(rt, ctx, title, body);
}

function cmdInject(rt: BatchRuntime, rest: string[]): void {
  const parsed = parseArgs(rest, { booleans: ["summary", "full"] });
  if (parsed.errors.length) throw new Error(`/batch inject: ${parsed.errors.join("; ")}`);
  if (parsed.booleans.has("full") && parsed.booleans.has("summary")) throw new Error("Use either --summary or --full, not both");
  const id = requireId(rt, parsed.positionals, "/batch inject <id> [--summary|--full]");
  injectJob(rt, id, parsed.booleans.has("full") ? "full" : parsed.booleans.has("summary") ? "summary" : "default");
}

export function injectJob(rt: BatchRuntime, id: string, mode: InjectMode): void {
  const service = rt.requireService();
  const built = service.buildInjection(id, mode);
  if (!built.ok) {
    rt.notify(built.message, "warning");
    return;
  }
  // Supported Pi mechanism: a custom message stored in the session and sent to the
  // model as context. No triggerTurn: the user decides when the model responds.
  rt.pi.sendMessage({
    customType: INJECTED_MESSAGE_TYPE,
    content: built.content,
    display: true,
    details: { localId: id, mode, bounded: built.bounded, characters: built.characters },
  });
  service.recordInjection(id, { mode, characters: built.characters, bounded: built.bounded });
  rt.poller.updateBadge();
  rt.notify(
    `Injected ${id} into the conversation (${built.characters} characters${built.bounded ? ", bounded excerpt" : ""}). It will be part of the model's context on your next message.`,
    "info",
  );
}

// ------------------------------------------------ check / cancel / retry

async function cmdCheck(rt: BatchRuntime, rest: string[]): Promise<void> {
  const service = rt.requireService();
  const raw = rest.find((t) => !t.startsWith("--"));
  if (raw) {
    const id = service.registry.resolveId(raw);
    const o = await service.reconcile(id, { force: true });
    rt.poller.updateBadge();
    const job = service.registry.read(id);
    rt.notify(
      `${id}: ${job.localStatus}${job.providerStatus ? ` (provider: ${job.providerStatus})` : ""}${o.skipped === "locked" ? " — another check is in progress" : ""}${o.error ? `\nLast check failed: ${o.error}` : ""}`,
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
