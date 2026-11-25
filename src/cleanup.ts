import * as crypto from "node:crypto";
import * as path from "node:path";
import type { ThreadStore } from "./chat/store.js";
import type { ThreadState } from "./chat/types.js";
import { jobLabel } from "./humanize.js";
import { resolveJobRef } from "./job-ref.js";
import { neverReachedOpenRouter } from "./privacy/policy.js";
import type { JobRegistry } from "./registry.js";
import { dirSizeBytes } from "./removal.js";
import { ACTIVE_STATUSES, TERMINAL_STATUSES } from "./state.js";
import type { JobManifest } from "./types.js";

const DAY_MS = 86_400_000;
const PLAN_TTL_MS = 10 * 60_000;

export interface CleanupItem {
  kind: "job" | "thread";
  id: string;
  label: string;
  status: string;
  ageDays: number;
  bytes: number;
  /** The target this item was pulled in by (a chat's turn job, a source job's retry or synthesis). */
  viaClosure?: string;
}
export interface CleanupSkip {
  kind: "job" | "thread";
  id: string;
  reason: string;
}
export interface CleanupPlan {
  planId: string;
  items: CleanupItem[];
  skipped: CleanupSkip[];
  totalBytes: number;
  remote: boolean;
}
export interface CleanupResult {
  deleted: CleanupItem[];
  skipped: CleanupSkip[];
  freedBytes: number;
  remote: Array<{ id: string; ok: boolean; error?: string }>;
}
export type CleanupTarget = { refs: string[] } | { olderThanMs: number; include: "all" | "jobs" | "chats" };

export interface CleanupDeps {
  registry: JobRegistry;
  threads: ThreadStore;
  now?: () => Date;
  /** Deletes the provider-side batch (only used with `remote`). */
  remoteDelete?: (job: JobManifest) => Promise<void>;
}

/** "7d", "12h" or "0" as milliseconds. */
export function parseOlderThan(text: string): number {
  const t = text.trim().toLowerCase();
  if (t === "0") return 0;
  const m = /^(\d+)([dh])$/.exec(t);
  if (!m) throw new Error(`--older-than must look like 7d, 12h or 0 (got "${text}")`);
  return Number(m[1]) * (m[2] === "d" ? DAY_MS : 3_600_000);
}

type Kind = "job" | "thread";

interface StoredPlan {
  plan: CleanupPlan;
  createdAt: number;
  manifests: Map<string, JobManifest>;
  /** thread id -> ids of its planned jobs */
  threadJobs: Map<string, string[]>;
}

/**
 * Plans and applies deletion of chats and batch jobs. `plan` is read-only; `apply` deletes exactly the planned
 * list, rechecking each item under its lock, so what the user confirmed is what goes.
 */
export class CleanupService {
  private readonly plans = new Map<string, StoredPlan>();
  private readonly now: () => Date;

