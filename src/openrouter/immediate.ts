import { immediateProviderFields, type ImmediateAllowList, type PrivacyLevel } from "../privacy/policy.js";
import type { JobManifest } from "../types.js";
import { OpenRouterError, type OpenRouterBatchClient } from "./client.js";
import type { BatchRequestItem } from "./types.js";

/**
 * The immediate route: a job's items sent one by one through POST /chat/completions
 * (free models are not batch models). The caller persists nothing about the result
 * itself: a `done` outcome carries a batch-shaped final response that the normal
 * retrieval path (write-once save, normaliseBatchResult, settle) handles unchanged.
 *
 * Crash safety: each item's call state lives in an `ImmediateProgress` record that is
 * rewritten whole (atomically) before and after every call. An item is sent only when
 * it has no record. A `started` record with no outcome means a process stopped mid-call:
 * the provider may have answered it, so it is never sent again. It becomes
 * `submission_unknown` once the call can no longer be in flight (`inFlightMs`); until
 * then it is left alone, in case another process is still waiting on it.
 *
 * Saving item N's outcome and marking item N+1 `started` are two separate writes. Between
 * them, item N+1 has no record, and only the caller's job lock stops another process from
 * sending it. That gap is exposed only if the lock goes stale (held > 120 s) in that instant.
 */

export type ImmediateFailureCode = "rate_limited_daily" | "provider_error" | "submission_unknown";

export type ImmediateOutcome =
  /** Every item has an outcome; `finalResponseText` is batch-shaped (normaliseBatchResult accepts it). */
  | { kind: "done"; finalResponseText: string }
  /** Per-minute 429: try again at `notBefore`. The item was not processed and has no record. */
  | { kind: "retry"; notBefore: string; reason: string }
  /** Item 1 (the reply) failed; later items were not sent. */
  | { kind: "failed"; code: ImmediateFailureCode; message: string }
  /** Item `ordinal` was started recently (possibly by another process); nothing was sent. */
  | { kind: "in_flight"; ordinal: number; until: string };

export type ImmediateItemState =
  | { state: "started"; at: string }
  | { state: "completed"; at: string; status: number; bodyText: string }
  | { state: "failed"; at: string; code: ImmediateFailureCode; message: string; status?: number; bodyText?: string };

/** Per-item call state keyed by custom_id. `write` must replace the whole record atomically. */
export interface ImmediateProgress {
  read(): Record<string, ImmediateItemState>;
  write(state: Record<string, ImmediateItemState>): void;
}

export interface ImmediateOptions {
  /** Defaults to an in-memory record (no crash safety). */
  progress?: ImmediateProgress;
  /** How long a `started` call may still be in flight (the request timeout plus a margin). Default 120 s. */
  inFlightMs?: number;
  /** routing.allowedProviders (read when sent); non-empty adds `provider.only` to every call. */
  allowList?: ImmediateAllowList;
}

export const DAILY_LIMIT_MESSAGE = "Free-model daily limit reached; try later or switch model";
export const UNKNOWN_OUTCOME_MESSAGE =
  "No response from OpenRouter for this request (Pi stopped, or the connection failed mid-call); it may have been answered. It was not sent again.";
/** More consecutive 429s than this are treated as the daily limit. */
export const MAX_CONSECUTIVE_429 = 8;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 15 * 60_000;
const DAILY_PATTERN = /daily|per[\s_-]?day|free-models-per-day/i;

/** The synthetic batch ID of an immediate job's final response (never a provider batch ID). */
export function immediateResultId(localId: string): string {
  return `immediate-${localId}`;
}

/** The exact bytes POSTed for one item: `{ model, ...item.body, provider }`, with `provider` omitted when empty. */
export function immediateRequestBody(model: string, item: BatchRequestItem, level: PrivacyLevel, allowList?: ImmediateAllowList): string {
  const fields = immediateProviderFields(level, allowList);
  return JSON.stringify({ model, ...item.body, ...(Object.keys(fields).length > 0 ? { provider: fields } : {}) });
}

