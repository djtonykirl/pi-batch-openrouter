import { itemCounts } from "./service.js";
import { ACTIVE_STATUSES } from "./state.js";
import type { JobManifest } from "./types.js";

/**
 * Plain-English descriptions of batch jobs, used as the first line(s) of tool results so chat agents can relay
 * them to the user conversationally. Structured data stays in `details` / `structuredContent`.
 */

const LABEL_MAX = 60;

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}

/** Derives a short, stable, human-readable label from a job's objective (used when the job has no explicit name). */
export function deriveLabel(job: Pick<JobManifest, "objective" | "requestCount" | "kind" | "parentJobId" | "retryMode">): string {
  const objective = collapse(job.objective || "untitled batch job");
  const firstSentence = objective.split(/(?<=[.!?])\s|\n/)[0] ?? objective;
  let label = clip(firstSentence.replace(/[.!?]+$/, ""), LABEL_MAX);
  if (job.parentJobId && job.kind !== "synthesis" && job.retryMode) label = `Retry: ${label}`;
  return label;
}

/** The job's user-given name, or a label derived from its objective. */
export function jobLabel(job: JobManifest): string {
  const named = typeof job.name === "string" ? collapse(job.name) : "";
  return named || deriveLabel(job);
}

/** "just now", "5 minutes ago", "3 hours ago", "yesterday", "4 days ago", or a short date. */
export function relativeTime(iso: string | undefined, now: Date = new Date()): string {
  if (!iso) return "at an unknown time";
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "at an unknown time";
  const sec = Math.round((now.getTime() - then.getTime()) / 1000);
  if (sec < 0) return "just now";
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const hrs = Math.round(min / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.round(hrs / 24);
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  return `on ${then.toISOString().slice(0, 10)}`;
}

/** Number of items with a usable (completed) result. */
export function usableItems(job: JobManifest): number {
  if (job.items?.length) return itemCounts(job.items.map((i) => i.status)).completed;
  return job.localStatus === "ready" ? job.requestCount : 0;
}

/** What state the job is in, in plain words. */
export function statusPhrase(job: JobManifest): string {
  const n = job.requestCount;
  switch (job.localStatus) {
    case "draft":
    case "previewed":
      return "planned but not submitted yet (nothing billed)";
    case "submitting":
      return "being submitted to OpenRouter";
    case "submitted":
    case "polling":
      return "waiting at OpenRouter";
    case "provider_completed":
    case "retrieving":
      return "finished at OpenRouter; downloading results";
    case "ready":
      return n > 1 ? `finished, all ${n} results ready` : "finished, result ready";
    case "partial":
      return `finished with gaps (${usableItems(job)} of ${n} results usable)`;
    case "failed":
      return job.error?.message ? `failed (${clip(collapse(job.error.message), 120)})` : "failed";
    case "cancel_requested":
      return "cancellation requested";
    case "cancelled":
      return "cancelled";
    case "expired":
      return "expired before OpenRouter finished it";
    case "corrupt":
      return "finished, but the results could not be verified";
    default:
      return job.localStatus;
  }
}

function whenPhrase(job: JobManifest, now: Date): string {
  switch (job.localStatus) {
    case "draft":
    case "previewed":
      return `planned ${relativeTime(job.createdAt, now)}`;
    case "ready":
    case "partial":
    case "corrupt":
      return `finished ${relativeTime(job.retrievedAt ?? job.finalizedAt ?? job.submittedAt ?? job.createdAt, now)}`;
    case "failed":
    case "cancelled":
    case "expired":
      return `started ${relativeTime(job.submittedAt ?? job.createdAt, now)}`;
    default:
      return `submitted ${relativeTime(job.submittedAt ?? job.createdAt, now)}`;
  }
}

/** One sentence describing a job, e.g. `"Audit token verification" (B-20261031-A7C2) is finished, result ready (finished 2 hours ago).` */
export function describeJob(job: JobManifest, now: Date = new Date()): string {
  return `"${jobLabel(job)}" (${job.localId}) is ${statusPhrase(job)} (${whenPhrase(job, now)}).`;
}

/** Short bullet used in job lists. */
export function jobBullet(job: JobManifest, now: Date = new Date()): string {
  return `- "${jobLabel(job)}" (${job.localId}): ${statusPhrase(job)}, ${whenPhrase(job, now)}`;
}

/** One sentence summarising a set of jobs, e.g. "You have 4 batch jobs: 1 waiting at OpenRouter, 2 finished with results ready, 1 plan not yet submitted." */
export function inventorySentence(jobs: readonly JobManifest[], scope = "batch job"): string {
  if (jobs.length === 0) return `You have no ${scope}s in this workspace yet.`;
  const count = (pred: (j: JobManifest) => boolean) => jobs.filter(pred).length;
  const parts: string[] = [];
  const active = count((j) => ACTIVE_STATUSES.has(j.localStatus));
  const ready = count((j) => j.localStatus === "ready");
  const partial = count((j) => j.localStatus === "partial");
  const planned = count((j) => j.localStatus === "previewed" || j.localStatus === "draft");
  const failed = count((j) => j.localStatus === "failed" || j.localStatus === "expired" || j.localStatus === "corrupt");
  const cancelled = count((j) => j.localStatus === "cancelled");
  if (active) parts.push(`${active} still running`);
  if (ready) parts.push(`${ready} finished with results ready`);
  if (partial) parts.push(`${partial} finished with some gaps`);
  if (planned) parts.push(`${planned} plan${planned === 1 ? "" : "s"} not yet submitted`);
  if (failed) parts.push(`${failed} failed`);
  if (cancelled) parts.push(`${cancelled} cancelled`);
  return `You have ${jobs.length} ${scope}${jobs.length === 1 ? "" : "s"}${parts.length ? `: ${parts.join(", ")}` : ""}.`;
}