  constructor(private readonly deps: CleanupDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  public plan(target: CleanupTarget, opts: { remote?: boolean } = {}): CleanupPlan {
    const { registry, threads } = this.deps;
    for (const [id, p] of this.plans) if (this.now().getTime() - p.createdAt > PLAN_TTL_MS) this.plans.delete(id);
    const isFilter = "olderThanMs" in target;
    const listed = registry.list();
    const jobs = new Map(listed.jobs.map((j) => [j.localId, j]));
    const unreadable = new Map(listed.unreadable.map((u) => [u.localId, u.reason]));
    const threadList = new Map(threads.list().map((t) => [t.id, t]));

    const skipped = new Map<string, CleanupSkip>();
    const roots: Array<{ kind: Kind; id: string }> = [];

    if (!("olderThanMs" in target)) {
      for (const ref of target.refs) {
        const found = this.resolveRef(ref, jobs, unreadable);
        if (found.kind === "unreadable") {
          skipped.set(found.id, { kind: "job", id: found.id, reason: `manifest is unreadable (${unreadable.get(found.id)}); not deleted blindly` });
        } else {
          roots.push({ kind: found.kind, id: found.id });
        }
      }
      // A chat turn's job is part of its chat: on its own it would leave the transcript pointing at a missing job.
      const named = new Set(roots.filter((r) => r.kind === "thread").map((r) => r.id));
      for (let i = roots.length - 1; i >= 0; i--) {
        const r = roots[i]!;
        const threadId = r.kind === "job" ? jobs.get(r.id)?.chat?.threadId : undefined;
        if (threadId && threadList.has(threadId) && !named.has(threadId)) {
          skipped.set(r.id, { kind: "job", id: r.id, reason: `belongs to chat ${threadId}; delete the chat instead` });
          roots.splice(i, 1);
        }
      }
    } else {
      const cutoff = this.now().getTime() - target.olderThanMs;
      if (target.include !== "chats") {
        for (const j of jobs.values()) {
          if (!TERMINAL_STATUSES.has(j.localStatus) || Date.parse(j.createdAt) > cutoff) continue;
          // A chat turn job goes with its thread; on its own only when the thread is already gone.
          if (j.chat && threadList.has(j.chat.threadId)) continue;
          roots.push({ kind: "job", id: j.localId });
        }
      }
      if (target.include !== "jobs") {
        for (const t of threadList.values()) if (Date.parse(t.updatedAt) <= cutoff) roots.push({ kind: "thread", id: t.id });
      }
    }

    const items = new Map<string, CleanupItem>();
    const manifests = new Map<string, JobManifest>();
    const threadJobs = new Map<string, string[]>();
    const nowMs = this.now().getTime();

    type Member = { kind: Kind; id: string; via?: string };
    const groups: Member[][] = roots.map((root) => {
      const members: Member[] = [];
      const seen = new Set<string>();
      const add = (kind: Kind, id: string, via?: string) => {
        if (seen.has(`${kind}:${id}`)) return;
        seen.add(`${kind}:${id}`);
        members.push({ kind, id, ...(via ? { via } : {}) });
      };
      add(root.kind, root.id);
      if (root.kind === "thread") {
        for (const j of jobs.values()) if (j.chat?.threadId === root.id) add("job", j.localId, root.id);
      } else {
        const queue = [root.id];
        while (queue.length) {
          const cur = queue.shift()!;
          for (const j of jobs.values()) {
            const linked = j.parentJobId === cur || (j.kind === "synthesis" && j.synthesis?.sourceJobId === cur);
            if (linked && !seen.has(`job:${j.localId}`)) {
              add("job", j.localId, root.id);
              queue.push(j.localId);
            }
          }
        }
      }
      return members;
    });

    // A group is blocked when one of its members is active; a group that shares a member with a blocked group is
    // blocked too (so naming a job on its own cannot slip past the group that holds it back). Repeat until stable.
    const blocked = new Map<string, { kind: Kind; reason: string }>();
    const blockedGroups = new Set<number>();
    for (let changed = true; changed; ) {
      changed = false;
      groups.forEach((members, gi) => {
        if (blockedGroups.has(gi)) return;
        const own = members.find((m) => this.blockedReason(m.kind, m.id, jobs, threadList));
        const shared = own ? undefined : members.find((m) => blocked.has(m.id));
        const cause = own
          ? { kind: own.kind, id: own.id, why: this.blockedReason(own.kind, own.id, jobs, threadList)! }
          : shared
            ? { kind: shared.kind, id: shared.id, why: blocked.get(shared.id)!.reason }
            : undefined;
        if (!cause) return;
        blockedGroups.add(gi);
        changed = true;
        for (const m of members) {
          if (!blocked.has(m.id)) blocked.set(m.id, { kind: m.kind, reason: m.id === cause.id ? cause.why : `linked ${cause.kind} ${cause.id} is ${cause.why}` });
        }
      });
    }
    for (const [id, b] of blocked) if (!skipped.has(id)) skipped.set(id, { kind: b.kind, id, reason: b.reason });

    // A filter-based clean-up cannot tell what an unreadable folder belongs to: say so rather than leave it unmentioned.
    if (isFilter) {
      for (const [id, why] of unreadable) {
        if (!skipped.has(id)) skipped.set(id, { kind: "job", id, reason: `manifest is unreadable (${why}); not deleted blindly` });
      }
    }

    groups.forEach((members, gi) => {
      if (blockedGroups.has(gi)) return;
      for (const m of members) {
        if (items.has(m.id)) continue;
        if (m.kind === "job") {
          const j = jobs.get(m.id)!;
          manifests.set(j.localId, j);
          items.set(m.id, {
            kind: "job",
            id: m.id,
            label: jobLabel(j),
            status: j.localStatus,
            ageDays: Math.floor((nowMs - Date.parse(j.createdAt)) / DAY_MS),
            bytes: dirSizeBytes(path.join(this.deps.registry.root, m.id)),
            ...(m.via ? { viaClosure: m.via } : {}),
          });
          if (j.chat) threadJobs.set(j.chat.threadId, [...(threadJobs.get(j.chat.threadId) ?? []), m.id]);
        } else {
          const t = threadList.get(m.id)!;
          items.set(m.id, {
            kind: "thread",
            id: m.id,
            label: t.title,
            status: "chat",
            ageDays: Math.floor((nowMs - Date.parse(t.updatedAt)) / DAY_MS),
            bytes: dirSizeBytes(path.join(this.deps.threads.root, m.id)),
          });
        }
      }
    });

    const ordered = [...items.values()].sort((a, b) => (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind === "job" ? -1 : 1));
    const plan: CleanupPlan = {
      planId: crypto.randomBytes(6).toString("hex"),
      items: ordered,
      skipped: [...skipped.values()],
      totalBytes: ordered.reduce((n, i) => n + i.bytes, 0),
      remote: opts.remote === true,
    };
    this.plans.set(plan.planId, { plan, createdAt: nowMs, manifests, threadJobs });
    return plan;
  }

  /** The stored plan (for a confirmation prompt), or undefined when unknown or expired. */
  public peek(planId: string): CleanupPlan | undefined {
    const stored = this.plans.get(planId);
    return stored && this.now().getTime() - stored.createdAt <= PLAN_TTL_MS ? stored.plan : undefined;
  }

  public async apply(planId: string): Promise<CleanupResult> {
    const stored = this.plans.get(planId);
    this.plans.delete(planId); // a plan is single-use
    if (!stored || this.now().getTime() - stored.createdAt > PLAN_TTL_MS) {
      throw new Error("That cleanup plan is unknown or has expired; re-plan it and confirm again.");
    }
    const { registry, threads } = this.deps;
    // Leftovers of an interrupted delete are swept here, so planning stays read-only.
    registry.sweepDeleting();
    threads.sweepDeleting();
    const deleted: CleanupItem[] = [];
    const skipped: CleanupSkip[] = [...stored.plan.skipped];

    // A chat goes first: if it cannot be deleted (a turn started since the plan) its jobs stay with it, so no
    // transcript is ever left pointing at a missing job. A job whose chat is already gone is deletable on its own.
    const keptChats = new Set<string>();
    for (const item of stored.plan.items.filter((i) => i.kind === "thread")) {
      try {
        await threads.removeThread(item.id);
        deleted.push(item);
      } catch (err) {
        keptChats.add(item.id);
        skipped.push({ kind: "thread", id: item.id, reason: (err as Error).message });
      }
    }
    for (const item of stored.plan.items.filter((i) => i.kind === "job")) {
      const chat = [...keptChats].find((t) => (stored.threadJobs.get(t) ?? []).includes(item.id));
      if (chat) {
        skipped.push({ kind: "job", id: item.id, reason: `its chat ${chat} could not be deleted` });
        continue;
      }
      try {
        await registry.removeJob(item.id);
        deleted.push(item);
      } catch (err) {
        skipped.push({ kind: "job", id: item.id, reason: (err as Error).message });
      }
    }

    const remote: CleanupResult["remote"] = [];
    if (stored.plan.remote && this.deps.remoteDelete) {
      for (const item of deleted.filter((d) => d.kind === "job")) {
        const job = stored.manifests.get(item.id);
        if (!job?.providerBatchId || job.route === "immediate" || !TERMINAL_STATUSES.has(job.localStatus) || neverReachedOpenRouter(job)) continue;
        try {
          await this.deps.remoteDelete(job);
          remote.push({ id: item.id, ok: true });
        } catch (err) {
          remote.push({ id: item.id, ok: false, error: (err as Error).message });
        }
      }
    }
    return { deleted, skipped, freedBytes: deleted.reduce((n, d) => n + d.bytes, 0), remote };
  }

  private blockedReason(kind: Kind, id: string, jobs: Map<string, JobManifest>, threads: Map<string, ThreadState>): string | undefined {
    if (kind === "job") {
      const j = jobs.get(id);
      return j && ACTIVE_STATUSES.has(j.localStatus) ? `active (${j.localStatus})` : undefined;
    }
    const t = threads.get(id);
    return t && (t.pending || t.compacting) ? "active (a turn or compaction is in progress)" : undefined;
  }

  private resolveRef(
    ref: string,
    jobs: Map<string, JobManifest>,
    unreadable: Map<string, string>,
  ): { kind: Kind | "unreadable"; id: string } {
    let jobId: string | undefined;
    try {
      const id = this.deps.registry.resolveId(ref);
      if (jobs.has(id)) jobId = id;
    } catch {
      /* not a job: try the other kinds */
    }
    const wanted = ref.trim().toUpperCase();
    if (!jobId) for (const id of unreadable.keys()) if (id === wanted || id.endsWith(wanted)) return { kind: "unreadable", id };
    let threadId: string | undefined;
    try {
      threadId = this.deps.threads.resolve(ref);
    } catch (err) {
      if (/ambiguous/.test((err as Error).message)) throw err;
    }
    if (jobId && threadId) throw new Error(`"${ref}" is ambiguous: job ${jobId} and chat ${threadId}. Use the full id.`);
    if (jobId) return { kind: "job", id: jobId };
    if (threadId) return { kind: "thread", id: threadId };
    // "latest", "the failed audit", "yesterday's review": the job resolver, strict about ambiguity.
    try {
      return { kind: "job", id: resolveJobRef(this.deps.registry, ref, { purpose: "delete" }).id };
    } catch (err) {
      if (/more than one/.test((err as Error).message)) throw err;
      throw new Error(`No chat or batch job matches "${ref}".`);
    }
  }
}
