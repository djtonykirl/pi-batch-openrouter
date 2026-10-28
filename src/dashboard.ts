import type { Component } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { ACTIVE_STATUSES, TERMINAL_STATUSES as TERMINAL, type LocalStatus } from "./state.js";
import { formatPin } from "./openrouter/routing.js";
import { RETENTION_DELETED, RETENTION_KEPT } from "./privacy/policy.js";
import { formatIsoShort } from "./time.js";
import { sourceLabel } from "./items.js";
import { isDatasetWorkflow, isMetadataWorkflow, type JobManifest } from "./types.js";

export interface DashboardActions {
  refresh(): Promise<JobManifest[]>;
  cancel(localId: string): Promise<string>;
  /** Close the dashboard and open the result viewer. */
  read(localId: string): void;
  /** Close the dashboard and inject (default mode). */
  inject(localId: string): void;
  close(): void;
}

/** Interactive list of jobs, drawn from the durable registry (not in-memory state). */
export class BatchDashboardComponent implements Component {
  private selectedIndex = 0;
  private isDetailed = false;
  private flash = "";

  constructor(
    private jobs: JobManifest[],
    private readonly actions: DashboardActions,
    private readonly requestRender: () => void,
  ) {}

  public invalidate(): void {}

  public updateJobs(jobs: JobManifest[]): void {
    this.jobs = jobs;
    if (this.selectedIndex >= this.jobs.length) this.selectedIndex = Math.max(0, this.jobs.length - 1);
  }

  private get selected(): JobManifest | undefined {
    return this.jobs[this.selectedIndex];
  }

  private setFlash(text: string): void {
    this.flash = text;
    this.requestRender();
  }

  public handleInput(data: string): void {
    if (matchesKey(data, "escape") || data === "q" || data === "Q") {
      if (this.isDetailed && matchesKey(data, "escape")) {
        this.isDetailed = false;
        return;
      }
      this.actions.close();
      return;
    }
    if (this.isDetailed && (matchesKey(data, "enter") || data === "b")) {
      this.isDetailed = false;
      return;
    }
    if (!this.isDetailed && (matchesKey(data, "up") || data === "k")) {
      if (this.selectedIndex > 0) this.selectedIndex--;
      return;
    }
    if (!this.isDetailed && (matchesKey(data, "down") || data === "j")) {
      if (this.selectedIndex < this.jobs.length - 1) this.selectedIndex++;
      return;
    }
    if (!this.isDetailed && matchesKey(data, "enter")) {
      if (this.selected) this.isDetailed = true;
      return;
    }
    const job = this.selected;
    if (data === "r" || data === "R") {
      this.setFlash("Refreshing…");
      void this.actions.refresh().then(
        (jobs) => {
          this.updateJobs(jobs);
          this.setFlash("Refreshed.");
        },
        (err: Error) => this.setFlash(`Refresh failed: ${err.message}`),
      );
      return;
    }
    if (!job) return;
    if (data === "c" || data === "C") {
      if (!ACTIVE_STATUSES.has(job.localStatus) && job.localStatus !== "previewed") {
        this.setFlash(`${job.localId} is ${job.localStatus}; nothing to cancel.`);
        return;
      }
      this.setFlash(`Cancelling ${job.localId}…`);
      void this.actions.cancel(job.localId).then(
        (msg) => this.setFlash(msg.split("\n").join(" ")),
        (err: Error) => this.setFlash(`Cancel failed: ${err.message}`),
      );
      return;
    }
    if (data === "o" || data === "O") {
      this.actions.read(job.localId);
      return;
    }
    if (data === "i" || data === "I") {
      if (job.localStatus !== "ready" && job.localStatus !== "partial") {
        this.setFlash(`${job.localId} is ${job.localStatus}; only ready/partial results can be injected.`);
        return;
      }
      this.actions.inject(job.localId);
    }
  }

