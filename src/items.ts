import * as fs from "node:fs";
import type { NormalisedBatchResult } from "./openrouter/normalise-result.js";
import type { JobRegistry } from "./registry.js";
import type { ItemStatus, JobItem, JobManifest } from "./types.js";

/**
 * Item-level views over durable state. Release 1 manifests (schemaVersion 1)
 * carry no `items`; they are presented as one-item jobs derived from their
 * stored `customIds` and `result/result.json` — never by regenerating IDs and
 * never by rewriting the manifest.
 */
export function jobItems(registry: JobRegistry, job: JobManifest): JobItem[] {
  if (job.items && job.items.length > 0) return job.items;
  let normalised: NormalisedBatchResult | undefined;
  try {
    const p = registry.artefact(job.localId, "resultJson");
    if (fs.existsSync(p)) normalised = JSON.parse(fs.readFileSync(p, "utf8")) as NormalisedBatchResult;
  } catch {
    normalised = undefined;
  }
  const notYet: ItemStatus = job.localStatus === "draft" || job.localStatus === "previewed" ? "planned" : "submitted";
  return job.customIds.map((customId, i) => {
    const n = normalised?.items?.find((it) => it.customId === customId);
    const status: ItemStatus = n ? (n.status as ItemStatus) : notYet;
    return {
      customId,
      ordinal: i + 1,
      source: { kind: "goal", label: "goal (Release 1 job)" },
      status,
      ...(n?.error ? { error: n.error } : {}),
      ...(n?.finishReason ? { finishReason: n.finishReason } : {}),
    };
  });
}

export function isUsable(item: JobItem): boolean {
  return item.status === "completed";
}

export function sourceLabel(item: Pick<JobItem, "source">): string {
  const s = item.source;
  if (s.kind === "file") return s.path ?? "?";
  if (s.kind === "group") return (s.paths ?? []).join(", ");
  if (s.kind === "row") return `${s.sourceId ?? "?"}${s.row !== undefined ? ` (row ${s.row})` : s.line !== undefined ? ` (line ${s.line})` : ""}`;
  if (s.kind === "goal") return s.label ?? (s.paths?.length ? `goal (${s.paths.length} file(s))` : "goal");
  return s.label ?? s.kind;
}

/**
 * Resolves an ordinal ("2"), exact custom_id, dataset source ID, or unambiguous
 * source path. All-digit selectors are ordinals; `id:<value>` always means a
 * dataset source ID (use it for numeric source IDs).
 */
export function resolveItem(items: readonly JobItem[], selector: string): JobItem {
  const sel = selector.trim();
  if (sel.startsWith("id:")) {
    const wanted = sel.slice(3);
    const hit = items.find((i) => i.source.kind === "row" && i.source.sourceId === wanted);
    if (!hit) throw new Error(`No item has source ID ${JSON.stringify(wanted)}.`);
    return hit;
  }
  if (/^\d+$/.test(sel)) {
    const n = Number.parseInt(sel, 10);
    const hit = items.find((i) => i.ordinal === n);
    if (!hit) throw new Error(`No item ${n}; this job has items 1-${items.length}.`);
    return hit;
  }
  const byId = items.find((i) => i.customId === sel);
  if (byId) return byId;
  const bySource = items.find((i) => i.source.kind === "row" && i.source.sourceId === sel);
  if (bySource) return bySource;
  const norm = (p: string) => {
    const posix = p.replace(/\\/g, "/").replace(/^\.\//, "");
    return process.platform === "win32" ? posix.toLowerCase() : posix;
  };
  const wanted = norm(sel);
  const matches = items.filter((i) => {
    const paths = i.source.path ? [i.source.path] : (i.source.paths ?? []);
    return paths.some((p) => norm(p) === wanted);
  });
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new Error(`"${selector}" is ambiguous; it matches items ${matches.map((m) => m.ordinal).join(", ")}. Use the item number or custom_id.`);
  }
  throw new Error(`No item matches "${selector}". Use an item number (see /batch items), a custom_id, a source ID (id:<value>), or a source path.`);
}

