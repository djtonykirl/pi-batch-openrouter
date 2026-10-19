/**
 * OpenRouter Batch API shapes, per https://openrouter.ai/docs/batch-quickstart
 * (verified 2026-10-16). Only the fields this extension reads are typed; raw
 * responses are always preserved verbatim on disk, so unknown fields are never lost.
 */

export const PROVIDER_STATUSES = [
  "validating",
  "in_progress",
  "finalizing",
  "completed",
  "failed",
  "expired",
  "cancelling",
  "cancelled",
] as const;
export type ProviderStatus = (typeof PROVIDER_STATUSES)[number];

export const PROVIDER_TERMINAL: ReadonlySet<string> = new Set(["completed", "failed", "expired", "cancelled"]);

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface BatchRequestItem {
  custom_id: string;
  body: {
    messages: ChatMessage[];
    max_tokens?: number;
    [key: string]: unknown;
  };
}

/** `provider` accepts only `only` and `allow_fallbacks` (sync routing prefs are rejected with 400). */
export interface ProviderPin {
  only: string[];
  allow_fallbacks?: boolean;
}

/**
 * Field order matters: OpenRouter stream-parses the body and returns 400 if
 * `requests` precedes `endpoint`/`model`/`provider`/`completion_window`.
 * Always build via `buildSubmitBody`.
 */
export interface SubmitBody {
  endpoint: "/v1/chat/completions";
  model: string;
  provider?: ProviderPin;
  completion_window: "24h";
  requests: BatchRequestItem[];
}

/** The validated subset of a batch object used for lifecycle decisions. */
export interface BatchSnapshot {
  id: string;
  status: string;
  createdAt: unknown;
  finalizedAt: unknown;
  requestCounts?: { total: number; completed: number; failed: number };
  hasResults: boolean;
  errorMessage?: string;
}

/**
 * Local structural checks before anything is sent (empty = OK). OpenRouter stays
 * authoritative for model/provider eligibility; this only rejects payloads we
 * know to be wrong. custom_id rules are checked separately (ids.customIdProblems).
 */
export function submitBodyProblems(body: SubmitBody): string[] {
  const problems: string[] = [];
  const keys = Object.keys(body);
  if (keys[keys.length - 1] !== "requests") problems.push(`"requests" must be the last top-level field (got order: ${keys.join(", ")})`);
  if (body.endpoint !== "/v1/chat/completions") problems.push(`unsupported endpoint ${String(body.endpoint)}`);
  if (typeof body.model !== "string" || !body.model.trim()) problems.push("batch-level model is empty");
  if (!Array.isArray(body.requests) || body.requests.length === 0) problems.push("batch has no requests");
  for (const [i, r] of (body.requests ?? []).entries()) {
    const messages = r.body?.messages;
    if (!Array.isArray(messages) || messages.length === 0) problems.push(`requests[${i}] has no messages`);
    else if (messages.some((m) => typeof m.content !== "string" || !m.content.trim())) problems.push(`requests[${i}] has an empty message`);
    const itemModel = (r.body as { model?: unknown } | undefined)?.model;
    if (itemModel !== undefined && itemModel !== body.model) problems.push(`requests[${i}] names model ${String(itemModel)}; one batch uses one model (${body.model})`);
  }
  return problems;
}

export function buildSubmitBody(input: {
  model: string;
  provider?: ProviderPin;
  requests: BatchRequestItem[];
}): SubmitBody {
  const body: SubmitBody = {
    endpoint: "/v1/chat/completions",
    model: input.model,
    ...(input.provider ? { provider: input.provider } : {}),
    completion_window: "24h",
    requests: input.requests,
  };
  return body;
}