/** A 429's kind: a daily (free-model) limit, and the server's Retry-After in ms (0 when absent or unreadable). */
export function classify429(raw: { status: number; bodyText: string; headers?: Record<string, string> }): { daily: boolean; retryAfterMs: number } {
  const daily = DAILY_PATTERN.test(raw.bodyText);
  let header: string | undefined;
  for (const [k, v] of Object.entries(raw.headers ?? {})) if (k.toLowerCase() === "retry-after") header = v.trim();
  let retryAfterMs = 0;
  if (header) {
    if (/^\d+(\.\d+)?$/.test(header)) retryAfterMs = Math.round(Number(header) * 1000);
    else {
      const at = Date.parse(header);
      if (Number.isFinite(at)) retryAfterMs = Math.max(0, at - Date.now());
    }
  }
  return { daily, retryAfterMs };
}

function memoryProgress(): ImmediateProgress {
  let state: Record<string, ImmediateItemState> = {};
  return { read: () => ({ ...state }), write: (s) => void (state = { ...s }) };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function asObject(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/**
 * Runs the job's items in order (item 1, then item 2, ...), skipping items that already
 * have an outcome. Item 1 failing ends the job (`failed`); a later item failing fails
 * only that item. `job.consecutivePollFailures` is the number of 429s in a row so far.
 */
export async function runImmediateJob(
  job: JobManifest,
  requests: BatchRequestItem[],
  client: OpenRouterBatchClient,
  level: PrivacyLevel,
  now: () => Date = () => new Date(),
  opts: ImmediateOptions = {},
): Promise<ImmediateOutcome> {
  const progress = opts.progress ?? memoryProgress();
  const inFlightMs = opts.inFlightMs ?? 120_000;
  const state = progress.read();
  const iso = () => now().toISOString();

  for (const [i, req] of requests.entries()) {
    const ordinal = i + 1;
    const id = req.custom_id;
    let s = state[id];
    if (s?.state === "started") {
      const startedAt = Date.parse(s.at);
      if (Number.isFinite(startedAt) && now().getTime() - startedAt < inFlightMs) {
        return { kind: "in_flight", ordinal, until: new Date(startedAt + inFlightMs).toISOString() };
      }
      s = state[id] = { state: "failed", at: iso(), code: "submission_unknown", message: UNKNOWN_OUTCOME_MESSAGE };
      progress.write(state);
    }
    if (!s) {
      // Recorded BEFORE the call: from here on, this item is never sent again without an outcome.
      state[id] = { state: "started", at: iso() };
      progress.write(state);
      const result = await callOnce(job, req, client, level, now, opts.allowList);
      if ("retry" in result) {
        delete state[id]; // a 429 means it was not processed: safe to send again later
        progress.write(state);
        return result.retry;
      }
      s = state[id] = result.item;
      progress.write(state);
    }
    if (s.state === "failed" && ordinal === 1) return { kind: "failed", code: s.code, message: s.message };
  }
  return { kind: "done", finalResponseText: buildFinalResponse(job, requests, state, now()) };
}

async function callOnce(
  job: JobManifest,
  req: BatchRequestItem,
  client: OpenRouterBatchClient,
  level: PrivacyLevel,
  now: () => Date,
  allowList?: ImmediateAllowList,
): Promise<{ item: ImmediateItemState } | { retry: Extract<ImmediateOutcome, { kind: "retry" }> }> {
  const at = () => now().toISOString();
  try {
    const raw = await client.chatCompletion(immediateRequestBody(job.model, req, level, allowList));
    // A 200 can still carry only an error (e.g. "no endpoints" for a provider filter).
    const body = asObject(parseJson(raw.bodyText));
    const err = asObject(body?.error);
    if (body && err && !Array.isArray(body.choices)) {
      const message = typeof err.message === "string" && err.message ? err.message : JSON.stringify(err).slice(0, 500);
      return { item: { state: "failed", at: at(), code: "provider_error", message, status: raw.status, bodyText: raw.bodyText } };
    }
    return { item: { state: "completed", at: at(), status: raw.status, bodyText: raw.bodyText } };
  } catch (e) {
    if (e instanceof OpenRouterError && e.httpStatus === 429) {
      const c = classify429({ status: 429, bodyText: e.rawBody ?? e.detail, ...(e.retryAfter !== undefined ? { headers: { "retry-after": e.retryAfter } } : {}) });
      const previous = job.consecutivePollFailures ?? 0;
      if (c.daily || previous + 1 > MAX_CONSECUTIVE_429) {
        return { item: { state: "failed", at: at(), code: "rate_limited_daily", message: DAILY_LIMIT_MESSAGE, status: 429, ...(e.rawBody ? { bodyText: e.rawBody } : {}) } };
      }
      const waitMs = c.retryAfterMs > 0 ? c.retryAfterMs : Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** previous);
      return { retry: { kind: "retry", notBefore: new Date(now().getTime() + waitMs).toISOString(), reason: `HTTP 429 (rate limited): ${e.detail}` } };
    }
    if (e instanceof OpenRouterError && e.httpStatus !== undefined) {
      // A definite HTTP rejection: the request was not answered.
      return { item: { state: "failed", at: at(), code: "provider_error", message: `HTTP ${e.httpStatus}: ${e.detail}`, status: e.httpStatus, ...(e.rawBody ? { bodyText: e.rawBody } : {}) } };
    }
    // Network failure, timeout or anything unexpected: the provider may have answered. Never resent.
    const detail = e instanceof OpenRouterError ? e.detail : String((e as Error)?.message ?? e);
    return { item: { state: "failed", at: at(), code: "submission_unknown", message: `${UNKNOWN_OUTCOME_MESSAGE} Detail: ${detail}` } };
  }
}

/** In exactly the shape of a completed batch object (see test/fixtures/openrouter.ts `completed`). */
function buildFinalResponse(job: JobManifest, requests: BatchRequestItem[], state: Record<string, ImmediateItemState>, finished: Date): string {
  const results: unknown[] = [];
  const usages: Record<string, unknown>[] = [];
  let failed = 0;
  let firstAt: number | undefined;
  for (const [i, req] of requests.entries()) {
    const s = state[req.custom_id];
    if (!s || s.state === "started") continue; // cannot happen for a done job; normalisation reports it missing
    const t = Date.parse(s.at);
    if (Number.isFinite(t)) firstAt = firstAt === undefined ? t : Math.min(firstAt, t);
    const id = `immediate_req_${i + 1}`;
    if (s.state === "failed") {
      failed += 1;
      results.push({ id, custom_id: req.custom_id, response: null, error: { type: "immediate_error", code: s.code, message: s.message, ...(s.status !== undefined ? { status_code: s.status } : {}) } });
      continue;
    }
    const parsed = parseJson(s.bodyText);
    const body = asObject(parsed);
    const usage = asObject(body?.usage);
    if (usage) usages.push(usage);
    results.push({
      id,
      custom_id: req.custom_id,
      response: { status_code: s.status, request_id: typeof body?.id === "string" ? body.id : null, body: parsed ?? s.bodyText },
      error: null,
    });
  }
  const seconds = (ms: number) => Math.floor(ms / 1000);
  return JSON.stringify({
    id: immediateResultId(job.localId),
    object: "batch",
    endpoint: "/v1/chat/completions",
    model: job.model,
    completion_window: null,
    status: "completed",
    created_at: seconds(firstAt ?? finished.getTime()),
    finalized_at: seconds(finished.getTime()),
    request_counts: { total: results.length, completed: results.length - failed, failed },
    usage: sumUsage(usages),
    results,
    error: null,
  });
}

/** Sums the items' reported usage. Fields no item reported are left out (never invented zeros). */
function sumUsage(usages: Record<string, unknown>[]): Record<string, unknown> | null {
  if (usages.length === 0) return null;
  const out: Record<string, unknown> = {};
  for (const key of ["prompt_tokens", "completion_tokens", "total_tokens", "cost"]) {
    const values = usages.map((u) => u[key]).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    if (values.length > 0) out[key] = values.reduce((a, b) => a + b, 0);
  }
  const byok = usages.map((u) => u.is_byok);
  if (byok.every((b) => b === true) || byok.every((b) => b === false)) out.is_byok = byok[0];
  return Object.keys(out).length > 0 ? out : null;
}
