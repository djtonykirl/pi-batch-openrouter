import { extractJsonObject, type OutputValidator } from "../workflows/structured.js";

/**
 * Raw OpenRouter batch object -> internal NormalisedBatchResult.
 *
 * The caller MUST persist the raw response text before calling this. This
 * function never throws on unexpected shapes: anything it cannot safely
 * interpret yields explicit issues, so malformed output can never become "ready".
 *
 * Correlation is exclusively by `custom_id` against the expected list stored
 * in the job manifest. The provider's result order is never relied on: items
 * are returned in submission (expected) order.
 */

export interface NormalisedError {
  code?: string;
  message: string;
}

export interface ItemValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export type NormalisedItemStatus = "completed" | "failed" | "corrupt" | "missing";

export interface NormalisedBatchItem {
  customId: string;
  status: NormalisedItemStatus;
  text?: string;
  /** Parsed JSON object (format json), also kept for schema-invalid items as evidence. */
  json?: Record<string, unknown>;
  finishReason?: string;
  generationId?: string;
  /** The provider's result entry, verbatim (absent for "missing"). */
  raw: unknown;
  /** Index in the provider's `results` array (evidence only; never used for correlation). */
  resultIndex?: number;
  error?: NormalisedError;
  /** Per-item usage only if the provider included it in this item's response body. */
  usage?: NormalisedUsage;
  validation: ItemValidation;
}

export interface NormalisedUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cost?: number;
  isByok?: boolean;
  upstreamInferenceCost?: number;
}

/**
 * Batch outcome rules (deterministic; see README "Multi-request outcome rules"):
 *
 * corrupt     the response cannot be correlated safely: not JSON / not an object,
 *             batch id mismatch, status not "completed", `results` not an array,
 *             an entry without custom_id, a duplicate returned custom_id, an
 *             unknown (unexpected) custom_id, or an empty `results` array for a
 *             non-empty batch. Also: every expected item individually corrupt.
 * ready       correlation is sound and EVERY expected item is completed and valid.
 * partial     correlation is sound, at least one item is usable and at least one
 *             is failed, corrupt or missing.
 * failed      correlation is sound and no item is usable (item failures).
 * unavailable batch is completed but `results` is null (e.g. HTTP 402): retry later.
 *
 * Provider "completed" means processing ended; it never implies "ready" by itself.
 */
export type NormalisationOutcome = "ready" | "partial" | "failed" | "corrupt" | "unavailable";

export interface UnexpectedEntry {
  resultIndex: number;
  customId?: string;
  reason: "not_an_object" | "no_custom_id" | "duplicate_custom_id" | "unknown_custom_id";
  raw: unknown;
}

export interface NormalisedBatchResult {
  localJobId: string;
  providerBatchId: string;
  providerStatus: string;
  completed: boolean;
  outcome: NormalisationOutcome;
  /** One entry per expected custom_id, in submission order (empty when correlation never started). */
  items: NormalisedBatchItem[];
  missingCustomIds: string[];
  /** Result entries that could not be attributed to an expected item; preserved as evidence. */
  unexpected: UnexpectedEntry[];
  usage?: NormalisedUsage;
  requestCounts?: { total: number; completed: number; failed: number };
  error?: NormalisedError;
  /** Problems that forced `corrupt`. */
  issues: string[];
  /** Non-fatal observations (e.g. request_counts disagree with results, missing items). */
  warnings: string[];
}

export interface NormaliseExpectations {
  localJobId: string;
  providerBatchId: string;
  expectedCustomIds: string[];
  /** When "json", completed text must parse to a JSON object, else the item is corrupt. */
  format?: "markdown" | "json";
  /** Release 3 JSON workflows: schema errors for a parsed object (empty = valid); errors make the item corrupt. */
  validateJson?: OutputValidator;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export function extractUsage(u: unknown): NormalisedUsage | undefined {
  if (!u || typeof u !== "object") return undefined;
  const o = u as Record<string, unknown>;
  const details = (o.cost_details && typeof o.cost_details === "object" ? o.cost_details : {}) as Record<string, unknown>;
  const usage: NormalisedUsage = {
    inputTokens: num(o.prompt_tokens) ?? num(o.input_tokens),
    outputTokens: num(o.completion_tokens) ?? num(o.output_tokens),
    totalTokens: num(o.total_tokens),
    cost: num(o.cost),
    isByok: typeof o.is_byok === "boolean" ? o.is_byok : undefined,
    upstreamInferenceCost: num(details.upstream_inference_cost),
  };
  // Drop absent fields entirely: never fabricate zeros.
  for (const k of Object.keys(usage) as Array<keyof NormalisedUsage>) if (usage[k] === undefined) delete usage[k];
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function extractError(e: unknown): NormalisedError | undefined {
  if (!e || typeof e !== "object") return undefined;
  const o = e as Record<string, unknown>;
  const message = typeof o.message === "string" && o.message ? o.message : JSON.stringify(e).slice(0, 500);
  const codeRaw = o.code ?? o.error_type ?? o.type;
  return { message, ...(codeRaw !== undefined && codeRaw !== null ? { code: String(codeRaw) } : {}) };
}

/** Chat-completion content may be a string or an array of typed parts. `null` = valid shape, no text. */
function extractText(content: unknown): { ok: true; text?: string } | { ok: false } {
  if (content === null || content === undefined) return { ok: true };
  if (typeof content === "string") return { ok: true, text: content };
  if (Array.isArray(content)) {
    const parts = content
      .map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : ""))
      .filter(Boolean);
    return { ok: true, text: parts.length > 0 ? parts.join("") : undefined };
  }
  return { ok: false };
}

