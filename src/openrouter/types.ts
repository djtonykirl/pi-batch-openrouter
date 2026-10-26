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

export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "file"; file: { filename: string; file_data: string } };

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  /** Optional multimodal parts (images / PDF files); converted to wire `content` array by `buildSubmitBody`. */
  parts?: ChatContentPart[];
}

export interface WireChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ChatContentPart[];
}

export interface BatchRequestItem {
  custom_id: string;
  body: {
    messages: Array<ChatMessage | WireChatMessage>;
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

export function messageText(m: ChatMessage | WireChatMessage): string {
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .map((p) => (p.type === "text" ? p.text : p.type === "file" ? `[file: ${p.file.filename}]` : "[image]"))
      .join("\n");
  }
  return "";
}

function isMessageEmpty(m: ChatMessage | WireChatMessage): boolean {
  if (typeof m.content === "string") return !m.content.trim();
  if (Array.isArray(m.content)) {
    return m.content.length === 0 || m.content.every((p) => (p.type === "text" ? !p.text.trim() : false));
  }
  return true;
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
    else if (messages.some(isMessageEmpty)) problems.push(`requests[${i}] has an empty message`);
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
  const requests: BatchRequestItem[] = input.requests.map((req) => {
    const messages = req.body.messages.map((m): ChatMessage | WireChatMessage => {
      if ("parts" in m && Array.isArray(m.parts) && m.parts.length > 0) {
        return {
          role: m.role,
          content: [{ type: "text", text: m.content }, ...m.parts],
        };
      }
      if ("parts" in m) {
        const { parts: _parts, ...rest } = m;
        return rest;
      }
      return m;
    });
    return {
      ...req,
      body: {
        ...req.body,
        messages,
      },
    };
  });
  const body: SubmitBody = {
    endpoint: "/v1/chat/completions",
    model: input.model,
    ...(input.provider ? { provider: input.provider } : {}),
    completion_window: "24h",
    requests,
  };
  return body;
}