  public render(width: number): string[] {
    const w = Math.max(20, width);
    const hr = "─".repeat(w);
    const fit = (s: string) => truncateToWidth(s, w);
    if (this.isDetailed && this.selected) return this.renderDetail(this.selected, w, hr).map(fit);

    const lines: string[] = [`\x1b[1;36m📦 Batch Jobs\x1b[0m  \x1b[90m(.pi/batches)\x1b[0m`, hr];
    if (this.jobs.length === 0) {
      lines.push("  No batch jobs. Use /batch ask \"<objective>\" to submit one.", "", "\x1b[90m[Esc/q] Close\x1b[0m");
      return lines.map(fit);
    }
    lines.push(`\x1b[90m  LOCAL ID          LOCAL STATUS        PROVIDER      ITEMS   CREATED            OBJECTIVE\x1b[0m`, hr);
    this.jobs.forEach((job, i) => {
      const sel = i === this.selectedIndex;
      const status = `${statusColor(job.localStatus)}${job.localStatus.padEnd(19)}\x1b[0m`;
      const injected = job.injectedAt ? "↩" : " ";
      const row = `${sel ? "\x1b[36m▶\x1b[0m" : " "} ${job.localId.padEnd(17)} ${status}${injected}${(job.providerStatus ?? "-").padEnd(13)} ${itemsCell(job).padEnd(7)} ${formatIsoShort(job.createdAt).padEnd(18)} ${job.objective.replace(/\s+/g, " ")}`;
      lines.push(sel ? `\x1b[7m${row}\x1b[27m` : row);
    });
    lines.push(hr);
    if (this.flash) lines.push(`\x1b[33m${this.flash}\x1b[0m`);
    lines.push("\x1b[90m[↑/↓] Move  [Enter] Details  [o] Read  [i] Inject  [c] Cancel  [r] Refresh  [q] Close\x1b[0m");
    return lines.map(fit);
  }

  private renderDetail(job: JobManifest, width: number, hr: string): string[] {
    const lines = [`\x1b[1;36m📦 ${job.localId}\x1b[0m`, hr, ...describeJob(job).flatMap((l) => wrapTextWithAnsi(l, width))];
    if (job.items && job.items.length > 1) {
      lines.push("", "  Items:");
      for (const it of job.items.slice(0, 20)) {
        const src = sourceLabel(it);
        lines.push(...wrapTextWithAnsi(`   ${String(it.ordinal).padStart(3, "0")} ${it.status.padEnd(10)} ${src}`, width));
      }
      if (job.items.length > 20) lines.push(`   … ${job.items.length - 20} more (/batch items ${job.localId})`);
      // Wrapped, not truncated: a cut-off hint (e.g. without --allow-partial) would be a different command.
      lines.push("", ...wrapTextWithAnsi(`  \x1b[90m${detailCommandHints(job).join("  ·  ")}\x1b[0m`, width));
    }
    lines.push(hr);
    if (this.flash) lines.push(`\x1b[33m${this.flash}\x1b[0m`);
    lines.push("\x1b[90m[o] Read  [i] Inject  [c] Cancel  [Enter/b/Esc] Back  [q] Close\x1b[0m");
    return lines;
  }
}

/**
 * Follow-up commands for a multi-item job, offered only when the command would be accepted
 * in the job's current state (mirrors the guards in retryItems / prepareSynthesis).
 */
export function detailCommandHints(job: JobManifest): string[] {
  const id = job.localId;
  const hints = [`/batch items ${id}`];
  const items = job.items ?? [];
  const retryable = new Set<LocalStatus>(["partial", "failed", "corrupt", "expired", "cancelled"]);
  // A possibly-accepted submission must be checked on OpenRouter first, so no retry is suggested.
  const unknownSubmission = job.error?.code === "submission_unknown";
  const hasUnusable = job.localStatus === "partial" ? items.some((i) => i.status !== "completed") : items.length > 0;
  if (retryable.has(job.localStatus) && hasUnusable && !unknownSubmission) hints.push(`/batch retry-items ${id} --failed`);
  const synthesisAllowed = !isDatasetWorkflow(job.workflow) || job.workflow.synthesisEnabled;
  if (job.kind !== "synthesis" && synthesisAllowed && items.some((i) => i.status === "completed")) {
    if (job.localStatus === "ready") hints.push(`/batch synthesize ${id}`);
    else if (job.localStatus === "partial") hints.push(`/batch synthesize ${id} --allow-partial`);
  }
  if (isDatasetWorkflow(job.workflow) && TERMINAL.has(job.localStatus)) hints.push(`/batch export ${id} --format jsonl`);
  return hints;
}

