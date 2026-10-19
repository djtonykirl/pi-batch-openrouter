import { fromUnixMilliseconds, fromUnixSeconds } from "./time.js";

/**
 * Read-only inventory of a pre-Release-1 `jobs.json` (`/batch import-legacy <path> --preview`).
 *
 * The legacy extension kept ONE global JSON array of jobs:
 *   { id, title, model, provider, status, createdAt, finalizedAt?, totalRequests,
 *     completedRequests, failedRequests, costUsd?, outputDir?, resultsSaved, items[] }
 * where `createdAt` was written with Date.now() (milliseconds) and `finalizedAt`
 * with OpenRouter's `finalized_at` (seconds): two units in one record.
 *
 * Timestamps are resolved per value, never by field name alone: a number in the
 * plausible Unix-seconds range (2000..2100) is seconds, one in the plausible
 * milliseconds range is milliseconds; the ranges do not overlap. Anything else
 * (null, strings, NaN, out-of-range values) stays unresolved — never guessed.
 *
 * Nothing here writes, and nothing calls the network. Every record would be a
 * `legacy-unresolved` historical record: the legacy file holds no raw provider
 * response, no submitted request bytes and no project/workspace, so none of it
 * is evidence enough to become a ready Release 3 job.
 */

export type LegacyTimestamp =
  | { state: "resolved"; iso: string; unit: "seconds" | "milliseconds" }
  | { state: "missing" }
  | { state: "unresolved"; reason: "not_a_number" | "implausible" };

export function resolveLegacyTimestamp(value: unknown): LegacyTimestamp {
  if (value === null || value === undefined) return { state: "missing" };
  if (typeof value !== "number" || !Number.isFinite(value)) return { state: "unresolved", reason: "not_a_number" };
  const s = fromUnixSeconds(value);
  if (s.ok) return { state: "resolved", iso: s.iso, unit: "seconds" };
  const ms = fromUnixMilliseconds(value);
  if (ms.ok) return { state: "resolved", iso: ms.iso, unit: "milliseconds" };
  return { state: "unresolved", reason: "implausible" };
}

const LEGACY_STATUSES = new Set(["validating", "in_progress", "finalizing", "completed", "failed", "expired", "cancelled"]);

export interface LegacyRecordReport {
  index: number;
  providerBatchId?: string;
  legacyStatus?: string;
  createdAt: LegacyTimestamp;
  finalizedAt: LegacyTimestamp;
  items: number;
  itemsWithResponse: number;
  problems: string[];
  /** Set when a job with this provider batch ID already exists locally. */
  alreadyKnownAs?: string;
  duplicateOf?: number;
  /** What an import would record: always historical, never ready. */
  provenance: "legacy-unresolved";
}

export interface LegacyInventory {
  records: LegacyRecordReport[];
  fatal: string[];
  counts: { records: number; withProblems: number; duplicates: number; alreadyKnown: number; timestampsUnresolved: number };
}

