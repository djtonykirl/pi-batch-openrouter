import { JobNotFoundError, type JobRegistry } from "./registry.js";
import { ACTIVE_STATUSES, type LocalStatus } from "./state.js";
import { isChatJob, type JobManifest } from "./types.js";
import { jobLabel, relativeTime, statusPhrase } from "./humanize.js";

/**
 * Resolves natural-language job references ("latest", "the finished security audit", "yesterday's review",
 * a user-given name, or a plain ID/suffix) to a local job ID.
 *
 * The resolver is deliberately conservative: when a reference is ambiguous for a cost-bearing or destructive
 * purpose (`submit`, `cancel`) it refuses and lists the candidates instead of guessing.
 */

/** What the caller is about to do with the job; used to prefer (and, for submit/cancel, require) suitable jobs. */
export type JobPurpose = "any" | "result" | "submit" | "cancel" | "multi-item";

export interface JobRefResolution {
  id: string;
  job: JobManifest;
  /** How the reference was matched. */
  matchedBy: "id" | "name" | "description" | "recency";
  /** Plain-English note to show the user when the match involved a judgement call. */
  note?: string;
}

export interface ResolveJobRefOptions {
  purpose?: JobPurpose;
  now?: Date;
}

const FINISHED: ReadonlySet<LocalStatus> = new Set<LocalStatus>(["ready", "partial"]);
const FAILED: ReadonlySet<LocalStatus> = new Set<LocalStatus>(["failed", "expired", "corrupt"]);
const PLANNED: ReadonlySet<LocalStatus> = new Set<LocalStatus>(["previewed", "draft"]);

const PURPOSE_FILTER: Record<JobPurpose, (j: JobManifest) => boolean> = {
  any: () => true,
  result: (j) => FINISHED.has(j.localStatus),
  submit: (j) => j.localStatus === "previewed",
  cancel: (j) => j.localStatus === "previewed" || ACTIVE_STATUSES.has(j.localStatus),
  "multi-item": (j) => FINISHED.has(j.localStatus) && j.requestCount > 1,
};

const PURPOSE_NOUN: Record<JobPurpose, string> = {
  any: "batch job",
  result: "finished batch job",
  submit: "saved plan that has not been submitted",
  cancel: "running job or unsubmitted plan",
  "multi-item": "finished multi-item batch job",
};

/** Purposes where guessing between several matches is not acceptable. */
const STRICT: ReadonlySet<JobPurpose> = new Set<JobPurpose>(["submit", "cancel"]);

const STATUS_WORDS: Array<{ words: string[]; match: (s: LocalStatus) => boolean }> = [
  { words: ["ready", "finished", "done", "completed", "complete", "succeeded", "successful"], match: (s) => FINISHED.has(s) },
  { words: ["partial", "incomplete"], match: (s) => s === "partial" },
  { words: ["failed", "failing", "errored", "expired"], match: (s) => FAILED.has(s) },
  { words: ["running", "active", "pending", "queued", "waiting", "inflight", "submitted", "ongoing"], match: (s) => ACTIVE_STATUSES.has(s) },
  { words: ["plan", "plans", "planned", "draft", "preview", "previewed", "unsubmitted", "saved"], match: (s) => PLANNED.has(s) },
  { words: ["cancelled", "canceled"], match: (s) => s === "cancelled" || s === "cancel_requested" },
];

const RECENCY_LATEST = new Set(["latest", "last", "newest", "recent", "current", "just", "most"]);
const RECENCY_PREVIOUS = new Set(["previous", "prior", "earlier", "penultimate"]);
const RECENCY_OLDEST = new Set(["oldest", "first", "earliest"]);