const valid = (warnings: string[] = []): ItemValidation => ({ valid: true, errors: [], warnings });
const invalid = (error: string, warnings: string[] = []): ItemValidation => ({ valid: false, errors: [error], warnings });

function normaliseItem(raw: Record<string, unknown>, customId: string, resultIndex: number, format: "markdown" | "json", validateJson?: OutputValidator): NormalisedBatchItem {
  const base = { customId, raw, resultIndex };
  const error = extractError(raw.error);
  if (error) return { ...base, status: "failed", error, validation: invalid(`provider error: ${error.message}`) };
  const response = raw.response;
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    const e = { code: "missing_response", message: "item has neither a response object nor an error" };
    return { ...base, status: "corrupt", error: e, validation: invalid(e.message) };
  }
  const r = response as Record<string, unknown>;
  const statusCode = num(r.status_code);
  const body = r.body as Record<string, unknown> | null | undefined;
  const usage = body && typeof body === "object" ? extractUsage(body.usage) : undefined;
  const withUsage = usage ? { usage } : {};
  if (statusCode !== undefined && (statusCode < 200 || statusCode >= 300)) {
    const bodyErr = body && typeof body === "object" ? extractError(body.error) : undefined;
    const e = bodyErr ?? { code: `http_${statusCode}`, message: `request returned HTTP ${statusCode}` };
    return { ...base, ...withUsage, status: "failed", error: e, validation: invalid(e.message) };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    const e = { code: "malformed_response", message: "response body is missing or not an object" };
    return { ...base, status: "corrupt", error: e, validation: invalid(e.message) };
  }
  if (!Array.isArray(body.choices)) {
    const e = { code: "malformed_response", message: "response body has no choices array" };
    return { ...base, ...withUsage, status: "corrupt", error: e, validation: invalid(e.message) };
  }
  const choice = (body.choices as unknown[])[0] as Record<string, unknown> | undefined;
  const finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined;
  const generationId = typeof body.id === "string" ? body.id : undefined;
  const extra = { ...withUsage, ...(finishReason ? { finishReason } : {}), ...(generationId ? { generationId } : {}) };
  if (choice !== undefined && (!choice || typeof choice !== "object")) {
    const e = { code: "malformed_response", message: "choices[0] is not an object" };
    return { ...base, ...extra, status: "corrupt", error: e, validation: invalid(e.message) };
  }
  const message = choice?.message as Record<string, unknown> | undefined;
  const extracted = extractText(message?.content);
  if (!extracted.ok) {
    const e = { code: "malformed_response", message: "message content has an unrecognised type" };
    return { ...base, ...extra, status: "corrupt", error: e, validation: invalid(e.message) };
  }
  const text = extracted.text;
  if (!text || !text.trim()) {
    const e = { code: "missing_output", message: `completed request contains no usable text${finishReason ? ` (finish_reason: ${finishReason})` : ""}` };
    return { ...base, ...extra, status: "failed", error: e, validation: invalid(e.message) };
  }
  const warnings: string[] = [];
  if (finishReason === "length") warnings.push("output may be truncated (finish_reason: length)");
  else if (finishReason && finishReason !== "stop" && finishReason !== "end_turn") warnings.push(`unusual finish_reason: ${finishReason}`);
  if (format === "json") {
    // Strict extraction (whole text, or one outer fence); see workflows/structured.ts.
    const j = extractJsonObject(text);
    if (!j.ok) {
      return { ...base, ...extra, text, status: "corrupt", error: { code: "invalid_json", message: j.error }, validation: invalid(j.error, warnings) };
    }
    if (j.fenced) warnings.push("JSON output was wrapped in a code fence");
    if (validateJson) {
      const errors = validateJson(j.value);
      if (errors.length > 0) {
        const message = `output does not match the workflow's JSON Schema: ${errors.slice(0, 3).join("; ")}${errors.length > 3 ? `; … (${errors.length} errors)` : ""}`;
        // The parsed value is kept as evidence; the item is not usable.
        return { ...base, ...extra, text, json: j.value, status: "corrupt", error: { code: "schema_invalid", message }, validation: { valid: false, errors, warnings } };
      }
    }
    return { ...base, ...extra, text, json: j.value, status: "completed", validation: valid(warnings) };
  }
  return { ...base, ...extra, text, status: "completed", validation: valid(warnings) };
}

