import * as fs from "node:fs";
import * as path from "node:path";
import { prepareAttachments, type AttachmentRequestInput, type PreparedAttachments } from "../attachments.js";
import type { BatchConfig } from "../config.js";
import { formatSecretFindings, scanForSecrets } from "../context/secrets.js";
import { isUsable, itemText, jobItems } from "../items.js";
import { nullLogger, type Logger } from "../logger.js";
import { normalizeBatchModelSlug } from "../models.js";
import {
  effectiveLevel as effectiveLevelOf,
  normaliseModelSlug,
  PRIVACY_LEVELS,
  resolveBatchProvider,
  routeForModel,
  type PrivacyLevel,
  type Route,
} from "../privacy/policy.js";
import type { BatchService } from "../service.js";
import { TERMINAL_STATUSES } from "../state.js";
import { JobNotFoundError } from "../registry.js";
import { isoToEpochMs, nowIso } from "../time.js";
import type { JobManifest } from "../types.js";
import {
  buildCompactionMessages,
  buildTitleMessages,
  buildTurnMessages,
  cleanTitle,
  compactionBoundary,
  conversationOrder,
  estimateTokens,
  provisionalTitle,
  type ChatPrompt,
} from "./request.js";
import type { ThreadStore } from "./store.js";
import type { ThreadState, TranscriptEntry, TranscriptEntryInput } from "./types.js";

/** Project instructions (the CLAUDE.md equivalent), relative to the workspace root. */
export const PROJECT_INSTRUCTIONS_FILE = ".pi/BATCH_CHAT.md";
/** Margin on top of the submit HTTP timeout before a claim with no job ID counts as stale. */
const STALE_CLAIM_MARGIN_MS = 60_000;
/** Never treat a claim as stale sooner than this. */
const MIN_STALE_CLAIM_MS = 120_000;
/**
 * A claim with no job ID older than this was left behind by a process that stopped mid-send, or its submit is still
 * running. It is derived from the submit HTTP timeout so a slow (but live, and billed) submit is never expired.
 */
export function staleClaimMs(config: BatchConfig): number {
  return Math.max(MIN_STALE_CLAIM_MS, config.polling.requestTimeoutSeconds * 1000 + STALE_CLAIM_MARGIN_MS);
}

/** The job error code for a submit whose outcome is unknown: OpenRouter may have accepted (and billed) it. */
export const SUBMISSION_UNKNOWN = "submission_unknown";
/** What to do after a `submission_unknown` turn failure. Never a plain retry. */
export const SUBMISSION_UNKNOWN_ADVICE =
  "Check your OpenRouter activity first; only if the turn was not billed, use /batch chat retry --force (a plain retry is refused to avoid paying twice).";
/** Consecutive poller ticks a job manifest may fail to read (Windows EBUSY/EPERM) before a turn is failed. */
const READ_FAILURE_TICKS = 5;
/** Lock wait for updates no user is waiting on (settling, recording a job ID or a failure). */
const BACKGROUND_LOCK_WAIT_MS = 10_000;

/** A secret was found in the message or in the project instructions. Nothing was saved or sent. */
export class ChatBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatBlockedError";
  }
}

export interface ChatServiceDeps {
  store: ThreadStore;
  batch: BatchService;
  workspaceRoot: string;
  getConfig: () => BatchConfig;
  logger?: Logger;
}

type Pending = NonNullable<ThreadState["pending"]>;
type Compacting = NonNullable<ThreadState["compacting"]>;
type Append = (e: TranscriptEntryInput) => TranscriptEntry;

/** The last user seq a reply has answered (0 if none). */
function answeredThrough(entries: TranscriptEntry[]): number {
  let max = 0;
  for (const e of entries) if (e.type === "assistant") max = Math.max(max, e.throughSeq ?? e.seq);
  return max;
}

/**
 * User entries no reply has answered yet. With no turn pending these are the unsent ones: typed while a reply was
 * pending, after a failed turn, or claimed by a turn that never got submitted.
 */
function unsentUserSeqs(entries: TranscriptEntry[]): number[] {
  const through = answeredThrough(entries);
  return entries.filter((e) => e.type === "user" && e.seq > through).map((e) => e.seq);
}

function sameClaim(p: Pending | Compacting | undefined, claim: Pending | Compacting): boolean {
  return p !== undefined && p.throughSeq === claim.throughSeq && p.claimedAt === claim.claimedAt && p.jobId === claim.jobId;
}