/** Stored result text for an item, if any (Release 1 single-item jobs fall back to result/result.md). */
export function itemText(registry: JobRegistry, job: JobManifest, item: JobItem): string | undefined {
  if (item.status !== "completed") return undefined;
  const perItem = registry.itemArtefact(job.localId, item.ordinal, "resultMd");
  if (fs.existsSync(perItem)) return fs.readFileSync(perItem, "utf8");
  if (!job.items && job.customIds.length === 1) {
    const legacy = registry.artefact(job.localId, "resultMd");
    if (fs.existsSync(legacy)) return fs.readFileSync(legacy, "utf8");
  }
  return undefined;
}

export interface CoverageEntry {
  /** The item in the root job. */
  root: JobItem;
  /** Where the best result comes from (root job, or a linked retry job), if any item is usable. */
  usable?: { jobId: string; item: JobItem };
  /** Every attempt for this root item, oldest first (root first). */
  attempts: Array<{ jobId: string; item: JobItem; jobStatus: JobManifest["localStatus"] }>;
}

export interface Coverage {
  rootJobId: string;
  entries: CoverageEntry[];
  usableCount: number;
  complete: boolean;
  /** Linked retry jobs that contributed attempts. */
  retryJobIds: string[];
}

/**
 * Combined coverage of a job and its linked retry jobs, without rewriting
 * history: the root job's own status never changes; this view reports, per
 * root item, the newest usable attempt and its provenance.
 */
export function combinedCoverage(registry: JobRegistry, rootId: string, all: JobManifest[] = registry.list().jobs): Coverage {
  const root = registry.read(rootId);
  const rootItems = jobItems(registry, root);
  const byJob = new Map(all.map((j) => [j.localId, j]));

  // (jobId, customId) of an attempt -> root ordinal; follow replaces links transitively.
  const owner = new Map<string, number>();
  for (const it of rootItems) owner.set(`${root.localId} ${it.customId}`, it.ordinal);
  const attempts = new Map<number, CoverageEntry["attempts"]>(rootItems.map((it) => [it.ordinal, [{ jobId: root.localId, item: it, jobStatus: root.localStatus }]]));
  const retryJobIds: string[] = [];

  const candidates = all.filter((j) => j.localId !== root.localId && j.parentJobId).sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  let progressed = true;
  const done = new Set<string>();
  while (progressed) {
    progressed = false;
    for (const job of candidates) {
      if (done.has(job.localId)) continue;
      const parent = byJob.get(job.parentJobId!);
      if (!parent || (parent.localId !== root.localId && !done.has(parent.localId))) continue;
      done.add(job.localId);
      progressed = true;
      const items = jobItems(registry, job);
      const parentItems = jobItems(registry, parent);
      let contributed = false;
      for (const it of items) {
        // Release 2 items name their parent item; Release 1 full retries map by ordinal.
        const parentCustomId = it.replaces ? (it.replaces.jobId === parent.localId ? it.replaces.customId : undefined) : parentItems.find((p) => p.ordinal === it.ordinal)?.customId;
        if (!parentCustomId) continue;
        const rootOrdinal = owner.get(`${parent.localId} ${parentCustomId}`);
        if (rootOrdinal === undefined) continue;
        owner.set(`${job.localId} ${it.customId}`, rootOrdinal);
        attempts.get(rootOrdinal)!.push({ jobId: job.localId, item: it, jobStatus: job.localStatus });
        contributed = true;
      }
      if (contributed) retryJobIds.push(job.localId);
    }
  }

  const entries: CoverageEntry[] = rootItems.map((it) => {
    const list = attempts.get(it.ordinal)!;
    // Only results from a batch whose correlation was trusted count.
    const usable = [...list].reverse().find((a) => isUsable(a.item) && (a.jobStatus === "ready" || a.jobStatus === "partial"));
    return { root: it, attempts: list, ...(usable ? { usable: { jobId: usable.jobId, item: usable.item } } : {}) };
  });
  const usableCount = entries.filter((e) => e.usable).length;
  return { rootJobId: root.localId, entries, usableCount, complete: usableCount === entries.length, retryJobIds };
}
