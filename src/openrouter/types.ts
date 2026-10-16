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
