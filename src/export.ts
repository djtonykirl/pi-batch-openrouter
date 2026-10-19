import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteFile } from "./fsutil.js";
import { combinedCoverage, itemText, jobItems, sourceLabel } from "./items.js";
import type { JobRegistry } from "./registry.js";
import { isDatasetWorkflow, type JobItem, type JobManifest } from "./types.js";

/**
 * Result export (`/batch export`, explicit user command only).
 *
 * One record per item of the exported job, in item order. By default results
 * from linked retry jobs are used where the original item has no usable result
 * (combined coverage); `result_job_id`/`result_custom_id` say where each result
 * came from. Only results from trusted (ready/partial) batches are exported;
 * items of a corrupt batch are exported as "untrusted" without result text.
 *
 * Values the provider did not report (usage, cost) stay null (JSONL) or empty
 * (CSV); nothing is estimated. JSON results are exported as the parsed object
 * (JSONL) or one compact JSON string in a single `result` column (CSV), never
 * flattened into columns.
 *
 * CSV cells that begin with = + - @ or a tab/CR are prefixed with ' so that
 * spreadsheet applications do not evaluate model output as a formula. JSONL is
 * the exact representation.
 */

export const EXPORT_COLUMNS = [
  "job_id",
  "workflow",
  "workflow_sha256",
  "dataset_path",
  "dataset_sha256",
  "ordinal",
  "source_id",
  "source_row",
  "source_line",
  "custom_id",
  "result_job_id",
  "result_custom_id",
  "status",
  "result",
  "validation_errors",
  "finish_reason",
  "input_tokens",
  "output_tokens",
  "cost",
  "error_code",
  "error_message",
] as const;

export type ExportRow = Record<(typeof EXPORT_COLUMNS)[number], unknown>;

function trustedJob(j: JobManifest): boolean {
  return j.localStatus === "ready" || j.localStatus === "partial";
}

function resultValue(registry: JobRegistry, job: JobManifest, item: JobItem): unknown {
  const out = registry.itemArtefact(job.localId, item.ordinal, "output");
  if (job.format === "json" && fs.existsSync(out)) return JSON.parse(fs.readFileSync(out, "utf8"));
  return itemText(registry, job, item)?.trimEnd() ?? null;
}

export function buildExportRows(registry: JobRegistry, job: JobManifest, opts: { combined: boolean }): ExportRow[] {
  const w = job.workflow;
  const ds = isDatasetWorkflow(w) ? w : undefined;
  const common = {
    job_id: job.localId,
    workflow: w?.name ?? null,
    workflow_sha256: ds?.definitionSha256 ?? null,
    dataset_path: ds?.dataset.path ?? null,
    dataset_sha256: ds?.dataset.sha256 ?? null,
  };
  const jobs = new Map<string, JobManifest>([[job.localId, job]]);
  const jobOf = (id: string) => {
    if (!jobs.has(id)) jobs.set(id, registry.read(id));
    return jobs.get(id)!;
  };
  const entries = opts.combined
    ? combinedCoverage(registry, job.localId).entries
    : jobItems(registry, job).map((it) => ({ root: it, attempts: [{ jobId: job.localId, item: it, jobStatus: job.localStatus }], usable: isUsableHere(job, it) ? { jobId: job.localId, item: it } : undefined }));

  return entries.map((e) => {
    const root = e.root;
    const src = root.source;
    const chosen = e.usable ?? e.attempts[e.attempts.length - 1]!;
    const from = jobOf(chosen.jobId);
    const it = chosen.item;
    const usable = !!e.usable;
    const untrusted = !usable && it.status === "completed" && !trustedJob(from);
    return {
      ...common,
      ordinal: root.ordinal,
      source_id: src.kind === "row" ? (src.sourceId ?? null) : sourceLabel(root),
      source_row: src.row ?? null,
      source_line: src.line ?? null,
      custom_id: root.customId,
      result_job_id: chosen.jobId,
      result_custom_id: it.customId,
      status: untrusted ? "untrusted" : it.status,
      result: usable ? resultValue(registry, from, it) : null,
      // Output-validation errors only (provider failures are in error_code/error_message).
      validation_errors: !usable && it.status === "corrupt" && it.validation ? it.validation.errors : [],
      finish_reason: it.finishReason ?? null,
      input_tokens: it.usage?.inputTokens ?? null,
      output_tokens: it.usage?.outputTokens ?? null,
      cost: it.usage?.cost ?? null,
      error_code: untrusted ? "batch_untrusted" : (it.error?.code ?? null),
      error_message: untrusted ? "the batch response could not be correlated safely; its results are not exported" : (it.error?.message ?? null),
    };
  });
}

function isUsableHere(job: JobManifest, it: JobItem): boolean {
  return it.status === "completed" && trustedJob(job);
}

export function toJsonl(rows: readonly ExportRow[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
}

const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: unknown): string {
  let s: string;
  if (value === null || value === undefined) s = "";
  else if (Array.isArray(value)) s = value.join("; ");
  else if (typeof value === "object") s = JSON.stringify(value);
  else s = String(value);
  if (typeof value === "string" || (typeof value === "object" && value !== null)) {
    if (FORMULA_START.test(s)) s = `'${s}`;
  }
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: readonly ExportRow[]): string {
  const lines = [EXPORT_COLUMNS.join(",")];
  for (const r of rows) lines.push(EXPORT_COLUMNS.map((c) => csvCell(r[c])).join(","));
  return lines.join("\r\n") + "\r\n";
}

/**
 * Atomic write. Without `overwrite` the destination is created exclusively: the
 * complete temp file is hard-linked into place (fails if anything exists there),
 * so an existing file is never replaced and a crash never leaves a partial file.
 */
export function writeExport(absPath: string, data: string, overwrite: boolean): void {
  if (overwrite) {
    atomicWriteFile(absPath, data);
    return;
  }
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const tmp = `${absPath}.tmp.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
  const fd = fs.openSync(tmp, "wx");
  try {
    fs.writeSync(fd, Buffer.from(data, "utf8"));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    try {
      fs.linkSync(tmp, absPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") throw new Error(`${absPath} already exists; nothing was overwritten (use --overwrite to replace it, or --out <path>)`);
      // File systems without hard links: exclusive copy (still never overwrites).
      fs.copyFileSync(tmp, absPath, fs.constants.COPYFILE_EXCL);
    }
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // best-effort temp cleanup
    }
  }
}