export function normaliseBatchResult(rawText: string, expect: NormaliseExpectations): NormalisedBatchResult {
  const base: NormalisedBatchResult = {
    localJobId: expect.localJobId,
    providerBatchId: expect.providerBatchId,
    providerStatus: "unknown",
    completed: false,
    outcome: "corrupt",
    items: [],
    missingCustomIds: [],
    unexpected: [],
    issues: [],
    warnings: [],
  };

  let json: unknown;
  try {
    json = JSON.parse(rawText);
  } catch {
    base.issues.push("response is not valid JSON");
    return base;
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    base.issues.push("response is not a JSON object");
    return base;
  }
  const o = json as Record<string, unknown>;
  base.providerStatus = typeof o.status === "string" ? o.status : "unknown";
  base.completed = o.status === "completed";
  base.usage = extractUsage(o.usage);
  base.error = extractError(o.error);
  const rc = o.request_counts as Record<string, unknown> | undefined;
  if (rc && num(rc.total) !== undefined && num(rc.completed) !== undefined && num(rc.failed) !== undefined) {
    base.requestCounts = { total: rc.total as number, completed: rc.completed as number, failed: rc.failed as number };
  }

  if (o.id !== expect.providerBatchId) {
    base.issues.push(`batch id mismatch: expected ${expect.providerBatchId}, got ${String(o.id)}`);
    return base;
  }
  if (!base.completed) {
    base.issues.push(`batch status is "${base.providerStatus}", not "completed"`);
    return base;
  }
  if (o.results === null || o.results === undefined) {
    base.outcome = "unavailable";
    base.warnings.push("batch is completed but results are not included in the response");
    return base;
  }
  if (!Array.isArray(o.results)) {
    base.issues.push("results is not an array");
    return base;
  }

  const format = expect.format ?? "markdown";
  const expected = new Set(expect.expectedCustomIds);
  const byId = new Map<string, NormalisedBatchItem>();
  const seen = new Set<string>();
  for (const [i, entry] of (o.results as unknown[]).entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      base.issues.push(`results[${i}] is not an object`);
      base.unexpected.push({ resultIndex: i, reason: "not_an_object", raw: entry });
      continue;
    }
    const item = entry as Record<string, unknown>;
    const customId = item.custom_id;
    if (typeof customId !== "string" || !customId) {
      base.issues.push(`results[${i}] has no custom_id`);
      base.unexpected.push({ resultIndex: i, reason: "no_custom_id", raw: entry });
      continue;
    }
    if (seen.has(customId)) {
      // The first occurrence is kept only as evidence; a duplicate makes correlation untrustworthy.
      base.issues.push(`duplicate custom_id ${customId}`);
      base.unexpected.push({ resultIndex: i, customId, reason: "duplicate_custom_id", raw: entry });
      continue;
    }
    seen.add(customId);
    if (!expected.has(customId)) {
      base.issues.push(`unexpected custom_id ${customId}`);
      base.unexpected.push({ resultIndex: i, customId, reason: "unknown_custom_id", raw: entry });
      continue;
    }
    byId.set(customId, normaliseItem(item, customId, i, format, expect.validateJson));
  }

  // Submission order, independent of result order.
  for (const id of expect.expectedCustomIds) {
    const found = byId.get(id);
    if (found) {
      base.items.push(found);
    } else {
      base.missingCustomIds.push(id);
      base.warnings.push(`expected custom_id ${id} missing from results`);
      base.items.push({
        customId: id,
        status: "missing",
        raw: undefined,
        error: { code: "missing_result", message: "the completed batch returned no result for this request" },
        validation: invalid("no result returned"),
      });
    }
  }
  if ((o.results as unknown[]).length === 0 && expected.size > 0) {
    base.issues.push("completed batch returned an empty results array; result accounting cannot be trusted");
  }

  if (base.requestCounts) {
    const nFailed = base.items.filter((it) => it.status === "failed").length;
    if (base.requestCounts.total !== expected.size) {
      base.warnings.push(`request_counts.total=${base.requestCounts.total} but ${expected.size} request(s) were submitted`);
    }
    if (base.requestCounts.failed !== nFailed) {
      base.warnings.push(`request_counts.failed=${base.requestCounts.failed} but ${nFailed} item(s) failed after normalisation`);
    }
  }

  if (base.issues.length > 0) {
    base.outcome = "corrupt";
    return base;
  }
  const usable = base.items.filter((it) => it.status === "completed").length;
  if (usable === base.items.length) base.outcome = "ready";
  else if (usable > 0) base.outcome = "partial";
  else if (base.items.every((it) => it.status === "corrupt")) base.outcome = "corrupt";
  else base.outcome = "failed";
  return base;
}
