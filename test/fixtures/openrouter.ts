/**
 * Provider response fixtures modelled on https://openrouter.ai/docs/batch-quickstart
 * (2026-10-16). Timestamps are Unix SECONDS as documented.
 */

export const CREATED_AT_S = 1_792_074_000; // 2026-10-15T14:20:00Z
export const FINALIZED_AT_S = 1_792_074_370;

export function batchObject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "batch_123",
    object: "batch",
    endpoint: "/v1/chat/completions",
    model: "openai/gpt-4o",
    completion_window: "24h",
    status: "validating",
    created_at: CREATED_AT_S,
    finalized_at: null,
    request_counts: { total: 1, completed: 0, failed: 0 },
    usage: null,
    results: null,
    error: null,
    ...overrides,
  };
}

export function successItem(customId: string, content: unknown = "Analysis text.", extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "batch_req_1",
    custom_id: customId,
    response: {
      status_code: 200,
      request_id: "request_1",
      body: {
        id: "gen-batch-1792074370-abc",
        object: "chat.completion",
        created: FINALIZED_AT_S,
        model: "openai/gpt-4o",
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        ...extra,
      },
    },
    error: null,
  };
}

export function failedItem(customId: string): Record<string, unknown> {
  return {
    id: "batch_req_2",
    custom_id: customId,
    response: null,
    error: { type: "invalid_request_error", message: "context length exceeded", param: null, error_type: "invalid_request" },
  };
}

export const USAGE = { prompt_tokens: 20, completion_tokens: 40, total_tokens: 60, cost: 0.000225, is_byok: false };

export const BYOK_USAGE = {
  prompt_tokens: 20,
  completion_tokens: 40,
  total_tokens: 60,
  cost: 0.00001,
  is_byok: true,
  cost_details: { upstream_inference_cost: 0.0004, upstream_inference_prompt_cost: 0.0001, upstream_inference_completions_cost: 0.0003 },
};

export function completed(results: unknown[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const failed = results.filter((r) => (r as { error?: unknown }).error).length;
  return batchObject({
    status: "completed",
    finalized_at: FINALIZED_AT_S,
    request_counts: { total: results.length, completed: results.length - failed, failed },
    usage: USAGE,
    results,
    ...overrides,
  });
}

/** A non-streaming POST /chat/completions response (the immediate route). */
export function chatCompletion(content: unknown = "Free reply.", usage: Record<string, unknown> = { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20, cost: 0 }): Record<string, unknown> {
  return {
    id: "gen-1792074400-free",
    object: "chat.completion",
    created: FINALIZED_AT_S,
    model: "meta/llama-free:free",
    provider: "Example",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage,
  };
}
