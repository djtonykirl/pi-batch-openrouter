import * as fs from "node:fs";
import * as path from "node:path";
import type { BatchConfig } from "./config.js";
import { buildContextPackage, SYSTEM_PROMPT, type ContextPackage, type PackageInput } from "./context/package.js";
import { formatSecretFindings, scanForSecrets } from "./context/secrets.js";
import { atomicWriteFile, atomicWriteJson, canonicalJson, sha256Hex, writeOnce } from "./fsutil.js";
import { customIdFor } from "./ids.js";
import { nullLogger, type Logger } from "./logger.js";
import { normalizeBatchModelSlug } from "./models.js";
import { OpenRouterBatchClient, OpenRouterError, type RawExchange } from "./openrouter/client.js";
import { normaliseBatchResult, type NormalisedBatchResult } from "./openrouter/normalise-result.js";
import { buildSubmitBody, type ChatMessage, type ProviderPin, type SubmitBody } from "./openrouter/types.js";
import { JobRegistry, JobUpdate } from "./registry.js";
import { ACTIVE_STATUSES, POLLABLE_STATUSES, TERMINAL_STATUSES, type LocalStatus } from "./state.js";
import { formatIsoShort, isoToEpochMs, nowIso, parseProviderTimestamp } from "./time.js";
import type { JobManifest } from "./types.js";

export interface AskOptions {
  objective: string;
  files: string[];
  contexts: string[];
  model?: string;
  account?: string;
  /** Upstream provider slug to pin via `provider.only` (with allow_fallbacks: false). */
  providerPin?: string;
  format: "markdown" | "json";
  includeInstructions: boolean;
}

export interface PreparedAsk {
  options: AskOptions;
  model: string;
  account: string;
  pin?: ProviderPin;
  pkg: ContextPackage;
  messages: ChatMessage[];
  contentSha256: string;
  /** Reasons the request must not be submitted (empty = OK). */
  blockers: string[];
}

export class SubmissionBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubmissionBlockedError";
  }
}

export class DuplicateActiveRequestError extends Error {
  constructor(public readonly existingId: string) {
    super(`An identical active request already exists:\n  ${existingId}\n\nUse /batch show ${existingId}\n(Use /batch retry ${existingId} to deliberately run it again.)`);
    this.name = "DuplicateActiveRequestError";
  }
}

export type ReadMode = "default" | "full" | "raw";
export type InjectMode = "default" | "summary" | "full";

export interface ServiceDeps {
  registry: JobRegistry;
  workspaceRoot: string;
  getConfig(): BatchConfig;
  resolveApiKey(account: string): Promise<string>;
  createClient?: (apiKey: string, timeoutMs: number) => OpenRouterBatchClient;
  logger?: Logger;
  /** Called after any reconcile that moved a job into a terminal (or ready/partial) state. */
  onSettled?: (job: JobManifest) => void;
  /** For packaging tests only. */
  gitIgnored?: PackageInput["gitIgnored"];
}

export interface ReconcileOutcome {
  localId: string;
  status: LocalStatus;
  polled: boolean;
  skipped?: "not_due" | "locked" | "not_pollable";
  error?: string;
}

/** Statuses a reconcile pass visits: pollable ones plus crash-recovery states. */
const RECONCILE_STATUSES: ReadonlySet<LocalStatus> = new Set<LocalStatus>([...POLLABLE_STATUSES, "draft", "submitting", "retrieving"]);
/** A job stuck in draft/submitting this long with no lock holder was interrupted by a crash. */
const INTERRUPTED_AFTER_MS = 30_000;

export class BatchService {
  private readonly logger: Logger;

  constructor(private readonly deps: ServiceDeps) {
    this.logger = deps.logger ?? nullLogger;
  }

  public get registry(): JobRegistry {
    return this.deps.registry;
  }

  private client(apiKey: string): OpenRouterBatchClient {
    const timeoutMs = this.deps.getConfig().polling.requestTimeoutSeconds * 1000;
    return this.deps.createClient ? this.deps.createClient(apiKey, timeoutMs) : new OpenRouterBatchClient({ apiKey, timeoutMs });
  }

  private async knownSecrets(account: string): Promise<string[]> {
    const out = new Set<string>();
    const env = process.env.OPENROUTER_API_KEY;
    if (env) out.add(env);
    try {
      const key = await this.deps.resolveApiKey(account);
      if (key) out.add(key);
    } catch {
      // no key resolvable; nothing extra to protect
    }
    return [...out];
  }

  // ------------------------------------------------------------------ ask

  public async prepare(options: AskOptions): Promise<PreparedAsk> {
    const config = this.deps.getConfig();
    const objective = options.objective.trim();
    const model = normalizeBatchModelSlug(options.model ?? config.defaultModel);
    const account = options.account ?? config.defaultAccount;
    const pin: ProviderPin | undefined = options.providerPin ? { only: [options.providerPin], allow_fallbacks: false } : undefined;
    const pkg = buildContextPackage({
      workspaceRoot: this.deps.workspaceRoot,
      objective,
      files: options.files,
      contexts: options.contexts,
      includeInstructions: options.includeInstructions,
      format: options.format,
      config,
      knownSecrets: await this.knownSecrets(account),
      gitIgnored: this.deps.gitIgnored,
    });
    const messages: ChatMessage[] = options.includeInstructions
      ? [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: pkg.contextText },
        ]
      : [{ role: "user", content: pkg.contextText }];

