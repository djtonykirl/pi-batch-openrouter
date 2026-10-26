import * as fs from "node:fs";
import * as path from "node:path";
import type { BatchConfig } from "../config.js";
import { formatSecretFindings, scanForSecrets } from "../context/secrets.js";
import { isUsable, itemText, jobItems } from "../items.js";
import { nullLogger, type Logger } from "../logger.js";
import { normalizeBatchModelSlug } from "../models.js";
import type { BatchService } from "../service.js";
import { TERMINAL_STATUSES } from "../state.js";
import { isoToEpochMs, nowIso } from "../time.js";
import type { JobManifest } from "../types.js";
import {
  buildTitleMessages,
  buildTurnMessages,
  cleanTitle,
  conversationOrder,
  estimateTokens,
  provisionalTitle,
  type ChatPrompt,
} from "./request.js";
import type { ThreadStore } from "./store.js";
import type { ThreadState, TranscriptEntry, TranscriptEntryInput } from "./types.js";

/** Project instructions (the CLAUDE.md equivalent), relative to the workspace root. */
export const PROJECT_INSTRUCTIONS_FILE = ".pi/BATCH_CHAT.md";
/** A claim with no job after this long was left behind by a process that stopped mid-send. */
const STALE_CLAIM_MS = 120_000;
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