/** Shared by `/batch show` and the dashboard detail view. Only fields actually known are shown. */
export function describeJob(job: JobManifest, storageDir?: string): string[] {
  const multi = (job.items?.length ?? 0) > 1;
  const rows: Array<[string, string | number | undefined]> = [
    ["Job", job.localId],
    ["Provider batch ID", job.providerBatchId ?? (job.route === "immediate" ? "none (immediate route)" : undefined)],
    ["Route", job.route ?? job.privacy?.route],
    ["Privacy", job.privacy?.level],
    ["Enforcement", job.privacy?.enforcement],
    ["Remote deletion", remoteDeletionCell(job)],
    ["Local status", job.localStatus],
    ["Provider status", job.providerStatus],
    ["Objective", job.objective.replace(/\s+/g, " ")],
    ["Model", job.model],
    ["Account", job.account],
    ["Provider pin", job.providerPin ? formatPin(job.providerPin) : undefined],
    ["Parent job", job.parentJobId],
    ["Retry count", job.retryCount || undefined],
    ["Kind", job.kind && job.kind !== "goal" ? job.kind : undefined],
    ["Workflow", workflowCell(job)],
    ...datasetRows(job),
    ["Synthesis of", job.synthesis ? `${job.synthesis.sourceJobId} (${job.synthesis.included.length}/${job.synthesis.expectedItems} items${job.synthesis.allowPartial ? ", partial allowed" : ""})` : undefined],
    ["Request count", job.requestCount],
    ["Items", multi ? itemSummary(job) : undefined],
    ["Completed count", multi ? undefined : job.completedCount],
    ["Failed count", multi ? undefined : job.failedCount],
    ["Context", `${job.context.fileCount} file(s), ${job.context.characters} characters, ${job.context.excludedCount} excluded`],
    ["Created", formatIsoShort(job.createdAt)],
    ["Submitted", job.submittedAt ? formatIsoShort(job.submittedAt) : undefined],
    ["Provider created", job.providerCreatedAt ? formatIsoShort(job.providerCreatedAt) : undefined],
    ["Finalised", job.finalizedAt ? formatIsoShort(job.finalizedAt) : undefined],
    ["Retrieved", job.retrievedAt ? formatIsoShort(job.retrievedAt) : undefined],
    ["Injected", job.injectedAt ? `${formatIsoShort(job.injectedAt)} (${job.injectionCount}x)` : undefined],
    ["Cancel requested", job.cancelRequestedAt ? formatIsoShort(job.cancelRequestedAt) : undefined],
    ["Input tokens", job.usage?.inputTokens],
    ["Output tokens", job.usage?.outputTokens],
    ["Charged cost", job.usage?.cost !== undefined ? `$${job.usage.cost.toFixed(6)}` : undefined],
    ["BYOK", job.usage?.isByok === undefined ? undefined : job.usage.isByok ? "yes" : "no"],
    ["Upstream cost (est.)", job.usage?.upstreamInferenceCost !== undefined ? `$${job.usage.upstreamInferenceCost.toFixed(6)}` : undefined],
    ["Polls", job.pollAttempts || undefined],
    ["Next poll", job.nextPollAt && ACTIVE_STATUSES.has(job.localStatus) ? formatIsoShort(job.nextPollAt) : undefined],
    [
      "Last poll error",
      job.lastPollError ? `${job.lastPollError.category}${job.lastPollError.httpStatus ? ` HTTP ${job.lastPollError.httpStatus}` : ""}: ${job.lastPollError.message} (${formatIsoShort(job.lastPollError.at)}, ${job.consecutivePollFailures} in a row)` : undefined,
    ],
    ["Error", job.error ? `[${job.error.code}] ${job.error.message}` : undefined],
    ["Request SHA-256", job.requestSha256],
    ["Artefacts", storageDir],
  ];
  const lines = rows.filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `  ${k.padEnd(20)} ${v}`);
  for (const w of job.warnings) lines.push(`  ${"Warning".padEnd(20)} ${w}`);
  return lines;
}

function remoteDeletionCell(job: JobManifest): string | undefined {
  const d = job.remoteDeletion;
  if (!d) return undefined;
  const at = d.at ? ` ${formatIsoShort(d.at)}` : "";
  const err = d.lastError ? `, last error: ${d.lastError}` : "";
  const next = d.state === "pending" && d.nextAttemptAt ? `, next attempt ${formatIsoShort(d.nextAttemptAt)}` : "";
  const cell = `${d.state}${at} (${d.attempts} attempt${d.attempts === 1 ? "" : "s"}${next}${err})`;
  if (d.state === "failed") return `${cell}; NEEDS ATTENTION: the batch is still at OpenRouter (kept up to 30 days); delete it there`;
  return d.state === "pending" && d.waitingForKey ? `${cell}; waiting for an API key for account "${job.account}" before it can be deleted` : cell;
}

/**
 * Where a batch job's data stays at OpenRouter, for a job not (yet) marked for deletion; undefined for an immediate
 * job or one marked for deletion (its "Remote deletion" row says what happened). A strict-level job that is still
 * running will be deleted when it ends; any other job is kept up to 30 days.
 */
export function retentionLine(job: JobManifest, deleteRemoteBatches: boolean): string | undefined {
  if ((job.route ?? "batch") !== "batch" || job.remoteDeletion) return undefined;
  const strict = job.privacy?.level === "no-training" || job.privacy?.level === "zdr";
  return strict && deleteRemoteBatches && !TERMINAL.has(job.localStatus) ? RETENTION_DELETED : RETENTION_KEPT;
}

function workflowCell(job: JobManifest): string | undefined {
  const w = job.workflow;
  if (!w) return undefined;
  if (isDatasetWorkflow(w)) return `${w.name} (project workflow v${w.version}, definition ${w.definitionSha256.slice(0, 12)}…)`;
  if (isMetadataWorkflow(w)) return `${w.name} (built-in; context ${w.context.path} sha256 ${w.context.sha256.slice(0, 12)}…, ${w.input.tables} table(s) from ${w.input.path})`;
  return `${w.name} v${w.version}${w.options.groupSize > 1 ? ` (groups of ${w.options.groupSize})` : ""}`;
}