    const blockers: string[] = [];
    if (!objective) blockers.push("objective is empty");
    for (const p of pkg.problems) blockers.push(p.message);
    if (pkg.secretFindings.length > 0 && config.security.blockOnSecret) blockers.push(formatSecretFindings(pkg.secretFindings));

    const template = this.buildBody(model, pin, messages, ["{custom_id}"]);
    return { options, model, account, pin, pkg, messages, contentSha256: contentHash(template), blockers };
  }

  private buildBody(model: string, pin: ProviderPin | undefined, messages: ChatMessage[], customIds: string[]): SubmitBody {
    const maxTokens = this.deps.getConfig().request.maxTokens;
    return buildSubmitBody({
      model,
      provider: pin,
      requests: customIds.map((custom_id) => ({ custom_id, body: { messages, max_tokens: maxTokens } })),
    });
  }

  public findActiveDuplicate(contentSha256: string, excludeId?: string): JobManifest | undefined {
    return this.registry
      .list()
      .jobs.find((j) => j.localId !== excludeId && j.contentSha256 === contentSha256 && ACTIVE_STATUSES.has(j.localStatus));
  }

  /**
   * Persist the prepared request as a job (draft -> previewed) and, unless
   * `previewOnly`, submit it. Nothing is persisted if the package is blocked.
   */
  public async createJob(prepared: PreparedAsk, opts: { previewOnly: boolean }): Promise<JobManifest> {
    if (prepared.blockers.length > 0) throw new SubmissionBlockedError(prepared.blockers.join("\n\n"));
    if (!opts.previewOnly) {
      const dup = this.findActiveDuplicate(prepared.contentSha256);
      if (dup) throw new DuplicateActiveRequestError(dup.localId);
    }
    const config = this.deps.getConfig();
    const { pkg } = prepared;

    const job = this.registry.create((localId) => {
      const customIds = [customIdFor(localId, 0)];
      const body = this.buildBody(prepared.model, prepared.pin, prepared.messages, customIds);
      const bodyText = JSON.stringify(body, null, 2);
      const requestSha256 = sha256Hex(bodyText);
      atomicWriteFile(this.registry.artefact(localId, "objective"), prepared.options.objective.trim() + "\n");
      atomicWriteFile(this.registry.artefact(localId, "context"), pkg.contextText);
      atomicWriteJson(this.registry.artefact(localId, "contextManifest"), {
        workspaceRoot: this.deps.workspaceRoot,
        files: pkg.files.map(({ content: _c, ...rest }) => rest),
        excluded: pkg.excluded,
        warnings: pkg.warnings,
        characters: pkg.characters,
        secretScan: { enabled: config.security.scanSecrets, findings: pkg.secretFindings.length },
        includeInstructions: prepared.options.includeInstructions,
        format: prepared.options.format,
      });
      atomicWriteFile(this.registry.artefact(localId, "submittedRequest"), bodyText);
      atomicWriteFile(this.registry.artefact(localId, "requestSha"), `${requestSha256}  submitted-request.json\n`);
      return {
        schemaVersion: 1,
        localId,
        retryCount: 0,
        objective: prepared.options.objective.trim(),
        model: prepared.model,
        provider: "openrouter",
        account: prepared.account,
        ...(prepared.pin ? { providerPin: prepared.pin } : {}),
        endpoint: "/v1/chat/completions",
        format: prepared.options.format,
        localStatus: "draft",
        requestCount: customIds.length,
        customIds,
        createdAt: nowIso(),
        pollAttempts: 0,
        consecutivePollFailures: 0,
        requestSha256,
        contentSha256: prepared.contentSha256,
        context: { fileCount: pkg.files.length, characters: pkg.characters, excludedCount: pkg.excluded.length },
        injectionCount: 0,
        warnings: [...pkg.warnings],
      };
    });
    this.registry.update(job.localId, (u) => u.transition("previewed", { files: pkg.files.length, characters: pkg.characters }));
    this.logger.log("info", "job_created", { localId: job.localId, files: pkg.files.length, characters: pkg.characters });
    if (opts.previewOnly) return this.registry.read(job.localId);
    return this.submit(job.localId, { skipDuplicateCheck: true });
  }

  /** previewed -> submitting -> submitted | failed. Persists `submitting` BEFORE the HTTP call. */
  public async submit(localId: string, opts: { skipDuplicateCheck?: boolean } = {}): Promise<JobManifest> {
    const lock = this.registry.lock(localId);
    try {
      const job = this.registry.read(localId);
      if (job.localStatus !== "previewed") {
        throw new Error(`Job ${localId} is ${job.localStatus}; only previewed jobs can be submitted.`);
      }
      if (!opts.skipDuplicateCheck && job.contentSha256) {
        const dup = this.findActiveDuplicate(job.contentSha256, localId);
        if (dup) throw new DuplicateActiveRequestError(dup.localId);
      }
      const apiKey = await this.deps.resolveApiKey(job.account);
      if (!apiKey) {
        throw new Error(`Missing API key for account "${job.account}". Configure it in Pi (auth.json) or set OPENROUTER_API_KEY. Job ${localId} stays previewed.`);
      }
      const bodyText = fs.readFileSync(this.registry.artefact(localId, "submittedRequest"), "utf8");
      if (sha256Hex(bodyText) !== job.requestSha256) {
        throw new Error(`Job ${localId}: submitted-request.json no longer matches request.sha256; refusing to submit.`);
      }
      this.registry.update(localId, (u) => u.transition("submitting"));
      this.logger.log("info", "submit_start", { localId, model: job.model });

      try {
        const { raw, batch } = await this.client(apiKey).submit(JSON.parse(bodyText) as SubmitBody, bodyText);
        writeOnce(this.registry.artefact(localId, "submissionResponse"), raw.bodyText);
        const config = this.deps.getConfig();
        return this.registry.update(localId, (u) => {
          const m = u.manifest;
          m.providerBatchId = batch.id;
          m.providerStatus = batch.status;
          m.submittedAt = nowIso();
          this.applyProviderTimestamps(u, batch.createdAt, batch.finalizedAt);
          m.nextPollAt = new Date(Date.now() + config.polling.intervalSeconds * 1000).toISOString();
          u.transition("submitted", { providerBatchId: batch.id, providerStatus: batch.status, httpStatus: raw.status });
          this.logger.log("info", "submit_accepted", { localId, providerBatchId: batch.id, providerStatus: batch.status, httpStatus: raw.status });
          return m;
        });
      } catch (err) {
        return this.recordSubmitFailure(localId, err);
      }
    } finally {
      lock.release();
    }
  }

  private recordSubmitFailure(localId: string, err: unknown): JobManifest {
    let code = "internal_error";
    let message = err instanceof Error ? err.message : String(err);
    const details: Record<string, unknown> = {};
    if (err instanceof OpenRouterError) {
      details.category = err.category;
      details.httpStatus = err.httpStatus;
      if (err.category === "network" || err.category === "timeout") {
        code = "submission_unknown";
        message =
          `No response from OpenRouter (${err.category}). The batch MAY have been accepted. ` +
          `Check your OpenRouter activity before using /batch retry, to avoid paying twice. Detail: ${err.detail}`;
      } else {
        code = `submission_rejected_${err.category}`;
        message = err.detail;
        if (err.rawBody) writeOnce(this.registry.artefact(localId, "submissionResponse"), err.rawBody);
      }
    }
    this.logger.log("error", "submit_failed", { localId, code, ...details });
    return this.registry.update(localId, (u) => {
      u.manifest.error = { code, message };
      u.transition("failed", { code, ...details });
      return u.manifest;
    });
  }

  private applyProviderTimestamps(u: JobUpdate, createdAt: unknown, finalizedAt: unknown): void {
    const m = u.manifest;
    const c = parseProviderTimestamp(createdAt);
    if (c.ok) m.providerCreatedAt = c.iso;
    else if (c.reason !== "missing") this.rejectTimestamp(u, "created_at", createdAt, c.reason);
    const f = parseProviderTimestamp(finalizedAt);
    if (f.ok) m.finalizedAt = f.iso;
    else if (f.reason !== "missing") this.rejectTimestamp(u, "finalized_at", finalizedAt, f.reason);
  }

  private rejectTimestamp(u: JobUpdate, field: string, value: unknown, reason: string): void {
    const warning = `provider ${field} rejected (${reason}): ${JSON.stringify(value)}`;
    if (!u.manifest.warnings.includes(warning)) {
      u.manifest.warnings.push(warning);
      u.note("timestamp_rejected", { field, value, reason });
    }
  }

  // ------------------------------------------------------------ reconcile

  public jobsNeedingReconcile(): JobManifest[] {
    return this.registry.list().jobs.filter((j) => RECONCILE_STATUSES.has(j.localStatus));
  }

  /**
   * One reconciliation step for one job: poll provider status, retrieve and
   * normalise results when complete, recover from interrupted local states.
   * Never overlaps for the same job (file lock, across processes).
   * A network failure here never marks the batch failed.
   */
  public async reconcile(localId: string, opts: { force?: boolean } = {}): Promise<ReconcileOutcome> {
    const lock = this.registry.tryLock(localId);
    if (!lock) return { localId, status: this.registry.read(localId).localStatus, polled: false, skipped: "locked" };
    try {
      return await this.reconcileLocked(localId, opts);
    } finally {
      lock.release();
    }
  }

  private async reconcileLocked(localId: string, opts: { force?: boolean }): Promise<ReconcileOutcome> {
    let job = this.registry.read(localId);
    const ageMs = Date.now() - isoToEpochMs(job.createdAt);

    // Crash recovery: we hold the lock, so no live process is mid-operation.
    if ((job.localStatus === "draft" || job.localStatus === "submitting") && ageMs > INTERRUPTED_AFTER_MS) {
      const wasSubmitting = job.localStatus === "submitting";
      job = this.registry.update(localId, (u) => {
        u.manifest.error = wasSubmitting
          ? {
              code: "submission_unknown",
              message:
                "Pi stopped while this job was being submitted; OpenRouter may or may not have accepted it. " +
                "Check your OpenRouter activity before using /batch retry.",
            }
          : { code: "creation_interrupted", message: "Pi stopped while this job was being created; nothing was submitted." };
        u.transition("failed", { recovered: true });
        return u.manifest;
      });
      this.logger.log("warn", "recovered_interrupted", { localId, from: wasSubmitting ? "submitting" : "draft" });
      this.deps.onSettled?.(job);
      return { localId, status: job.localStatus, polled: false };
    }
    if (job.localStatus === "retrieving") {
      // Interrupted mid-retrieval; go back and retrieve again (raw evidence is write-once, so nothing is lost).
      job = this.registry.update(localId, (u) => {
        u.transition("provider_completed", { recovered: true });
        return u.manifest;
      });
    }
    if (!POLLABLE_STATUSES.has(job.localStatus) || !job.providerBatchId) {
      return { localId, status: job.localStatus, polled: false, skipped: "not_pollable" };
    }
    if (!opts.force && job.nextPollAt && isoToEpochMs(job.nextPollAt) > Date.now()) {
      return { localId, status: job.localStatus, polled: false, skipped: "not_due" };
    }

    const config = this.deps.getConfig();
    let fetched: { raw: RawExchange; status: string; createdAt: unknown; finalizedAt: unknown; counts?: { total: number; completed: number; failed: number }; hasResults: boolean; paymentRequired?: boolean; errorMessage?: string };
    try {
      const apiKey = await this.deps.resolveApiKey(job.account);
      if (!apiKey) throw new OpenRouterError("auth", undefined, `no API key available for account "${job.account}"`, "get");
      const res = await this.client(apiKey).get(job.providerBatchId);
      fetched = {
        raw: res.raw,
        status: res.batch.status,
        createdAt: res.batch.createdAt,
        finalizedAt: res.batch.finalizedAt,
        counts: res.batch.requestCounts,
        hasResults: res.batch.hasResults,
        paymentRequired: res.paymentRequired,
        errorMessage: res.batch.errorMessage,
      };
    } catch (err) {
      return this.recordPollError(job, err);
    }

    atomicWriteFile(this.registry.artefact(localId, "latestStatus"), fetched.raw.bodyText);

    job = this.registry.update(localId, (u) => {
      const m = u.manifest;
      const providerChanged = m.providerStatus !== fetched.status;
      m.providerStatus = fetched.status;
      m.lastPollAt = nowIso();
      m.pollAttempts += 1;
      m.consecutivePollFailures = 0;
      delete m.lastPollError;
      if (fetched.counts) {
        m.completedCount = fetched.counts.completed;
        m.failedCount = fetched.counts.failed;
      }
      this.applyProviderTimestamps(u, fetched.createdAt, fetched.finalizedAt);
      m.nextPollAt = new Date(Date.now() + config.polling.intervalSeconds * 1000).toISOString();

      if (m.localStatus === "submitted") u.transition("polling", { providerStatus: fetched.status });
      const s = fetched.status;
      if (s === "completed") {
        // Already provider_completed when a previous retrieval found results unavailable (e.g. HTTP 402).
        if (m.localStatus !== "provider_completed") u.transition("provider_completed", { providerStatus: s, cancelRace: m.localStatus === "cancel_requested" || undefined });
      } else if (s === "failed") {
        m.error = { code: "provider_failed", message: fetched.errorMessage ?? "OpenRouter reported the batch as failed" };
        u.transition("failed", { providerStatus: s });
      } else if (s === "expired") {
        m.error = { code: "provider_expired", message: "OpenRouter did not complete the batch within its 24h window" };
        u.transition("expired", { providerStatus: s });
      } else if (s === "cancelled") {
        u.transition("cancelled", { providerStatus: s });
      } else if (providerChanged) {
        // validating / in_progress / finalizing / cancelling / unknown future values
        u.transition(m.localStatus === "cancel_requested" ? "cancel_requested" : "polling", { providerStatus: s });
      }
      return m;
    });
    this.logger.log("info", "poll_ok", { localId, providerBatchId: job.providerBatchId, providerStatus: fetched.status, localStatus: job.localStatus });

    if (job.localStatus === "provider_completed") {
      job = this.retrieve(job, fetched.raw, fetched.paymentRequired === true);
    }
    if (TERMINAL_STATUSES.has(job.localStatus)) this.deps.onSettled?.(job);
    return { localId, status: job.localStatus, polled: true };
  }

  private recordPollError(job: JobManifest, err: unknown): ReconcileOutcome {
    const config = this.deps.getConfig();
    const e = err instanceof OpenRouterError ? err : new OpenRouterError("protocol", undefined, String((err as Error)?.message ?? err), "get");
    // 410 Gone: OpenRouter purged results after its retention window — definitive provider evidence.
    if (e.category === "gone") {
      const updated = this.registry.update(job.localId, (u) => {
        u.manifest.error = { code: "results_gone", message: `OpenRouter no longer holds this batch's results (HTTP 410): ${e.detail}` };
        u.manifest.lastPollAt = nowIso();
        u.transition("failed", { httpStatus: 410 });
        return u.manifest;
      });
      this.logger.log("error", "poll_gone", { localId: job.localId, providerBatchId: job.providerBatchId });
      this.deps.onSettled?.(updated);
      return { localId: job.localId, status: updated.localStatus, polled: true, error: e.message };
    }
    // Everything else (network, timeout, 5xx, 429, auth, 404 with a possibly-wrong account key, bad JSON)
    // is recorded and retried with backoff; the local status is unchanged.
    const updated = this.registry.update(job.localId, (u) => {
      const m = u.manifest;
      m.consecutivePollFailures += 1;
      m.pollAttempts += 1;
      m.lastPollAt = nowIso();
      m.lastPollError = { category: e.category, message: e.detail, ...(e.httpStatus ? { httpStatus: e.httpStatus } : {}), at: nowIso() };
      const backoff = Math.min(config.polling.maxBackoffSeconds, config.polling.intervalSeconds * 2 ** (m.consecutivePollFailures - 1));
      m.nextPollAt = new Date(Date.now() + backoff * 1000).toISOString();
      u.note("poll_error", { category: e.category, httpStatus: e.httpStatus, consecutive: m.consecutivePollFailures, backoffSeconds: backoff });
      return m;
    });
    this.logger.log("warn", "poll_error", {
      localId: job.localId,
      providerBatchId: job.providerBatchId,
      category: e.category,
      httpStatus: e.httpStatus,
      attempt: updated.consecutivePollFailures,
    });
    return { localId: job.localId, status: updated.localStatus, polled: true, error: e.message };
  }

  /** provider_completed -> retrieving -> ready | partial | failed | corrupt | (back to provider_completed). */
  private retrieve(job: JobManifest, raw: RawExchange, paymentRequired: boolean): JobManifest {
    const localId = job.localId;
    this.registry.update(localId, (u) => u.transition("retrieving"));

    const normalised = normaliseBatchResult(raw.bodyText, {
      localJobId: localId,
      providerBatchId: job.providerBatchId!,
      expectedCustomIds: job.customIds,
    });

    if (normalised.outcome === "unavailable") {
      const config = this.deps.getConfig();
      return this.registry.update(localId, (u) => {
        const m = u.manifest;
        m.consecutivePollFailures += 1;
        const backoff = Math.min(config.polling.maxBackoffSeconds, config.polling.intervalSeconds * 2 ** (m.consecutivePollFailures - 1));
        m.nextPollAt = new Date(Date.now() + backoff * 1000).toISOString();
        m.lastPollError = {
          category: paymentRequired ? "payment" : "results_unavailable",
          message: paymentRequired
            ? "Batch completed but OpenRouter withheld results (HTTP 402: finalised cost exceeds balance). Top up credits; retrieval will retry."
            : "Batch completed but the response did not include results; retrieval will retry.",
          ...(paymentRequired ? { httpStatus: 402 } : {}),
          at: nowIso(),
        };
        u.transition("provider_completed", { reason: m.lastPollError.category });
        return m;
      });
    }

    // Raw evidence first (write-once), then normalised artefacts.
    const finalPath = writeOnce(this.registry.artefact(localId, "finalResponse"), raw.bodyText);
    this.writeResultArtefacts(job, normalised, finalPath);

    const next: LocalStatus = normalised.outcome;
    const updated = this.registry.update(localId, (u) => {
      const m = u.manifest;
      m.retrievedAt = nowIso();
      if (normalised.usage) m.usage = normalised.usage;
      m.completedCount = normalised.items.filter((i) => i.status === "completed").length;
      m.failedCount = normalised.items.filter((i) => i.status === "failed").length;
      for (const w of normalised.warnings) if (!m.warnings.includes(w)) m.warnings.push(w);
      if (next === "corrupt") {
        m.error = { code: "result_invalid", message: normalised.issues.join("; ") };
      } else if (next === "failed") {
        const first = normalised.items.find((i) => i.error)?.error;
        m.error = { code: first?.code ?? "all_requests_failed", message: first?.message ?? "every request in the batch failed" };
      } else if (next === "partial") {
        m.error = { code: "some_requests_failed", message: `${m.failedCount} of ${m.requestCount} request(s) failed` };
      } else {
        delete m.error;
      }
      u.transition(next, { finalResponse: path.basename(finalPath), issues: normalised.issues.length ? normalised.issues : undefined });
      return m;
    });
    this.logger.log(next === "ready" ? "info" : "warn", "retrieved", { localId, providerBatchId: job.providerBatchId, outcome: next });
    return updated;
  }

  private writeResultArtefacts(job: JobManifest, n: NormalisedBatchResult, finalPath: string): void {
    const items = n.items.map(({ raw: _raw, ...rest }) => rest);
    atomicWriteJson(this.registry.artefact(job.localId, "resultJson"), { ...n, items });
    atomicWriteJson(this.registry.artefact(job.localId, "resultMetadata"), {
      localId: job.localId,
      providerBatchId: job.providerBatchId,
      model: job.model,
      outcome: n.outcome,
      providerStatus: n.providerStatus,
      requestCounts: n.requestCounts,
      usage: n.usage,
      warnings: n.warnings,
      issues: n.issues,
      requestSha256: job.requestSha256,
      finalResponseFile: path.relative(this.registry.jobDir(job.localId), finalPath).split(path.sep).join("/"),
      retrievedAt: nowIso(),
    });
    if (n.outcome === "corrupt") return; // no assistant text is trustworthy enough to render
    const completed = n.items.filter((i) => i.status === "completed");
    let md: string;
    if (n.items.length === 1 && completed.length === 1) {
      md = completed[0]!.text!.trimEnd() + "\n";
    } else {
      md = n.items
        .map((i) =>
          i.status === "completed"
            ? `## ${i.customId}\n\n${i.text!.trimEnd()}\n`
            : `## ${i.customId} (FAILED)\n\n${i.error?.code ? `[${i.error.code}] ` : ""}${i.error?.message ?? "unknown error"}\n`,
        )
        .join("\n");
    }
    atomicWriteFile(this.registry.artefact(job.localId, "resultMd"), md);
  }

  // --------------------------------------------------------------- cancel

  public async cancel(localId: string): Promise<{ job: JobManifest; message: string }> {
    let job = this.registry.read(localId);
    if (job.localStatus === "previewed") {
      job = this.withLock(localId, () => this.registry.update(localId, (u) => (u.transition("cancelled", { reason: "never submitted" }), u.manifest)));
      return { job, message: `${localId} was never submitted; marked cancelled.` };
    }
    if (TERMINAL_STATUSES.has(job.localStatus)) {
      return { job, message: `${localId} is already ${job.localStatus}; nothing to cancel.` };
    }
    if (job.localStatus === "provider_completed" || job.localStatus === "retrieving") {
      return { job, message: `${localId} has already completed at OpenRouter (${job.localStatus}); it cannot be cancelled.` };
    }
    if (job.localStatus !== "submitted" && job.localStatus !== "polling" && job.localStatus !== "cancel_requested") {
      return { job, message: `${localId} is ${job.localStatus}; it cannot be cancelled now.` };
    }

    if (job.localStatus !== "cancel_requested") {
      job = this.withLock(localId, () =>
        this.registry.update(localId, (u) => {
          u.manifest.cancelRequestedAt = nowIso();
          u.transition("cancel_requested");
          return u.manifest;
        }),
      );
    }

    let providerNote: string;
    try {
      const apiKey = await this.deps.resolveApiKey(job.account);
      const res = await this.client(apiKey).cancel(job.providerBatchId!);
      if (res.raw) writeOnce(this.registry.artefact(localId, "cancelResponse"), res.raw.bodyText);
      providerNote = res.supported
        ? "OpenRouter accepted the cancellation request."
        : "OpenRouter does not document a batch cancel endpoint and did not accept one; the batch may still complete (and be billed).";
      this.withLock(localId, () => this.registry.update(localId, (u) => u.note("cancel_provider_response", { supported: res.supported, httpStatus: res.raw?.status })));
    } catch (err) {
      const e = err as OpenRouterError;
      providerNote = `Cancellation request to OpenRouter failed (${e.category ?? "error"}): ${e.detail ?? e.message}. Will keep reconciling.`;
      this.withLock(localId, () => this.registry.update(localId, (u) => u.note("cancel_provider_error", { category: e.category, httpStatus: e.httpStatus })));
    }

    const outcome = await this.reconcile(localId, { force: true });
    job = this.registry.read(localId);
    const finalNote =
      job.localStatus === "cancelled"
        ? "Status: cancelled."
        : job.localStatus === "ready" || job.localStatus === "partial"
          ? `The batch had already completed before cancellation took effect; the result was retrieved (${job.localStatus}).`
          : `Local status: ${job.localStatus}${outcome.error ? ` (last check: ${outcome.error})` : ""}. The real outcome will be reconciled by polling.`;
    return { job, message: `${providerNote}\n${finalNote}` };
  }

  private withLock<T>(localId: string, fn: () => T): T {
    const lock = this.registry.lock(localId);
    try {
      return fn();
    } finally {
      lock.release();
    }
  }

  // ---------------------------------------------------------------- retry

  public async retry(localId: string, opts: { model?: string } = {}): Promise<JobManifest> {
    const source = this.registry.read(localId);
    if (!TERMINAL_STATUSES.has(source.localStatus)) {
      throw new Error(`${localId} is ${source.localStatus}; only finished jobs (ready/partial/failed/cancelled/expired/corrupt) can be retried.`);
    }
    const config = this.deps.getConfig();
    const srcBodyText = fs.readFileSync(this.registry.artefact(localId, "submittedRequest"), "utf8");
    const srcBody = JSON.parse(srcBodyText) as SubmitBody;
    const contextText = fs.readFileSync(this.registry.artefact(localId, "context"), "utf8");
    const objective = fs.readFileSync(this.registry.artefact(localId, "objective"), "utf8");

    if (config.security.scanSecrets && config.security.blockOnSecret) {
      const known = await this.knownSecrets(source.account);
      const findings = [...scanForSecrets(objective, "<objective>", known), ...scanForSecrets(srcBodyText, "submitted-request.json", known)];
      if (findings.length > 0) throw new SubmissionBlockedError(formatSecretFindings(findings));
    }

    const model = opts.model ? normalizeBatchModelSlug(opts.model) : srcBody.model;
    const contentSha256 = contentHash(buildSubmitBody({ model, provider: srcBody.provider, requests: [{ custom_id: "{custom_id}", body: srcBody.requests[0]!.body }] }));

    const child = this.registry.create((newId) => {
      const customIds = srcBody.requests.map((_, i) => customIdFor(newId, i));
      const body = buildSubmitBody({
        model,
        provider: srcBody.provider,
        requests: srcBody.requests.map((r, i) => ({ custom_id: customIds[i]!, body: r.body })),
      });
      const bodyText = JSON.stringify(body, null, 2);
      const requestSha256 = sha256Hex(bodyText);
      atomicWriteFile(this.registry.artefact(newId, "objective"), objective);
      atomicWriteFile(this.registry.artefact(newId, "context"), contextText);
      fs.copyFileSync(this.registry.artefact(localId, "contextManifest"), this.registry.artefact(newId, "contextManifest"));
      atomicWriteFile(this.registry.artefact(newId, "submittedRequest"), bodyText);
      atomicWriteFile(this.registry.artefact(newId, "requestSha"), `${requestSha256}  submitted-request.json\n`);
      return {
        schemaVersion: 1,
        localId: newId,
        parentJobId: localId,
        retryCount: source.retryCount + 1,
        objective: source.objective,
        model,
        provider: "openrouter",
        account: source.account,
        ...(srcBody.provider ? { providerPin: srcBody.provider } : {}),
        endpoint: "/v1/chat/completions",
        format: source.format,
        localStatus: "draft",
        requestCount: customIds.length,
        customIds,
        createdAt: nowIso(),
        pollAttempts: 0,
        consecutivePollFailures: 0,
        requestSha256,
        contentSha256,
        context: { ...source.context },
        injectionCount: 0,
        warnings: [],
      };
    });
    this.registry.update(child.localId, (u) => u.transition("previewed", { retryOf: localId, model }));
    this.withLock(localId, () => this.registry.update(localId, (u) => u.note("retried", { childJobId: child.localId, model })));
    this.logger.log("info", "retry_created", { localId: child.localId, parentJobId: localId });
    return this.submit(child.localId, { skipDuplicateCheck: true });
  }

  // ----------------------------------------------------------- read/inject

  public read(localId: string, mode: ReadMode): { title: string; body: string } {
    const job = this.registry.read(localId);
    const resultMd = this.registry.artefact(localId, "resultMd");
    const resultJson = this.registry.artefact(localId, "resultJson");
    const finalResponse = this.registry.artefact(localId, "finalResponse");

    if (mode === "raw") {
      if (!fs.existsSync(finalResponse)) {
        return { title: `${localId}: no final provider response yet`, body: `Status: ${job.localStatus}. Latest raw status (if any): ${this.registry.artefact(localId, "latestStatus")}` };
      }
      const text = fs.readFileSync(finalResponse, "utf8");
      let pretty = text;
      try {
        pretty = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        // show as-is if not JSON
      }
      return { title: `${localId}: raw provider response (exact bytes at ${finalResponse})`, body: pretty };
    }

    if (!fs.existsSync(resultJson)) {
      return {
        title: `${localId}: no retrieved result`,
        body: `Status: ${job.localStatus}${job.providerStatus ? ` (provider: ${job.providerStatus})` : ""}. ${
          POLLABLE_STATUSES.has(job.localStatus) ? "Use /batch check to reconcile now." : job.error ? `Error: ${job.error.message}` : ""
        }`,
      };
    }
    const header = job.localStatus === "ready" ? "" : `⚠ Status: ${job.localStatus}${job.error ? ` — ${job.error.message}` : ""}\n\n`;
    const text = fs.existsSync(resultMd) ? fs.readFileSync(resultMd, "utf8") : "(no renderable assistant output)";
    if (mode === "default") return { title: `${localId}: ${truncate(job.objective, 60)}`, body: header + text };

    const n = JSON.parse(fs.readFileSync(resultJson, "utf8")) as NormalisedBatchResult;
    const lines = [
      header + text.trimEnd(),
      "",
      "---",
      `Outcome: ${n.outcome}   Provider status: ${n.providerStatus}`,
      ...n.items.map((i) => `- ${i.customId}: ${i.status}${i.finishReason ? ` (finish_reason: ${i.finishReason})` : ""}${i.error ? ` — ${i.error.code ?? ""} ${i.error.message}` : ""}`),
      ...(n.usage ? [`Usage: ${formatUsage(n.usage)}`] : ["Usage: not reported by provider"]),
      ...n.issues.map((i) => `Issue: ${i}`),
      ...n.warnings.map((w) => `Warning: ${w}`),
      `Artefacts: ${this.registry.jobDir(localId)}`,
    ];
    return { title: `${localId}: ${truncate(job.objective, 60)} (full)`, body: lines.join("\n") };
  }

  public buildInjection(localId: string, mode: InjectMode): { ok: true; content: string; characters: number; bounded: boolean } | { ok: false; message: string } {
    const job = this.registry.read(localId);
    if (job.localStatus !== "ready" && job.localStatus !== "partial") {
      return {
        ok: false,
        message: `${localId} is ${job.localStatus}; only ready (or explicitly partial) results can be injected.${job.error ? ` Error: ${job.error.message}` : ""}`,
      };
    }
    const resultMd = this.registry.artefact(localId, "resultMd");
    if (!fs.existsSync(resultMd)) return { ok: false, message: `${localId} has no rendered result (result/result.md missing).` };
    const result = fs.readFileSync(resultMd, "utf8").trimEnd();
    const config = this.deps.getConfig().injection;

    const head: string[] = [`Deferred batch result: ${localId}`];
    if (job.localStatus === "partial") head.push("", `PARTIAL RESULT: ${job.error?.message ?? "some requests failed"}.`);
    if (config.includeObjective) head.push("", "Original objective:", job.objective);
    head.push("", "Result:");
    const tail: string[] = [];
    if (config.includeArtefactPaths) tail.push("", "Local artefacts:", this.registry.jobDir(localId));
    tail.push(
      "",
      `Note: this is batch-generated analysis (model ${job.model}, retrieved ${formatIsoShort(job.retrievedAt)}). ` +
        "Validate it against the current repository before making changes.",
    );
    const assemble = (body: string) => [...head, body, ...tail].join("\n");

    const full = assemble(result);
    if (mode === "full" || full.length <= config.maxCharacters) return { ok: true, content: full, characters: full.length, bounded: false };
    if (mode === "default") {
      return {
        ok: false,
        message:
          `${localId} result is ${full.length} characters, above injection.maxCharacters (${config.maxCharacters}).\n` +
          `Nothing was injected. Choose explicitly:\n` +
          `  /batch inject ${localId} --summary   bounded excerpt (first ~${config.maxCharacters} characters, clearly marked)\n` +
          `  /batch inject ${localId} --full      the complete result`,
      };
    }
    // --summary: bounded, explicitly marked excerpt (no model-generated summary in Release 1).
    const marker = (shown: number) => `\n\n[EXCERPT: first ${shown} of ${result.length} result characters. Full result: ${resultMd}]`;
    const budget = Math.max(500, config.maxCharacters - assemble("").length - marker(result.length).length);
    let excerpt = result.slice(0, budget);
    const lastNl = excerpt.lastIndexOf("\n");
    if (lastNl > budget * 0.8) excerpt = excerpt.slice(0, lastNl);
    const content = assemble(excerpt + marker(excerpt.length));
    return { ok: true, content, characters: content.length, bounded: true };
  }

  public recordInjection(localId: string, details: { mode: InjectMode; characters: number; bounded: boolean }): void {
    this.withLock(localId, () =>
      this.registry.update(localId, (u) => {
        u.manifest.injectedAt = nowIso();
        u.manifest.injectionCount += 1;
        u.note("injected", details);
      }),
    );
    this.logger.log("info", "injected", { localId, ...details });
  }
}

/** Duplicate-detection hash: canonical JSON of the request with custom_ids masked. */
export function contentHash(body: SubmitBody): string {
  const masked = { ...body, requests: body.requests.map((r) => ({ ...r, custom_id: "{custom_id}" })) };
  return sha256Hex(canonicalJson(masked));
}

export function formatUsage(u: NonNullable<JobManifest["usage"]>): string {
  const parts: string[] = [];
  if (u.inputTokens !== undefined) parts.push(`input ${u.inputTokens} tok`);
  if (u.outputTokens !== undefined) parts.push(`output ${u.outputTokens} tok`);
  if (u.cost !== undefined) parts.push(`charged $${u.cost.toFixed(6)}`);
  if (u.isByok !== undefined) parts.push(u.isByok ? "BYOK" : "not BYOK");
  if (u.upstreamInferenceCost !== undefined) parts.push(`upstream est. $${u.upstreamInferenceCost.toFixed(6)}`);
  return parts.join(", ") || "none reported";
}

function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}