const STOP_WORDS = new Set([
  "the", "a", "an", "my", "our", "your", "that", "this", "these", "those", "one", "ones", "job", "jobs", "batch", "batches",
  "run", "ran", "from", "of", "for", "on", "in", "at", "to", "with", "about", "result", "results", "output", "please", "me",
  "which", "what", "i", "it", "we", "you", "did", "do", "started", "created", "made", "kicked", "off", "and", "or", "is", "was",
  "s", "openrouter", "request", "requests", "task", "thing", "mine", "same", "again", "ago",
]);

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019`]/g, "'")
    .replace(/'s\b/g, "")
    .replace(/in[\s-]progress/g, "inflight")
    .replace(/in[\s-]flight/g, "inflight")
    .replace(/not[\s-]submitted/g, "unsubmitted")
    .replace(/[^a-z0-9./_\s-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function words(text: string): string[] {
  return normalise(text)
    .split(/[\s/._-]+/)
    .filter(Boolean);
}

function stem(token: string): string {
  return token.length <= 4 ? token : token.slice(0, 5);
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function haystack(job: JobManifest): string[] {
  const paths = (job.items ?? []).flatMap((i) => (i.source.path ? [i.source.path] : (i.source.paths ?? [])));
  return words([job.name ?? "", jobLabel(job), job.objective, job.model, job.workflow?.name ?? "", ...paths.slice(0, 200)].join(" "));
}

function describe(job: JobManifest, now: Date): string {
  return `"${jobLabel(job)}" (${job.localId}, ${statusPhrase(job)}, created ${relativeTime(job.createdAt, now)})`;
}

function candidateList(jobs: readonly JobManifest[], now: Date, max = 5): string {
  return jobs
    .slice(0, max)
    .map((j) => `  - ${describe(j, now)}`)
    .join("\n");
}

/** Tries ID / suffix / provider-batch-ID resolution first; returns undefined when the input is not an ID. */
function tryExactId(registry: JobRegistry, raw: string): string | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return undefined;
  if (RECENCY_LATEST.has(raw.toLowerCase())) return undefined;
  try {
    return registry.resolveId(raw);
  } catch (err) {
    if (err instanceof JobNotFoundError) return undefined;
    // Ambiguous ID suffix: only rethrow if it looks like an ID fragment (contains a digit).
    if (/\d/.test(raw)) throw err;
    return undefined;
  }
}

/**
 * Resolves a job reference. Accepts, in order:
 *  1. A local job ID, unique ID suffix/prefix (e.g. "A7C2"), or provider batch ID.
 *  2. A user-given job name (exact, case-insensitive).
 *  3. A plain description combining any of: recency ("latest", "previous", "oldest"), status ("finished", "running",
 *     "failed", "plan"), day ("today", "yesterday") and topic words matched against the job's name, objective, model
 *     and file paths ("the security audit of src/auth").
 */
export function resolveJobRef(registry: JobRegistry, reference: string, opts: ResolveJobRefOptions = {}): JobRefResolution {
  const purpose = opts.purpose ?? "any";
  const now = opts.now ?? new Date();
  const raw = (reference ?? "").trim();
  if (!raw) throw new Error("Say which batch job you mean: its ID, its name, or a description such as \"latest\".");

  const exact = tryExactId(registry, raw);
  if (exact) return { id: exact, job: registry.read(exact), matchedBy: "id" };

  const all = registry.list().jobs.filter((j) => !isChatJob(j));
  if (all.length === 0) throw new Error("There are no batch jobs in this workspace yet.");

  // 2. Exact name match.
  const wantedName = normalise(raw);
  const named = all.filter((j) => j.name && normalise(j.name) === wantedName);
  if (named.length === 1) return { id: named[0]!.localId, job: named[0]!, matchedBy: "name" };

  // 3. Parse the description.
  const tokens = words(raw);
  let recency: "latest" | "previous" | "oldest" | undefined;
  const statusFilters: Array<(s: LocalStatus) => boolean> = [];
  let day: string | undefined;
  const topic: string[] = [];
  for (const t of tokens) {
    if (RECENCY_LATEST.has(t)) {
      recency ??= "latest";
      continue;
    }
    if (RECENCY_PREVIOUS.has(t)) {
      recency = "previous";
      continue;
    }
    if (RECENCY_OLDEST.has(t)) {
      recency = "oldest";
      continue;
    }
    if (t === "today") {
      day = dayKey(now);
      continue;
    }
    if (t === "yesterday") {
      day = dayKey(new Date(now.getTime() - 86_400_000));
      continue;
    }
    const status = STATUS_WORDS.find((s) => s.words.includes(t));
    if (status) {
      statusFilters.push(status.match);
      continue;
    }
    if (STOP_WORDS.has(t) || t.length < 2) continue;
    topic.push(t);
  }

  let pool = all;
  if (statusFilters.length) pool = pool.filter((j) => statusFilters.some((f) => f(j.localStatus)));
  if (day) pool = pool.filter((j) => dayKey(new Date(j.createdAt)) === day);

  // Topic scoring.
  let scored = pool.map((job) => ({ job, score: 1 }));
  if (topic.length) {
    scored = pool
      .map((job) => {
        const hay = haystack(job);
        const hits = topic.filter((t) => hay.some((w) => w.startsWith(stem(t)) || (w.length >= 4 && t.startsWith(w)))).length;
        return { job, score: hits / topic.length };
      })
      .filter((s) => s.score >= 0.5)
      .sort((a, b) => b.score - a.score || (a.job.createdAt < b.job.createdAt ? 1 : a.job.createdAt > b.job.createdAt ? -1 : 0));
  }

  const notFound = (): never => {
    const suitable = all.filter(PURPOSE_FILTER[purpose]);
    const recent = suitable.length ? suitable : all;
    throw new Error(
      `I couldn't find a ${PURPOSE_NOUN[purpose]} matching "${raw}". ` +
        `${suitable.length ? `Recent ${PURPOSE_NOUN[purpose]}s` : "Recent batch jobs"}:\n${candidateList(recent, now)}`,
    );
  };
  if (scored.length === 0) return notFound();

  // Prefer jobs that suit the purpose; strict purposes require it.
  const suited = scored.filter((s) => PURPOSE_FILTER[purpose](s.job));
  if (suited.length) scored = suited;
  else if (STRICT.has(purpose)) {
    const best = scored[0]!.job;
    throw new Error(`${describe(best, now)} is not a ${PURPOSE_NOUN[purpose]}, so it can't be used here.`);
  }

  const topScore = scored[0]!.score;
  const top = scored.filter((s) => s.score === topScore).map((s) => s.job);

  if (recency) {
    const ordered = [...top].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    const pick = recency === "latest" ? ordered[0] : recency === "previous" ? ordered[1] : ordered[ordered.length - 1];
    if (!pick) return notFound();
    return { id: pick.localId, job: pick, matchedBy: topic.length ? "description" : "recency", note: `Using ${describe(pick, now)}.` };
  }

  if (top.length === 1) {
    const pick = top[0]!;
    return { id: pick.localId, job: pick, matchedBy: topic.length ? "description" : "recency", note: `Using ${describe(pick, now)}.` };
  }

  if (STRICT.has(purpose)) {
    throw new Error(`"${raw}" matches more than one ${PURPOSE_NOUN[purpose]}. Which one did you mean?\n${candidateList(top, now)}`);
  }

  // Non-strict: take the newest and say so, listing the others.
  const pick = top[0]!;
  const others = top.slice(1, 4).map((j) => `"${jobLabel(j)}" (${j.localId})`);
  return {
    id: pick.localId,
    job: pick,
    matchedBy: topic.length ? "description" : "recency",
    note: `Using the most recent match, ${describe(pick, now)}. Other matches: ${others.join(", ")}${top.length > 4 ? ", …" : ""}.`,
  };
}
