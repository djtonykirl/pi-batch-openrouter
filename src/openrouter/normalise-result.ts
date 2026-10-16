/**
 * Raw OpenRouter batch object -> internal NormalisedBatchResult.
 *
 * The caller MUST persist the raw response text before calling this. This
 * function never throws on unexpected shapes: anything it cannot safely
 * interpret yields outcome "corrupt" with explicit validation issues, so
 * malformed output can never become "ready".
 */

export interface NormalisedError {
  code?: string;
  message: string;
}

export interface NormalisedBatchItem {
  customId: string;
  status: "completed" | "failed";
  text?: string;
  finishReason?: string;
  generationId?: string;
  raw: unknown;
  error?: NormalisedError;
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
 * ready       every expected item completed with usable text
 * partial     some expected items completed, some failed
 * failed      provider completed the batch but every item failed
 * corrupt     response cannot be trusted (bad shape, wrong batch, missing/duplicate/unexpected custom_id)
 * unavailable batch is completed but `results` is null (e.g. HTTP 402) — retry later
 */
export type NormalisationOutcome = "ready" | "partial" | "failed" | "corrupt" | "unavailable";

export interface NormalisedBatchResult {
  localJobId: string;
  providerBatchId: string;
  providerStatus: string;
  completed: boolean;
  outcome: NormalisationOutcome;
  items: NormalisedBatchItem[];
  usage?: NormalisedUsage;
  requestCounts?: { total: number; completed: number; failed: number };
  error?: NormalisedError;
  /** Problems that forced `corrupt`. */
  issues: string[];
  /** Non-fatal observations (e.g. request_counts disagree with results). */
  warnings: string[];
}

export interface NormaliseExpectations {
  localJobId: string;
  providerBatchId: string;
  expectedCustomIds: string[];
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function extractUsage(u: unknown): NormalisedUsage | undefined {
  if (!u || typeof u !== "object") return undefined;
  const o = u as Record<string, unknown>;
  const details = (o.cost_details && typeof o.cost_details === "object" ? o.cost_details : {}) as Record<string, unknown>;
  const usage: NormalisedUsage = {
    inputTokens: num(o.prompt_tokens),
    outputTokens: num(o.completion_tokens),
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

/** Chat-completion content may be a string or an array of typed parts. */
function extractText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : ""))
      .filter(Boolean);
    return parts.length > 0 ? parts.join("") : undefined;
  }
  return undefined;
}

function normaliseItem(raw: Record<string, unknown>, customId: string): NormalisedBatchItem {
  const error = extractError(raw.error);
  const response = raw.response as Record<string, unknown> | null | undefined;
  if (error) return { customId, status: "failed", raw, error };
  if (!response || typeof response !== "object") {
    return { customId, status: "failed", raw, error: { code: "missing_response", message: "item has neither response nor error" } };
  }
  const statusCode = num(response.status_code);
  const body = response.body as Record<string, unknown> | null | undefined;
  if (statusCode !== undefined && (statusCode < 200 || statusCode >= 300)) {
    const bodyErr = body && typeof body === "object" ? extractError(body.error) : undefined;
    return { customId, status: "failed", raw, error: bodyErr ?? { code: `http_${statusCode}`, message: `request returned HTTP ${statusCode}` } };
  }
  const choice = Array.isArray(body?.choices) ? (body!.choices as Array<Record<string, unknown>>)[0] : undefined;
  const message = choice?.message as Record<string, unknown> | undefined;
  const text = extractText(message?.content);
  const finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined;
  const generationId = typeof body?.id === "string" ? body.id : undefined;
  if (!text || !text.trim()) {
    return {
      customId,
      status: "failed",
      raw,
      finishReason,
      generationId,
      error: { code: "missing_output", message: `completed request contains no usable text${finishReason ? ` (finish_reason: ${finishReason})` : ""}` },
    };
  }
  return { customId, status: "completed", text, finishReason, generationId, raw };
}

export function normaliseBatchResult(rawText: string, expect: NormaliseExpectations): NormalisedBatchResult {
  const base: NormalisedBatchResult = {
    localJobId: expect.localJobId,
    providerBatchId: expect.providerBatchId,
    providerStatus: "unknown",
    completed: false,
    outcome: "corrupt",
    items: [],
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

  const expected = new Set(expect.expectedCustomIds);
  const seen = new Set<string>();
  for (const [i, entry] of (o.results as unknown[]).entries()) {
    if (!entry || typeof entry !== "object") {
      base.issues.push(`results[${i}] is not an object`);
      continue;
    }
    const item = entry as Record<string, unknown>;
    const customId = item.custom_id;
    if (typeof customId !== "string" || !customId) {
      base.issues.push(`results[${i}] has no custom_id`);
      continue;
    }
    if (seen.has(customId)) {
      base.issues.push(`duplicate custom_id ${customId}`);
      continue;
    }
    seen.add(customId);
    if (!expected.has(customId)) {
      base.issues.push(`unexpected custom_id ${customId}`);
      continue;
    }
    base.items.push(normaliseItem(item, customId));
  }
  for (const id of expected) {
    if (!seen.has(id)) base.issues.push(`expected custom_id ${id} missing from results`);
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
  const completedCount = base.items.filter((it) => it.status === "completed").length;
  base.outcome = completedCount === base.items.length ? "ready" : completedCount === 0 ? "failed" : "partial";
  return base;
}