function sameClaim(p: Pending | undefined, claim: Pending): boolean {
  return p !== undefined && p.throughSeq === claim.throughSeq && p.claimedAt === claim.claimedAt && p.jobId === claim.jobId;
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

  /**
   * Scans, then appends the message. If the thread is idle, submits it (with any earlier unsent messages) as a turn;
   * otherwise it stays queued. A secret refuses the message before anything is written (ChatBlockedError), and a
   * held thread lock propagates as ThreadBusyError with nothing written.
   */
  public async send(threadId: string, text: string): Promise<{ queued: boolean; jobId?: string }> {
    if (text.trim() === "") return { queued: true };
    const thread = this.store.read(threadId);
    const prompt = await this.checkedPrompt(thread.account, text);
    const claim = this.store.update(threadId, (t, append) => {
      const entries = this.store.transcript(threadId).entries;
      const entry = append({ type: "user", text });
      if (t.title === "(untitled)") t.title = provisionalTitle(text);
      return this.claim(t, [...entries, entry]);
    });
    if (!claim) return { queued: true };
    const r = await this.submitTurn(threadId, claim, prompt);
    return { queued: false, ...(r.jobId ? { jobId: r.jobId } : {}) };
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

  /** Clears the last failure and sends every unsent message as one turn. Returns the new job ID. */
  public async retry(threadId: string): Promise<string> {
    const nothing = `Nothing to retry: the last turn in ${threadId} did not fail.`;
    const thread = this.store.read(threadId);
    if (!thread.lastFailure) throw new Error(nothing);
    const prompt = await this.checkedPrompt(thread.account);
    const claim = this.store.update(threadId, (t) => {
      if (!t.lastFailure) throw new Error(nothing);
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

  /** Changes the model from the next turn on. A reply already pending keeps the model it was sent with. */
  public setModel(threadId: string, slug: string): void {
    const to = normalizeBatchModelSlug(slug.trim());
    if (!to) throw new Error("Model slug is empty.");
    this.store.update(threadId, (t, append) => {
      if (t.model === to) return;
      append({ type: "model", from: t.model, to });
      t.model = to;
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
        ...(thread.providerPin ? { pin: thread.providerPin } : {}),
        main: buildTurnMessages(thread, entries, claim.throughSeq, prompt),
        ...(retitle ? { title: buildTitleMessages(thread, entries, claim.throughSeq) } : {}),
      });
      jobId = job.localId;
      if (job.localStatus === "failed") throw new Error(job.error?.message ?? "the provider rejected the batch");
    } catch (err) {
      const message = `The turn could not be submitted${jobId ? ` (job ${jobId})` : ""}: ${errorMessage(err)}`;
      this.recordFailure(threadId, claim, message, jobId);
      return { error: message };
    }
    try {
      this.store.update(
        threadId,
        (t) => {
          if (sameClaim(t.pending, claim)) t.pending!.jobId = jobId;
        },
        BACKGROUND_LOCK_WAIT_MS,
      );
    } catch (err) {
      // The claim stays without a job ID and expires as stale; the message is safe in the transcript.
      this.logger.log("warn", "chat_job_link_failed", { threadId, localId: jobId, error: errorMessage(err) });
    }
    return { jobId };
  }

  /**
   * Records a failed turn: clears the claim (only if it is still `claim`; with no claim, only if nothing is pending),
   * sets `lastFailure` and appends a failure entry. Never throws: if the thread stays locked, a claim is left to
   * expire as stale.
   */
  private recordFailure(threadId: string, claim: Pending | undefined, message: string, jobId?: string): void {
    try {
      const recorded = this.store.update(
        threadId,
        (t, append) => {
          if (claim ? !sameClaim(t.pending, claim) : t.pending) return false;
          this.fail(t, append, message, jobId);
          return true;
        },
        BACKGROUND_LOCK_WAIT_MS,
      );
      if (recorded) this.logger.log("warn", "chat_turn_failed", { threadId, localId: jobId });
    } catch (err) {
      this.logger.log("error", "chat_record_failure_failed", { threadId, localId: jobId, error: errorMessage(err) });
    }
  }

  private fail(t: ThreadState, append: Append, message: string, jobId?: string): void {
    delete t.pending;
    t.lastFailure = { purpose: "turn", ...(jobId ? { jobId } : {}), message, at: nowIso() };
    append({ type: "failure", purpose: "turn", ...(jobId ? { jobId } : {}), message });
  }

  /** What a settled turn job produced. Reads only the job's own (immutable once terminal) files. */
  private turnOutcome(job: JobManifest): { reply?: { text: string; finishReason?: string }; title?: string; error: string } {
    if (job.localStatus !== "ready" && job.localStatus !== "partial") {
      return { error: `The reply job ${job.localId} ended ${job.localStatus}${job.error ? `: ${job.error.message}` : ""}. Use /batch chat retry.` };
    }
    const registry = this.deps.batch.registry;
    const items = jobItems(registry, job);
    const replyItem = items.find((i) => i.ordinal === 1);
    const text = replyItem && isUsable(replyItem) ? itemText(registry, job, replyItem)?.trimEnd() : undefined;
    if (!replyItem || text === undefined) {
      return { error: `The reply in job ${job.localId} failed${replyItem?.error ? `: ${replyItem.error.message}` : ""}. Use /batch chat retry.` };
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
    if (chat.purpose !== "turn") return false; // compaction jobs: Task 6
    const threadId = chat.threadId;
    try {
      // Cheap pre-check; the decision is re-made under the lock.
      if (this.store.read(threadId).pending?.jobId !== job.localId) return false;
      const outcome = this.turnOutcome(job);
      const replied = this.store.update(
        threadId,
        (t, append) => {
          if (t.pending?.jobId !== job.localId) return false;
          if (!outcome.reply) {
            this.fail(t, append, outcome.error, job.localId);
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
          if (outcome.title && !t.titleLocked) {
            t.title = outcome.title;
            t.retitled = true;
            append({ type: "title", title: outcome.title, source: "auto" });
          }
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

  /** Hook after a reply is appended. Task 6 fills this in (automatic compaction). */
  private afterReply(_threadId: string): void {}

  private async tickThread(thread: ThreadState): Promise<void> {
    const p = thread.pending;
    if (p?.jobId) {
      let job: JobManifest | undefined;
      try {
        job = this.deps.batch.registry.read(p.jobId);
      } catch (err) {
        this.recordFailure(thread.id, p, `The reply job ${p.jobId} can no longer be read (${errorMessage(err)}). Use /batch chat retry.`, p.jobId);
      }
      if (job && TERMINAL_STATUSES.has(job.localStatus)) this.settle(job);
    } else if (p && Date.now() - isoToEpochMs(p.claimedAt) > STALE_CLAIM_MS) {
      this.recordFailure(thread.id, p, "The turn was never submitted (Pi stopped while sending it). Use /batch chat retry.");
    }
    await this.sendUnsent(thread.id);
    // Task 6: automatic compaction runs here too.
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
