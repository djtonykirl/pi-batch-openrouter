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
  if (s.kind === "goal") return s.label ?? (s.paths?.length ? `goal (${s.paths.length} file(s))` : "goal");
  return s.label ?? s.kind;
}

/** Resolves an ordinal ("2"), exact custom_id, or unambiguous source path. */
export function resolveItem(items: readonly JobItem[], selector: string): JobItem {
  const sel = selector.trim();
  if (/^\d+$/.test(sel)) {
    const n = Number.parseInt(sel, 10);
    const hit = items.find((i) => i.ordinal === n);
    if (!hit) throw new Error(`No item ${n}; this job has items 1-${items.length}.`);
    return hit;
  }
  const byId = items.find((i) => i.customId === sel);
  if (byId) return byId;
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
  throw new Error(`No item matches "${selector}". Use an item number (see /batch items), a custom_id, or a source path.`);
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