/** Under the lock: adopts a title a job generated, unless the user set the title by hand. */
function applyAutoTitle(t: ThreadState, append: Append, title: string | undefined): void {
  if (!title || t.titleLocked) return;
  t.title = title;
  t.retitled = true;
  append({ type: "title", title, source: "auto" });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Chat threads on top of batch jobs. One turn in flight per thread; messages typed meanwhile are appended and go out
 * together as the next turn once the reply lands. Every state decision is made inside `store.update` (a cross-process
 * lock), so two Pi processes settling or sending for the same thread cannot both act.
 */
export class ChatService {
  private readonly logger: Logger;
  /** Consecutive transient read failures per job ID (or claim key). In memory only: a restart starts over. */
  private readonly readFailures = new Map<string, number>();

  constructor(private readonly deps: ChatServiceDeps) {
    this.logger = deps.logger ?? nullLogger;
  }

  private get store(): ThreadStore {
    return this.deps.store;
  }

  public newThread(): ThreadState {
    const config = this.deps.getConfig();
    return this.store.create({ model: normalizeBatchModelSlug(config.defaultModel), account: config.defaultAccount });
  }

  public mostRecent(): ThreadState | undefined {
    return this.store.list()[0];
  }

  public async prepareSend(threadId: string, text: string, attachments?: AttachmentRequestInput): Promise<PreparedAttachments> {
    const thread = this.store.read(threadId);
    const config = this.deps.getConfig();
    const knownSecrets = await this.deps.batch.knownSecrets(thread.account);
    const prep = await prepareAttachments({
      workspaceRoot: this.deps.workspaceRoot,
      config,
      knownSecrets,
      input: attachments,
    });
    if (config.security.scanSecrets && text.trim()) {
      const msgFindings = scanForSecrets(text, "<chat message>", knownSecrets);
      if (msgFindings.length > 0) {
        prep.secretFindings.push(...msgFindings);
        if (config.security.blockOnSecret) prep.blockers.push(formatSecretFindings(msgFindings));
      }
    }
    return prep;
  }

  /**
   * Scans, then appends the message. If the thread is idle, submits it (with any earlier unsent messages) as a turn;
   * otherwise it stays queued. A secret refuses the message before anything is written (ChatBlockedError), and a
   * held thread lock propagates as ThreadBusyError with nothing written.
   */
  public async send(threadId: string, text: string, attachments?: AttachmentRequestInput): Promise<{ queued: boolean; jobId?: string; warnings?: string[] }> {
    const hasAtt = Boolean((attachments?.files?.length ?? 0) + (attachments?.contexts?.length ?? 0) + (attachments?.uploads?.length ?? 0));
    if (text.trim() === "" && !hasAtt) return { queued: true };
    const thread = this.store.read(threadId);
    const prompt = await this.checkedPrompt(thread.account, text);
    const prep = hasAtt ? await this.prepareSend(threadId, "", attachments) : undefined;
    if (prep && prep.blockers.length > 0) {
      throw new ChatBlockedError(`${prep.blockers.join("\n\n")}\n\nYour message was not saved.`);
    }
    const warnings = prep?.warnings ?? [];
    const claim = this.store.update(threadId, (t, append) => {
      const entries = this.store.transcript(threadId).entries;
      const entry = append({
        type: "user",
        text,
        ...(prep && prep.attachments.length > 0 ? { attachments: prep.attachments } : {}),
        ...(prep && prep.inlinedText ? { inlinedText: prep.inlinedText } : {}),
        ...(prep && prep.parts.length > 0 ? { parts: prep.parts } : {}),
      });
      // Shown in the thread, so a file sent without a secret scan (or any other attachment caveat) is never silent.
      if (warnings.length > 0) append({ type: "status", text: `⚠ ${warnings.join(" ")}` });
      if (t.title === "(untitled)") {
        const titleSource = text.trim() || prep?.attachments.map((a) => a.name).join(", ") || "(attachment)";
        t.title = provisionalTitle(titleSource);
      }
      return this.claim(t, [...entries, entry]);
    });
    const warned = warnings.length > 0 ? { warnings } : {};
    if (!claim) return { queued: true, ...warned };
    const r = await this.submitTurn(threadId, claim, prompt);
    return { queued: false, ...(r.jobId ? { jobId: r.jobId } : {}), ...warned };
  }

  /**
   * Applies a settled chat job to its thread. Idempotent and safe across processes: a no-op unless the thread's
   * pending turn is this job. After a reply, queued messages go out in the background.
   */
  public applySettled(job: JobManifest): void {
    if (this.settle(job)) this.sendInBackground(job.chat!.threadId);
  }

  /**
   * Poller pass over every thread: applies settled jobs (including ones that settled while no Pi was open), expires
   * claims left behind by a stopped process, and sends unsent messages.
   */
  public async tick(): Promise<void> {
    for (const thread of this.store.list()) {
      try {
        await this.tickThread(thread);
      } catch (err) {
        this.logger.log("warn", "chat_tick_failed", { threadId: thread.id, error: errorMessage(err) });
      }
    }
  }

  /**
   * Clears the last failure and sends every unsent message as one turn. Returns the new job ID. When the failed turn
   * may have reached OpenRouter (`submission_unknown`), it is refused unless `force` is set: resubmitting could bill
   * the same turn twice.
   */
  public async retry(threadId: string, opts: { force?: boolean } = {}): Promise<string> {
    const nothing = `Nothing to retry: the last turn in ${threadId} did not fail.`;
    const thread = this.store.read(threadId);
    if (!thread.lastFailure) throw new Error(nothing);
    const refuse = (f: NonNullable<ThreadState["lastFailure"]>) => {
      if (!opts.force && this.submissionUnknown(f)) {
        throw new Error(`The last turn in ${threadId} may have reached OpenRouter: it got no response when it was submitted${f.jobId ? ` (job ${f.jobId})` : ""}. ${SUBMISSION_UNKNOWN_ADVICE}`);
      }
    };
    refuse(thread.lastFailure);
    const prompt = await this.checkedPrompt(thread.account);
    const claim = this.store.update(threadId, (t) => {
      if (!t.lastFailure) throw new Error(nothing);
      refuse(t.lastFailure);
      if (t.pending) throw new Error(`A reply is already pending in ${threadId}.`);
      delete t.lastFailure;
      const c = this.claim(t, this.store.transcript(threadId).entries);
      if (!c) throw new Error(`Nothing to retry: ${threadId} has no unsent messages.`);
      return c;
    });
    const r = await this.submitTurn(threadId, claim, prompt);
    if (!r.jobId) throw new Error(r.error);
    return r.jobId;
  }

  /**
   * Starts a compaction job: everything before the `keepRecentExchanges` most recent exchanges (after the current
   * summary) is summarised, on top of that summary. `instructions` steer the focus. Returns the job ID. Sending is
   * unaffected while it runs; the summary takes effect from the next request after it lands.
   */
  public async compact(threadId: string, instructions?: string): Promise<string> {
    const focus = instructions?.trim() || undefined;
    if (focus !== undefined) await this.scanInstructions(this.store.read(threadId).account, focus);
    const r = await this.startCompaction(threadId, focus);
    if (!r.jobId) throw new Error(r.error);
    return r.jobId;
  }

  /** The stricter of the project level and the thread's own level. */
  public effectiveLevel(threadId: string): PrivacyLevel {
    return effectiveLevelOf(this.deps.getConfig().privacy.level, this.store.read(threadId).privacyLevel);
  }

  /** Raises the thread's level. Only a level stricter than both the thread's and the project's is accepted. */
  public raisePrivacy(threadId: string, level: PrivacyLevel): void {
    if (!PRIVACY_LEVELS.includes(level)) throw new Error(`Unknown privacy level "${level}". Use ${PRIVACY_LEVELS.join(", ")}.`);
    const project = this.deps.getConfig().privacy.level;
    this.store.update(threadId, (t, append) => {
      const current = effectiveLevelOf(project, t.privacyLevel);
      if (PRIVACY_LEVELS.indexOf(level) <= PRIVACY_LEVELS.indexOf(current)) {
        throw new Error("Privacy level: can't lower a thread below the project level");
      }
      t.privacyLevel = level;
      append({ type: "status", text: `Privacy level for this thread raised to ${level}.` });
    });
  }

  /** The batch-retention line for `/batch chat context`. */
  public batchRetentionLine(threadId: string): string {
    const strict = this.effectiveLevel(threadId) !== "standard";
    return strict && this.deps.getConfig().privacy.deleteRemoteBatches
      ? "Batch jobs are held at OpenRouter until finished; deleted after retrieval"
      : "Batch jobs are kept up to 30 days";
  }

  /**
   * Changes the model from the next turn on. A reply already pending keeps the model it was sent with. The model is
   * checked against the effective privacy level first; the refusal reason is thrown.
   */
  public async setModel(threadId: string, slug: string, opts: { route?: Route } = {}): Promise<void> {
    const to = normalizeBatchModelSlug(slug.trim());
    if (!to) throw new Error("Model slug is empty.");
    const route = routeForModel(to, opts.route);
    const config = this.deps.getConfig();
    const thread = this.store.read(threadId);
    const level = effectiveLevelOf(config.privacy.level, thread.privacyLevel);
    const catalog = level === "zdr" ? await this.deps.batch.catalog?.whenLoaded(config.polling.requestTimeoutSeconds * 1000) : undefined;
    if (route === "batch") {
      const d = resolveBatchProvider({ level, model: to, userPin: thread.providerPin, catalog, accountNoTraining: config.privacy.accountNoTraining });
      if (!d.ok) throw new Error(d.reason);
    } else if (level === "zdr") {
      const base = normaliseModelSlug(to);
      if (!catalog?.fresh) {
        throw new Error("Privacy level zdr: model catalog not loaded this session, so ZDR endpoints can't be verified (run /batch privacy refresh)");
      }
      if (!catalog.zdr.some((e) => e.model === base)) throw new Error(`Privacy level zdr: no ZDR endpoint available for ${base}`);
    }
    this.store.update(threadId, (t, append) => {
      if (t.model !== to) {
        append({ type: "model", from: t.model, to });
        t.model = to;
      }
      t.route = route;
    });
  }

  /** A manual title locks it against auto-retitling; `{ auto: true }` unlocks it. */
  public rename(threadId: string, title: string | { auto: true }): void {
    if (typeof title !== "string") {
      this.store.update(threadId, (t) => {
        t.titleLocked = false;
      });
      return;
    }
    const clean = provisionalTitle(title);
    if (!clean) throw new Error("Title is empty.");
    this.store.update(threadId, (t, append) => {
      t.title = clean;
      t.titleLocked = true;
      append({ type: "title", title: clean, source: "manual" });
    });
  }

  /** Estimated size of the next turn's request (characters / 4), split into summary and recent messages. */
  public nextRequestEstimate(threadId: string): { tokens: number; summaryTokens: number; recentTokens: number; limit: number } {
    const thread = this.store.read(threadId);
    const entries = conversationOrder(this.store.transcript(threadId).entries);
    const messages = buildTurnMessages(thread, entries, Number.MAX_SAFE_INTEGER, this.basePrompt());
    return {
      tokens: estimateTokens(messages),
      summaryTokens: thread.summary ? Math.ceil(thread.summary.text.length / 4) : 0,
      recentTokens: estimateTokens(messages.slice(1)),
      limit: this.deps.getConfig().chat.autoCompactTokens,
    };
  }

  // ------------------------------------------------------------- internals

  /** True when the failed turn's job may have been accepted (and billed) by OpenRouter. */
  private submissionUnknown(f: NonNullable<ThreadState["lastFailure"]>): boolean {
    if (f.code === SUBMISSION_UNKNOWN) return true;
    if (f.code !== undefined || !f.jobId) return false;
    // Failures recorded before `code` existed: ask the job itself.
    try {
      return this.deps.batch.registry.read(f.jobId).error?.code === SUBMISSION_UNKNOWN;
    } catch {
      return false;
    }
  }

  private projectInstructions(): string | undefined {
    const file = path.join(this.deps.workspaceRoot, ...PROJECT_INSTRUCTIONS_FILE.split("/"));
    if (!fs.existsSync(file)) return undefined;
    const text = fs.readFileSync(file, "utf8").trim();
    return text === "" ? undefined : text;
  }

  private basePrompt(instructions = this.projectInstructions()): ChatPrompt {
    return { systemPrompt: this.deps.getConfig().chat.systemPrompt, ...(instructions ? { projectInstructions: instructions } : {}) };
  }

  /** The prompt for a send, after scanning `message` (if given) and the project instructions for secrets. */
  private async checkedPrompt(account: string, message?: string): Promise<ChatPrompt> {
    const { security } = this.deps.getConfig();
    const instructions = this.projectInstructions();
    if (security.scanSecrets) {
      const known = await this.deps.batch.knownSecrets(account);
      const findings = [
        ...(message !== undefined ? scanForSecrets(message, "<chat message>", known) : []),
        ...(instructions !== undefined ? scanForSecrets(instructions, PROJECT_INSTRUCTIONS_FILE, known) : []),
      ];
      if (findings.length > 0) {
        if (security.blockOnSecret) {
          const outcome = message !== undefined ? "Your message was not saved. Remove the secret and type it again." : `Nothing was sent. Fix ${PROJECT_INSTRUCTIONS_FILE}, then /batch chat retry.`;
          throw new ChatBlockedError(`${formatSecretFindings(findings)}\n\n${outcome}`);
        }
        this.logger.log("warn", "chat_secret_not_blocked", { findings: findings.length });
      }
    }
    return this.basePrompt(instructions);
  }

  /** Secret scan for compaction instructions (they are sent and stored like a message). */
  private async scanInstructions(account: string, text: string): Promise<void> {
    const { security } = this.deps.getConfig();
    if (!security.scanSecrets) return;
    const findings = scanForSecrets(text, "<compaction instructions>", await this.deps.batch.knownSecrets(account));
    if (findings.length === 0) return;
    if (security.blockOnSecret) {
      throw new ChatBlockedError(`${formatSecretFindings(findings)}\n\nNothing was compacted. Remove the secret from the instructions and try again.`);
    }
    this.logger.log("warn", "chat_secret_not_blocked", { findings: findings.length });
  }

  /** Under the lock: claims the thread for a turn covering every unsent message, if it is idle. */
  private claim(t: ThreadState, entries: TranscriptEntry[]): Pending | undefined {
    if (t.pending || t.lastFailure) return undefined;
    const unsent = unsentUserSeqs(entries);
    if (unsent.length === 0) return undefined;
    t.pending = { throughSeq: unsent[unsent.length - 1]!, claimedAt: nowIso() };
    return { ...t.pending };
  }

  /** Creates and submits the turn for a claim, then records its job ID (or the failure). Never throws. */
  private async submitTurn(threadId: string, claim: Pending, prompt: ChatPrompt): Promise<{ jobId?: string; error?: string }> {
    let jobId: string | undefined;
    let code: string | undefined;
    try {
      const thread = this.store.read(threadId);
      const entries = conversationOrder(this.store.transcript(threadId).entries);
      const replies = entries.filter((e) => e.type === "assistant").length;
      const retitle = !thread.titleLocked && !thread.retitled && replies + 1 === this.deps.getConfig().chat.retitleAtTurn;
      const job = await this.deps.batch.createChatJob({
        threadId,
        purpose: "turn",
        throughSeq: claim.throughSeq,
        model: thread.model,
        account: thread.account,
        route: thread.route ?? routeForModel(thread.model),
        privacyLevel: effectiveLevelOf(this.deps.getConfig().privacy.level, thread.privacyLevel),
        ...(thread.providerPin ? { pin: thread.providerPin } : {}),
        main: buildTurnMessages(thread, entries, claim.throughSeq, prompt),
        ...(retitle ? { title: buildTitleMessages(thread, entries, claim.throughSeq) } : {}),
      });
      jobId = job.localId;
      if (job.localStatus === "failed") {
        code = job.error?.code;
        throw new Error(job.error?.message ?? "the provider rejected the batch");
      }
    } catch (err) {
      const message =
        code === SUBMISSION_UNKNOWN
          ? `No response from OpenRouter while submitting the turn${jobId ? ` (job ${jobId})` : ""}; it MAY have been accepted. ${SUBMISSION_UNKNOWN_ADVICE}`
          : `The turn could not be submitted${jobId ? ` (job ${jobId})` : ""}: ${errorMessage(err)}`;
      this.recordFailure(threadId, claim, message, jobId, code);
      return { error: message };
    }
    const link = this.linkClaim(threadId, "turn", claim, jobId!);
    if (!link.linked) return { error: this.linkFailedMessage(threadId, jobId!, link.reason) };
    this.applyIfSettled(jobId!);
    return { jobId };
  }

  /**
   * A job can settle before its claim is linked (an immediate-route reply settles inside submit, so its
   * `onSettled` found no linked claim). Applies it now instead of on the next tick. `settle` re-checks the
   * linked job under the thread lock and clears the claim, so a later tick or `onSettled` is a no-op.
   */
  private applyIfSettled(jobId: string): void {
    try {
      const job = this.deps.batch.registry.read(jobId);
      if (TERMINAL_STATUSES.has(job.localStatus)) this.applySettled(job);
    } catch (err) {
      // The next tick applies it.
      this.logger.log("warn", "chat_settle_failed", { localId: jobId, error: errorMessage(err) });
    }
  }

  /**
   * Links a submitted job to the claim that created it: only if the thread still holds that claim, or a poller tick
   * already adopted the job for it. Never throws; a failure is logged and reported (the job is billed, so it must not
   * look like a normal success).
   */
  private linkClaim(threadId: string, purpose: "turn" | "compact", claim: Pending | Compacting, jobId: string): { linked: boolean; reason: string } {
    let reason = "the thread no longer holds the claim that submitted it";
    let linked = false;
    try {
      linked = this.store.update(
        threadId,
        (t) => {
          const current = purpose === "turn" ? t.pending : t.compacting;
          if (sameClaim(current, claim)) {
            current!.jobId = jobId;
            return true;
          }
          return current?.jobId === jobId;
        },
        BACKGROUND_LOCK_WAIT_MS,
      );
    } catch (err) {
      reason = errorMessage(err);
    }
    if (!linked) this.logger.log("warn", "chat_job_link_failed", { threadId, localId: jobId, purpose, error: reason });
    return { linked, reason };
  }

  private linkFailedMessage(threadId: string, jobId: string, reason: string): string {
    return (
      `Job ${jobId} was submitted, but it could not be linked to ${threadId} (${reason}). ` +
      `While the thread still waits for it, a later check links it automatically. Do not resubmit before checking /batch show ${jobId}.`
    );
  }

  /**
   * The chat job a claim created, if there is one: same thread, purpose and `throughSeq`, created at or after the
   * claim. A claim whose job exists must never be expired as "never submitted": that job may be live and billed.
   * `uncertain`: a manifest from the claim's day or later could not be read, so the job may exist but be hidden.
   */
  private claimJob(threadId: string, purpose: "turn" | "compact", claim: Pending | Compacting): { job?: JobManifest; uncertain: boolean } {
    const since = isoToEpochMs(claim.claimedAt);
    const { jobs, unreadable } = this.deps.batch.registry.list();
    const job = jobs
      .filter((j) => j.chat?.threadId === threadId && j.chat.purpose === purpose && j.chat.throughSeq === claim.throughSeq && isoToEpochMs(j.createdAt) >= since)
      .sort((a, b) => isoToEpochMs(a.createdAt) - isoToEpochMs(b.createdAt))[0];
    const claimDay = claim.claimedAt.slice(0, 10).replace(/-/g, "");
    const uncertain = unreadable.some((u) => (/^B-(\d{8})-/.exec(u.localId)?.[1] ?? "") >= claimDay);
    return { job, uncertain };
  }

  /**
   * A stale claim with no job ID. Adopts the job it created if one exists (`adopted`: the claim as linked). `expire`
   * is true only when no such job exists, so the caller may record "never submitted". While a manifest that could be
   * that job is unreadable, expiry waits up to READ_FAILURE_TICKS ticks.
   */
  private adoptStale(threadId: string, purpose: "turn" | "compact", claim: Pending | Compacting): { adopted?: Pending | Compacting; expire: boolean } {
    const { job, uncertain } = this.claimJob(threadId, purpose, claim);
    const key = `claim:${threadId}:${purpose}:${claim.claimedAt}`;
    if (!job) {
      if (uncertain && this.transientFailure(key) < READ_FAILURE_TICKS) {
        this.logger.log("warn", "chat_claim_expiry_deferred", { threadId, purpose, reason: "unreadable manifests" });
        return { expire: false };
      }
      this.readFailures.delete(key);
      return { expire: true };
    }
    this.readFailures.delete(key);
    const { linked } = this.linkClaim(threadId, purpose, claim, job.localId);
    if (!linked) return { expire: false };
    this.logger.log("warn", "chat_claim_adopted", { threadId, purpose, localId: job.localId });
    return { expire: false, adopted: { ...claim, jobId: job.localId } };
  }

  /** Counts one more consecutive transient failure for `key` (in memory only) and returns the count. */
  private transientFailure(key: string): number {
    const n = (this.readFailures.get(key) ?? 0) + 1;
    this.readFailures.set(key, n);
    return n;
  }

  /**
   * Reads a linked job for the tick. A missing job is a failure at once; any other read error (Windows EBUSY/EPERM
   * surface as CorruptManifestError) is retried on later ticks, and only becomes a failure after READ_FAILURE_TICKS
   * consecutive ticks. Returns `failure` when the caller should record one.
   */
  private readLinkedJob(threadId: string, jobId: string): { job?: JobManifest; failure?: string } {
    try {
      const job = this.deps.batch.registry.read(jobId);
      this.readFailures.delete(jobId);
      return { job };
    } catch (err) {
      if (err instanceof JobNotFoundError) return { failure: errorMessage(err) };
      const n = this.transientFailure(jobId);
      if (n >= READ_FAILURE_TICKS) {
        this.readFailures.delete(jobId);
        return { failure: `${errorMessage(err)}; failed on ${n} consecutive checks` };
      }
      this.logger.log("warn", "chat_job_read_retry", { threadId, localId: jobId, attempt: n, error: errorMessage(err) });
      return {};
    }
  }

  /**
   * Records a failed turn: clears the claim (only if it is still `claim`; with no claim, only if nothing is pending),
   * sets `lastFailure` and appends a failure entry. Never throws: if the thread stays locked, a claim is left to
   * expire as stale.
   */
  private recordFailure(threadId: string, claim: Pending | undefined, message: string, jobId?: string, code?: string): void {
    try {
      const recorded = this.store.update(
        threadId,
        (t, append) => {
          if (claim ? !sameClaim(t.pending, claim) : t.pending) return false;
          this.fail(t, append, message, jobId, code);
          return true;
        },
        BACKGROUND_LOCK_WAIT_MS,
      );
      if (recorded) this.logger.log("warn", "chat_turn_failed", { threadId, localId: jobId });
    } catch (err) {
      this.logger.log("error", "chat_record_failure_failed", { threadId, localId: jobId, error: errorMessage(err) });
    }
  }

  private fail(t: ThreadState, append: Append, message: string, jobId?: string, code?: string): void {
    delete t.pending;
    const ids = { ...(jobId ? { jobId } : {}), ...(code ? { code } : {}) };
    t.lastFailure = { purpose: "turn", ...ids, message, at: nowIso() };
    append({ type: "failure", purpose: "turn", ...ids, message });
  }

  /**
   * What a settled chat job produced: item 1 (the reply or the summary) and the optional title item. Reads only the
   * job's own (immutable once terminal) files.
   */
  private jobOutcome(job: JobManifest): { reply?: { text: string; finishReason?: string }; title?: string; error: string; code?: string } {
    const compact = job.chat?.purpose === "compact";
    const what = compact ? "summary" : "reply";
    const next = compact ? "The thread is unchanged." : "Use /batch chat retry.";
    if (job.localStatus !== "ready" && job.localStatus !== "partial") {
      const code = job.error?.code;
      if (code === SUBMISSION_UNKNOWN && !compact) {
        return { code, error: `The ${what} job ${job.localId} ended ${job.localStatus}: OpenRouter may or may not have accepted it. ${SUBMISSION_UNKNOWN_ADVICE}` };
      }
      return { ...(code ? { code } : {}), error: `The ${what} job ${job.localId} ended ${job.localStatus}${job.error ? `: ${job.error.message}` : ""}. ${next}` };
    }
    const registry = this.deps.batch.registry;
    const items = jobItems(registry, job);
    const replyItem = items.find((i) => i.ordinal === 1);
    const text = replyItem && isUsable(replyItem) ? itemText(registry, job, replyItem)?.trimEnd() : undefined;
    // An empty summary would silently drop the conversation it replaces.
    if (!replyItem || text === undefined || (compact && text.trim() === "")) {
      return { error: `The ${what} in job ${job.localId} failed${replyItem?.error ? `: ${replyItem.error.message}` : ""}. ${next}` };
    }
    let title: string | undefined;
    if (job.chat?.titleItem) {
      const titleItem = items.find((i) => i.ordinal === 2);
      const raw = titleItem && isUsable(titleItem) ? itemText(registry, job, titleItem) : undefined;
      title = raw !== undefined ? cleanTitle(raw) : undefined;
      if (!title) this.logger.log("info", "chat_title_unusable", { localId: job.localId, threadId: job.chat.threadId });
    }
    return { reply: { text, ...(replyItem.finishReason ? { finishReason: replyItem.finishReason } : {}) }, title, error: "" };
  }

  /** Applies a terminal turn job to its thread. Returns true when a reply was appended. Never throws. */
  private settle(job: JobManifest): boolean {
    const chat = job.chat;
    if (!chat || !TERMINAL_STATUSES.has(job.localStatus)) return false;
    if (chat.purpose === "compact") {
      this.settleCompaction(job);
      return false;
    }
    const threadId = chat.threadId;
    try {
      // Cheap pre-check; the decision is re-made under the lock.
      if (this.store.read(threadId).pending?.jobId !== job.localId) return false;
      const outcome = this.jobOutcome(job);
      const replied = this.store.update(
        threadId,
        (t, append) => {
          if (t.pending?.jobId !== job.localId) return false;
          if (!outcome.reply) {
            this.fail(t, append, outcome.error, job.localId, outcome.code);
            return false;
          }
          append({
            type: "assistant",
            text: outcome.reply.text,
            model: job.model,
            jobId: job.localId,
            ...(outcome.reply.finishReason ? { finishReason: outcome.reply.finishReason } : {}),
            throughSeq: t.pending.throughSeq,
          });
          delete t.pending;
          applyAutoTitle(t, append, outcome.title);
          return true;
        },
        BACKGROUND_LOCK_WAIT_MS,
      );
      this.logger.log(replied ? "info" : "warn", replied ? "chat_reply_appended" : "chat_turn_failed", { threadId, localId: job.localId });
      if (replied) this.afterReply(threadId);
      return replied;
    } catch (err) {
      // Left pending; the next tick retries.
      this.logger.log("warn", "chat_settle_failed", { threadId, localId: job.localId, error: errorMessage(err) });
      return false;
    }
  }

  /**
   * Automatic compaction, after a reply is appended: starts one in the background when the next request is over
   * `chat.autoCompactTokens` and there is something to compact. A failed compaction is not retried until the next
   * reply. Never throws and never delays the send of queued messages.
   */
  private afterReply(threadId: string): void {
    const { chat } = this.deps.getConfig();
    if (!chat.autoCompact) return;
    try {
      const thread = this.store.read(threadId);
      if (thread.compacting) return;
      if (this.nextRequestEstimate(threadId).tokens <= chat.autoCompactTokens) return;
      const entries = conversationOrder(this.store.transcript(threadId).entries);
      if (compactionBoundary(thread, entries, chat.keepRecentExchanges) === undefined) return;
    } catch (err) {
      this.logger.log("warn", "chat_auto_compact_failed", { threadId, error: errorMessage(err) });
      return;
    }
    void this.startCompaction(threadId, undefined, BACKGROUND_LOCK_WAIT_MS).then(
      (r) => this.logger.log(r.jobId ? "info" : "warn", r.jobId ? "chat_auto_compact_started" : "chat_auto_compact_failed", { threadId, localId: r.jobId }),
      (err: unknown) => this.logger.log("warn", "chat_auto_compact_failed", { threadId, error: errorMessage(err) }),
    );
  }

  /**
   * Claims the thread for a compaction through the current boundary, then submits it. Throws "Already compacting" or
   * "Nothing to compact yet" (or a lock error) before anything is claimed; after the claim it never throws.
   */
  private async startCompaction(threadId: string, instructions: string | undefined, lockWaitMs?: number): Promise<{ jobId?: string; error?: string }> {
    const keep = this.deps.getConfig().chat.keepRecentExchanges;
    const claim = this.store.update(
      threadId,
      (t) => {
        if (t.compacting) throw new Error(`Already compacting ${threadId}. The summary is applied when that job lands.`);
        const boundary = compactionBoundary(t, conversationOrder(this.store.transcript(threadId).entries), keep);
        if (boundary === undefined) {
          throw new Error(`Nothing to compact yet in ${threadId}: the ${keep} most recent exchanges are always sent in full.`);
        }
        t.compacting = { throughSeq: boundary, claimedAt: nowIso(), ...(instructions ? { instructions } : {}) };
        return { ...t.compacting };
      },
      lockWaitMs,
    );
    let jobId: string | undefined;
    try {
      const thread = this.store.read(threadId);
      const entries = conversationOrder(this.store.transcript(threadId).entries);
      const prompt: ChatPrompt = { systemPrompt: this.deps.getConfig().chat.systemPrompt };
      const job = await this.deps.batch.createChatJob({
        threadId,
        purpose: "compact",
        throughSeq: claim.throughSeq,
        model: thread.model,
        account: thread.account,
        route: thread.route ?? routeForModel(thread.model),
        privacyLevel: effectiveLevelOf(this.deps.getConfig().privacy.level, thread.privacyLevel),
        ...(thread.providerPin ? { pin: thread.providerPin } : {}),
        main: buildCompactionMessages(thread, entries, claim.throughSeq, prompt, claim.instructions),
        ...(!thread.titleLocked ? { title: buildTitleMessages(thread, entries, Number.MAX_SAFE_INTEGER) } : {}),
      });
      jobId = job.localId;
      if (job.localStatus === "failed") throw new Error(job.error?.message ?? "the provider rejected the batch");
    } catch (err) {
      const message = `The compaction could not be submitted${jobId ? ` (job ${jobId})` : ""}: ${errorMessage(err)}. The thread is unchanged.`;
      this.recordCompactionFailure(threadId, claim, message, jobId);
      return { error: message };
    }
    const link = this.linkClaim(threadId, "compact", claim, jobId!);
    if (!link.linked) return { error: this.linkFailedMessage(threadId, jobId!, link.reason) };
    this.applyIfSettled(jobId!);
    return { jobId };
  }

  /**
   * Records a failed compaction: clears the claim (only if it is still `claim`) and appends a failure entry. The
   * summary and `lastFailure` are untouched, so sending carries on as before. Never throws.
   */
  private recordCompactionFailure(threadId: string, claim: Compacting, message: string, jobId?: string): void {
    try {
      const recorded = this.store.update(
        threadId,
        (t, append) => {
          if (!sameClaim(t.compacting, claim)) return false;
          delete t.compacting;
          append({ type: "failure", purpose: "compact", ...(jobId ? { jobId } : {}), message });
          return true;
        },
        BACKGROUND_LOCK_WAIT_MS,
      );
      if (recorded) this.logger.log("warn", "chat_compaction_failed", { threadId, localId: jobId });
    } catch (err) {
      this.logger.log("error", "chat_record_failure_failed", { threadId, localId: jobId, error: errorMessage(err) });
    }
  }

  /**
   * Applies a terminal compaction job. The summary is adopted only if it covers more than the current one; a
   * compaction entry is appended either way. A failed job leaves the summary as it was. Never throws.
   */
  private settleCompaction(job: JobManifest): void {
    const chat = job.chat!;
    const threadId = chat.threadId;
    try {
      if (this.store.read(threadId).compacting?.jobId !== job.localId) return;
      const outcome = this.jobOutcome(job);
      const adopted = this.store.update(
        threadId,
        (t, append) => {
          if (t.compacting?.jobId !== job.localId) return undefined;
          const { instructions } = t.compacting;
          delete t.compacting;
          if (!outcome.reply) {
            append({ type: "failure", purpose: "compact", jobId: job.localId, message: outcome.error });
            return false;
          }
          const text = outcome.reply.text;
          const adopt = !t.summary || t.summary.throughSeq < chat.throughSeq;
          if (adopt) t.summary = { text, throughSeq: chat.throughSeq, jobId: job.localId };
          append({ type: "compaction", summary: text, throughSeq: chat.throughSeq, jobId: job.localId, model: job.model, ...(instructions ? { instructions } : {}) });
          applyAutoTitle(t, append, outcome.title);
          return adopt;
        },
        BACKGROUND_LOCK_WAIT_MS,
      );
      if (adopted !== undefined) {
        const event = !outcome.reply ? "chat_compaction_failed" : adopted ? "chat_summary_adopted" : "chat_summary_stale";
        this.logger.log(outcome.reply ? "info" : "warn", event, { threadId, localId: job.localId });
      }
    } catch (err) {
      // Left compacting; the next tick retries.
      this.logger.log("warn", "chat_settle_failed", { threadId, localId: job.localId, error: errorMessage(err) });
    }
  }

  private async tickThread(thread: ThreadState): Promise<void> {
    const staleMs = staleClaimMs(this.deps.getConfig());
    const isStale = (claim: Pending | Compacting) => Date.now() - isoToEpochMs(claim.claimedAt) > staleMs;
    let c = thread.compacting;
    if (c && !c.jobId && isStale(c)) {
      const r = this.adoptStale(thread.id, "compact", c);
      if (r.adopted) c = r.adopted;
      else if (r.expire) {
        this.recordCompactionFailure(thread.id, c, "The compaction was never submitted (Pi stopped while sending it). The thread is unchanged.");
      }
    }
    let p = thread.pending;
    if (p && !p.jobId && isStale(p)) {
      const r = this.adoptStale(thread.id, "turn", p);
      if (r.adopted) p = r.adopted;
      else if (r.expire) this.recordFailure(thread.id, p, "The turn was never submitted (Pi stopped while sending it). Use /batch chat retry.");
    }
    if (c?.jobId) {
      const { job, failure } = this.readLinkedJob(thread.id, c.jobId);
      if (failure) this.recordCompactionFailure(thread.id, c, `The compaction job ${c.jobId} can no longer be read (${failure}). The thread is unchanged.`, c.jobId);
      if (job && TERMINAL_STATUSES.has(job.localStatus)) this.settleCompaction(job);
    }
    if (p?.jobId) {
      const { job, failure } = this.readLinkedJob(thread.id, p.jobId);
      if (failure) this.recordFailure(thread.id, p, `The reply job ${p.jobId} can no longer be read (${failure}). Use /batch chat retry.`, p.jobId);
      if (job && TERMINAL_STATUSES.has(job.localStatus)) this.settle(job);
    }
    // A reply settled here starts automatic compaction too (settle calls afterReply).
    await this.sendUnsent(thread.id);
  }

  /** Sends unsent messages as one turn if the thread is idle (no pending turn, no failure). Returns the job ID. */
  private async sendUnsent(threadId: string): Promise<string | undefined> {
    const thread = this.store.read(threadId);
    if (thread.pending || thread.lastFailure || unsentUserSeqs(this.store.transcript(threadId).entries).length === 0) return undefined;
    let prompt: ChatPrompt;
    try {
      prompt = await this.checkedPrompt(thread.account);
    } catch (err) {
      if (!(err instanceof ChatBlockedError)) throw err;
      this.recordFailure(threadId, undefined, err.message);
      return undefined;
    }
    const claim = this.store.update(threadId, (t) => this.claim(t, this.store.transcript(threadId).entries), BACKGROUND_LOCK_WAIT_MS);
    if (!claim) return undefined;
    return (await this.submitTurn(threadId, claim, prompt)).jobId;
  }

  /** Fire-and-forget `sendUnsent`; any error becomes a failure entry (or a log line), never an unhandled rejection. */
  private sendInBackground(threadId: string): void {
    void this.sendUnsent(threadId).catch((err: unknown) => {
      this.logger.log("warn", "chat_send_queued_failed", { threadId, error: errorMessage(err) });
      this.recordFailure(threadId, undefined, `The queued messages could not be sent: ${errorMessage(err)}. Use /batch chat retry.`);
    });
  }
}