/** Dataset provenance rows for Release 3 jobs; nothing for other jobs. */
function datasetRows(job: JobManifest): Array<[string, string | number | undefined]> {
  const w = job.workflow;
  if (!isDatasetWorkflow(w)) return [];
  const d = w.dataset;
  const sel = w.selection.ids?.length
    ? `ids ${w.selection.ids.slice(0, 5).join(", ")}${w.selection.ids.length > 5 ? ", …" : ""}`
    : w.selection.fromRow !== undefined || w.selection.toRow !== undefined
      ? `rows ${w.selection.fromRow ?? 1}-${w.selection.toRow ?? d.totalRows}`
      : "all rows";
  const last = job.exports?.[job.exports.length - 1];
  return [
    ["Dataset", `${d.type} ${d.path} (sha256 ${d.sha256.slice(0, 12)}…)`],
    ["Rows", `${job.parentJobId ? "original run: " : ""}${d.totalRows} total · ${d.selectedRows} selected (${sel}) · ${d.excludedRows} excluded · ${d.invalidRows} invalid`],
    ["Fields sent", `${d.fields.join(", ")} (ID field: ${d.idField})`],
    ["Output", w.output === "json" ? "json (validated against the stored JSON Schema)" : "markdown"],
    ["Synthesis", w.synthesisEnabled ? "enabled by workflow" : "disabled by workflow"],
    ["Exports", job.exports?.length ? `${job.exports.length} (latest: ${last!.format} ${last!.path}, ${last!.records} records)` : "none"],
  ];
}

function itemSummary(job: JobManifest): string {
  const items = job.items ?? [];
  const n = (s: string) => items.filter((i) => i.status === s).length;
  return `${items.length}: completed ${n("completed")}, failed ${n("failed")}, corrupt ${n("corrupt")}, missing ${n("missing")}`;
}

/** "2/3" usable items for multi-request jobs, blank otherwise. */
export function itemsCell(job: JobManifest): string {
  if (!job.items || job.items.length <= 1) return "";
  return `${job.items.filter((i) => i.status === "completed").length}/${job.items.length}`;
}

export function statusColor(status: LocalStatus): string {
  switch (status) {
    case "ready":
      return "\x1b[32m";
    case "partial":
    case "corrupt":
    case "cancel_requested":
      return "\x1b[35m";
    case "failed":
    case "expired":
      return "\x1b[31m";
    case "cancelled":
    case "previewed":
    case "draft":
      return "\x1b[90m";
    default:
      return "\x1b[33m";
  }
}

/** Read-only scrollable text viewer (for /batch read, show). */
export class TextViewerComponent implements Component {
  private offset = 0;
  private lastHeight = 20;

  constructor(
    private readonly title: string,
    private readonly text: string,
    private readonly onClose: () => void,
    private readonly viewportRows: () => number,
  ) {}

  public invalidate(): void {}

  public handleInput(data: string): void {
    if (matchesKey(data, "escape") || data === "q" || data === "Q" || matchesKey(data, "enter")) return this.onClose();
    if (matchesKey(data, "down") || data === "j") this.offset++;
    else if (matchesKey(data, "up") || data === "k") this.offset--;
    else if (matchesKey(data, "pageDown") || data === " ") this.offset += this.lastHeight;
    else if (matchesKey(data, "pageUp") || data === "b") this.offset -= this.lastHeight;
    else if (data === "g") this.offset = 0;
    else if (data === "G") this.offset = Number.MAX_SAFE_INTEGER;
    if (this.offset < 0) this.offset = 0;
  }

  public render(width: number): string[] {
    const w = Math.max(20, width);
    const body = this.text.split("\n").flatMap((l) => (l === "" ? [""] : wrapTextWithAnsi(l, w)));
    const height = Math.max(5, this.viewportRows() - 4);
    this.lastHeight = height;
    this.offset = Math.min(this.offset, Math.max(0, body.length - height));
    const end = Math.min(body.length, this.offset + height);
    return [
      truncateToWidth(`\x1b[1;36m${this.title}\x1b[0m`, w),
      "─".repeat(w),
      ...body.slice(this.offset, end).map((l) => truncateToWidth(l, w)),
      "─".repeat(w),
      `\x1b[90mLines ${body.length === 0 ? 0 : this.offset + 1}-${end} of ${body.length}  [↑/↓ j/k] Scroll  [PgUp/PgDn] Page  [g/G] Top/Bottom  [q/Esc] Close\x1b[0m`,
    ];
  }
}
