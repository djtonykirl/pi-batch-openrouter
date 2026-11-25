import { parseArgs } from "./args.js";
import { parseOlderThan, type CleanupPlan, type CleanupResult, type CleanupService, type CleanupTarget } from "./cleanup.js";

export const DELETE_USAGE = "Usage: /batch delete <job-or-chat> [<more>...] [--remote] [--yes]";
export const CLEAN_USAGE = "Usage: /batch clean [--older-than 7d|12h|0] [--chats | --jobs] [--remote] [--yes]";

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** The list the user confirms: one line per item, what is skipped and why, and the totals. */
export function formatPlan(plan: CleanupPlan): string {
  const lines: string[] = [];
  for (const i of plan.items) {
    const via = i.viaClosure ? ` (with ${i.viaClosure})` : "";
    lines.push(`  ${i.kind === "thread" ? "chat" : "job "}  ${i.id}  ${i.label}  [${i.status}, ${i.ageDays}d old, ${formatBytes(i.bytes)}]${via}`);
  }
  if (plan.skipped.length) {
    lines.push("", "Not deleted:");
    for (const s of plan.skipped) lines.push(`  ${s.kind === "thread" ? "chat" : "job "}  ${s.id}  ${s.reason}`);
  }
  lines.push("", `${plan.items.length} to delete (${formatBytes(plan.totalBytes)}), ${plan.skipped.length} skipped${plan.remote ? "; the OpenRouter copy is deleted too (best effort)" : ""}.`);
  return lines.join("\n");
}

export function formatResult(r: CleanupResult): string {
  const lines: string[] = [];
  for (const s of r.skipped) lines.push(`Not deleted: ${s.id}: ${s.reason}`);
  for (const x of r.remote.filter((y) => !y.ok)) lines.push(`OpenRouter copy of ${x.id} was not deleted: ${x.error ?? "unknown error"}`);
  lines.push(`${r.deleted.length} deleted, ${r.skipped.length} skipped, ${formatBytes(r.freedBytes)} freed.`);
  return lines.join("\n");
}

export interface CleanupCommandDeps {
  cleanup: CleanupService;
  /** Asks the user once; resolves true to proceed. */
  confirm(title: string, body: string): Promise<boolean>;
}

async function planConfirmApply(deps: CleanupCommandDeps, target: CleanupTarget, yes: boolean, remote: boolean): Promise<{ text: string }> {
  const plan = deps.cleanup.plan(target, { remote });
  if (plan.items.length === 0) {
    return { text: plan.skipped.length ? `Nothing to delete.\n\n${formatPlan(plan)}` : "Nothing to delete." };
  }
  const shown = formatPlan(plan);
  if (!yes && !(await deps.confirm(`Delete ${plan.items.length} item(s)?`, shown))) return { text: `${shown}\n\nNothing was deleted.` };
  return { text: formatResult(await deps.cleanup.apply(plan.planId)) };
}

export async function runDelete(deps: CleanupCommandDeps, args: string[]): Promise<{ text: string }> {
  const parsed = parseArgs(args, { booleans: ["yes", "remote"] });
  if (parsed.errors.length) throw new Error(`/batch delete: ${parsed.errors.join("; ")}\n${DELETE_USAGE}`);
  if (parsed.positionals.length === 0) throw new Error(DELETE_USAGE);
  return planConfirmApply(deps, { refs: parsed.positionals }, parsed.booleans.has("yes"), parsed.booleans.has("remote"));
}

export async function runClean(deps: CleanupCommandDeps, args: string[]): Promise<{ text: string }> {
  const parsed = parseArgs(args, { values: ["older-than"], booleans: ["yes", "remote", "chats", "jobs"] });
  if (parsed.errors.length) throw new Error(`/batch clean: ${parsed.errors.join("; ")}\n${CLEAN_USAGE}`);
  if (parsed.positionals.length) throw new Error(`/batch clean takes no ids (got "${parsed.positionals[0]}"); use /batch delete for specific items.\n${CLEAN_USAGE}`);
  if (parsed.booleans.has("chats") && parsed.booleans.has("jobs")) throw new Error(`Use either --chats or --jobs, not both.\n${CLEAN_USAGE}`);
  const olderThanMs = parseOlderThan(parsed.values["older-than"] ?? "7d");
  const include = parsed.booleans.has("chats") ? "chats" : parsed.booleans.has("jobs") ? "jobs" : "all";
  return planConfirmApply(deps, { olderThanMs, include }, parsed.booleans.has("yes"), parsed.booleans.has("remote"));
}