export function inventoryLegacyJobs(text: string, knownProviderIds: ReadonlyMap<string, string>): LegacyInventory {
  const out: LegacyInventory = { records: [], fatal: [], counts: { records: 0, withProblems: 0, duplicates: 0, alreadyKnown: 0, timestampsUnresolved: 0 } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    out.fatal.push("the file is not valid JSON");
    return out;
  }
  if (!Array.isArray(parsed)) {
    out.fatal.push("expected a JSON array of legacy jobs");
    return out;
  }
  const firstById = new Map<string, number>();
  parsed.forEach((raw, i) => {
    const index = i + 1;
    const problems: string[] = [];
    const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
    if (!r) problems.push("record is not an object");
    const id = typeof r?.id === "string" && r.id.trim() && r.id.length <= 200 && !/[\u0000-\u001f]/.test(r.id) ? r.id : undefined;
    if (r && !id) problems.push("missing or invalid provider batch id");
    const legacyStatus = typeof r?.status === "string" ? r.status : undefined;
    if (r && (!legacyStatus || !LEGACY_STATUSES.has(legacyStatus))) problems.push("missing or unknown status");
    const items = Array.isArray(r?.items) ? (r!.items as unknown[]) : [];
    if (r && !Array.isArray(r.items)) problems.push("items is not an array");
    const itemsWithResponse = items.filter((it) => it && typeof it === "object" && typeof (it as { response?: unknown }).response === "string").length;
    const createdAt = resolveLegacyTimestamp(r?.createdAt);
    const finalizedAt = resolveLegacyTimestamp(r?.finalizedAt);
    if (createdAt.state === "resolved" && finalizedAt.state === "resolved" && finalizedAt.iso < createdAt.iso) problems.push("finalizedAt is earlier than createdAt");
    const report: LegacyRecordReport = { index, ...(id ? { providerBatchId: id } : {}), ...(legacyStatus ? { legacyStatus } : {}), createdAt, finalizedAt, items: items.length, itemsWithResponse, problems, provenance: "legacy-unresolved" };
    if (id) {
      const prev = firstById.get(id);
      if (prev !== undefined) report.duplicateOf = prev;
      else firstById.set(id, index);
      const known = knownProviderIds.get(id);
      if (known) report.alreadyKnownAs = known;
    }
    out.records.push(report);
  });
  const unresolved = (t: LegacyTimestamp) => t.state === "unresolved";
  out.counts = {
    records: out.records.length,
    withProblems: out.records.filter((r) => r.problems.length > 0).length,
    duplicates: out.records.filter((r) => r.duplicateOf !== undefined).length,
    alreadyKnown: out.records.filter((r) => r.alreadyKnownAs).length,
    timestampsUnresolved: out.records.filter((r) => unresolved(r.createdAt) || unresolved(r.finalizedAt)).length,
  };
  return out;
}

function ts(t: LegacyTimestamp): string {
  if (t.state === "resolved") return `${t.iso.slice(0, 19)}Z (${t.unit})`;
  if (t.state === "missing") return "-";
  return `UNRESOLVED (${t.reason === "implausible" ? "implausible value" : "not a number"})`;
}

/** Report text: no titles, prompts, responses, output directories or other free text from the file. */
export function formatLegacyInventory(inv: LegacyInventory): string {
  if (inv.fatal.length > 0) return `Legacy jobs file cannot be read:\n- ${inv.fatal.join("\n- ")}`;
  const c = inv.counts;
  const lines = [
    "Legacy jobs inventory (preview only; nothing was imported, written or sent)",
    "",
    `Records:               ${c.records}`,
    `With problems:         ${c.withProblems}`,
    `Duplicate batch IDs:   ${c.duplicates}`,
    `Already in this project: ${c.alreadyKnown}`,
    `Unresolved timestamps: ${c.timestampsUnresolved} record(s)`,
    `Provenance if imported: legacy-unresolved (historical only; no raw provider evidence, never ready)`,
    "",
    "  #   PROVIDER BATCH          STATUS       CREATED                              FINALISED                            ITEMS  NOTES",
  ];
  for (const r of inv.records) {
    const notes = [...r.problems, ...(r.duplicateOf ? [`duplicate of #${r.duplicateOf}`] : []), ...(r.alreadyKnownAs ? [`already known as ${r.alreadyKnownAs}`] : [])];
    lines.push(
      `  ${String(r.index).padEnd(3)} ${(r.providerBatchId ?? "?").slice(0, 22).padEnd(23)} ${(r.legacyStatus ?? "?").padEnd(12)} ${ts(r.createdAt).padEnd(36)} ${ts(r.finalizedAt).padEnd(36)} ${`${r.itemsWithResponse}/${r.items}`.padEnd(6)} ${notes.join("; ")}`,
    );
  }
  return lines.join("\n");
}
