import type { BatchSnapshot, SubmitBody } from "./types.js";
import type { CatalogModel } from "../models/catalog.js";
import { normaliseModelSlug, type ZdrEndpoint } from "../privacy/policy.js";

export interface HttpResponseLike {
  status: number;
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<HttpResponseLike>;

export type ErrorCategory =
  | "network"
  | "timeout"
  | "auth"
  | "payment"
  | "not_found"
  | "conflict"
  | "gone"
  | "too_large"
  | "invalid_request"
  | "rate_limited"
  | "server"
  | "protocol";

const TRANSIENT: ReadonlySet<ErrorCategory> = new Set(["network", "timeout", "rate_limited", "server"]);

/** Never carries headers or the API key; `detail` is a bounded, redacted provider message. */
export class OpenRouterError extends Error {
  public readonly transient: boolean;
  constructor(
    public readonly category: ErrorCategory,
    public readonly httpStatus: number | undefined,
    public readonly detail: string,
    public readonly operation: string,
    /** Provider response body (for evidence files only; never put into log messages). */
    public readonly rawBody?: string,
  ) {
    super(`OpenRouter ${operation} ${category}${httpStatus ? ` (HTTP ${httpStatus})` : ""}: ${detail}`);
    this.name = "OpenRouterError";
    this.transient = TRANSIENT.has(category);
  }
}

export function categoriseHttpStatus(status: number): ErrorCategory {
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "payment";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 410) return "gone";
  if (status === 413) return "too_large";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server";
  return "invalid_request";
}

/** Raw HTTP exchange; `bodyText` is exactly what the provider sent (preserved on disk as evidence). */
export interface RawExchange {
  status: number;
  bodyText: string;
}

export interface ClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export class OpenRouterBatchClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(private readonly opts: ClientOptions) {
    if (!opts.apiKey) throw new OpenRouterError("auth", undefined, "missing API key", "init");
    this.baseUrl = (opts.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  /** POST /batches. HTTP 202 + status "validating" means accepted, not completed. */
  public async submit(body: SubmitBody, bodyText: string = JSON.stringify(body)): Promise<{ raw: RawExchange; batch: BatchSnapshot }> {
    const raw = await this.request("POST", "/batches", "submit", bodyText);
    return { raw, batch: parseBatchObject(raw.bodyText, "submit") };
  }

  /**
   * GET /batches/{id}. Terminal batches include results inline.
   * HTTP 402 ("finalized cost exceeds balance") still carries batch metadata with
   * `results: null`; that is surfaced as `paymentRequired` instead of an exception.
   */
  public async get(batchId: string): Promise<{ raw: RawExchange; batch: BatchSnapshot; paymentRequired?: boolean }> {
    try {
      const raw = await this.request("GET", `/batches/${encodeURIComponent(batchId)}`, "get");
      return { raw, batch: parseBatchObject(raw.bodyText, "get") };
    } catch (err) {
      if (err instanceof OpenRouterError && err.httpStatus === 402 && err.rawBody) {
        try {
          const batch = parseBatchObject(err.rawBody, "get");
          return { raw: { status: 402, bodyText: err.rawBody }, batch, paymentRequired: true };
        } catch {
          // 402 without batch metadata: fall through to the original error
        }
      }
      throw err;
    }
  }

  /**
   * OpenRouter documents a `cancelling`/`cancelled` status but NO cancel endpoint
   * (2026-10). This tries the OpenAI-compatible `POST /batches/{id}/cancel` that
   * earlier versions of this extension used; 404/405 is reported as unsupported
   * rather than as an error. Callers must reconcile the real outcome by polling.
   */
  public async cancel(batchId: string): Promise<{ supported: boolean; raw?: RawExchange; detail?: string }> {
    try {
      const raw = await this.request("POST", `/batches/${encodeURIComponent(batchId)}/cancel`, "cancel");
      return { supported: true, raw };
    } catch (err) {
      if (err instanceof OpenRouterError && (err.httpStatus === 404 || err.httpStatus === 405)) {
        return { supported: false, detail: err.detail };
      }
      throw err;
    }
  }

  /** GET /models (public catalog). */
  public async listModels(): Promise<{ raw: RawExchange; models: CatalogModel[] }> {
    const raw = await this.request("GET", "/models", "models");
    return { raw, models: parseModels(raw.bodyText) };
  }

  /** GET /endpoints/zdr: every endpoint OpenRouter lists as zero-data-retention. */
  public async listZdrEndpoints(): Promise<{ raw: RawExchange; endpoints: ZdrEndpoint[] }> {
    const raw = await this.request("GET", "/endpoints/zdr", "zdr");
    return { raw, endpoints: parseZdrEndpoints(raw.bodyText) };
  }

  private async request(method: string, pathName: string, operation: string, body?: string): Promise<RawExchange> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.opts.apiKey}`,
      "HTTP-Referer": "https://github.com/mastnacek/pi-batch-openrouter",
      "X-Title": "pi-batch-openrouter",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    // Enforce the timeout ourselves as well as via the signal: a stalled body read
    // (or a fetch that ignores AbortSignal) must not hang a poll forever.
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(Object.assign(new Error(`no response within ${this.timeoutMs} ms`), { name: "AbortError" }));
      }, this.timeoutMs);
    });
    let res: HttpResponseLike;
    let text: string;
    try {
      res = await Promise.race([this.fetchImpl(`${this.baseUrl}${pathName}`, { method, headers, body, signal: controller.signal }), timedOut]);
      text = await Promise.race([res.text(), timedOut]);
    } catch (err) {
      const aborted = controller.signal.aborted || (err as Error)?.name === "AbortError";
      throw new OpenRouterError(aborted ? "timeout" : "network", undefined, this.redact(String((err as Error)?.message ?? err)), operation);
    } finally {
      clearTimeout(timer);
    }

    if (res.status < 200 || res.status >= 300) {
      throw new OpenRouterError(
        categoriseHttpStatus(res.status),
        res.status,
        this.redact(extractErrorMessage(text)),
        operation,
        this.redact(text),
      );
    }
    return { status: res.status, bodyText: text };
  }

  private redact(text: string): string {
    return redactSecretValue(text, this.opts.apiKey);
  }
}

export function redactSecretValue(text: string, secret: string | undefined): string {
  if (!secret || secret.length < 8) return text;
  return text.split(secret).join("[REDACTED]");
}

function extractErrorMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } };
    if (typeof parsed?.error?.message === "string") return parsed.error.message.slice(0, 500);
  } catch {
    // non-JSON body
  }
  return text.slice(0, 300) || "(empty body)";
}

function parseDataArray(text: string, operation: string): Record<string, unknown>[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new OpenRouterError("protocol", undefined, "response is not valid JSON", operation);
  }
  const data = json && typeof json === "object" ? (json as Record<string, unknown>).data : undefined;
  if (!Array.isArray(data)) throw new OpenRouterError("protocol", undefined, "response has no data array", operation);
  return data.filter((e): e is Record<string, unknown> => !!e && typeof e === "object");
}

/** Parses GET /models. A model is free when its ID ends in `:free` or both prices are exactly "0". */
export function parseModels(text: string): CatalogModel[] {
  const out: CatalogModel[] = [];
  for (const e of parseDataArray(text, "models")) {
    if (typeof e.id !== "string" || !e.id) continue;
    const pricing = (e.pricing ?? {}) as Record<string, unknown>;
    const model: CatalogModel = {
      id: e.id,
      name: typeof e.name === "string" ? e.name : e.id,
      free: e.id.endsWith(":free") || (pricing.prompt === "0" && pricing.completion === "0"),
    };
    if (typeof e.context_length === "number") model.contextLength = e.context_length;
    out.push(model);
  }
  return out;
}

/**
 * Parses GET /endpoints/zdr. Each entry has `model_id` and an endpoint `tag` such as
 * `azure/eu`, `makora/bf16` or `amazon-bedrock`. The full tag is kept as `provider`: it is
 * the `provider[/variant][/region][/tier]` slug that `provider.only` accepts, whereas the base
 * slug would match every endpoint of that provider, including non-ZDR ones
 * (https://openrouter.ai/docs/guides/routing/provider-selection). Duplicate pairs are dropped.
 */
export function parseZdrEndpoints(text: string): ZdrEndpoint[] {
  const out: ZdrEndpoint[] = [];
  const seen = new Set<string>();
  for (const e of parseDataArray(text, "zdr")) {
    if (typeof e.model_id !== "string" || typeof e.tag !== "string" || !e.model_id || !e.tag) continue;
    const model = normaliseModelSlug(e.model_id);
    const key = model + " " + e.tag;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ model, provider: e.tag });
  }
  return out;
}

/** Minimal structural validation of a batch object. Unknown fields are tolerated (and preserved in raw). */
export function parseBatchObject(text: string, operation: string): BatchSnapshot {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new OpenRouterError("protocol", undefined, "response is not valid JSON", operation);
  }
  if (!json || typeof json !== "object") throw new OpenRouterError("protocol", undefined, "response is not an object", operation);
  const o = json as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id) throw new OpenRouterError("protocol", undefined, "batch object missing id", operation);
  if (typeof o.status !== "string" || !o.status) throw new OpenRouterError("protocol", undefined, "batch object missing status", operation);
  const rc = o.request_counts as Record<string, unknown> | null | undefined;
  const requestCounts =
    rc && typeof rc.total === "number" && typeof rc.completed === "number" && typeof rc.failed === "number"
      ? { total: rc.total, completed: rc.completed, failed: rc.failed }
      : undefined;
  const err = o.error as { message?: unknown } | null | undefined;
  return {
    id: o.id,
    status: o.status,
    createdAt: o.created_at,
    finalizedAt: o.finalized_at,
    requestCounts,
    hasResults: Array.isArray(o.results),
    errorMessage: err && typeof err.message === "string" ? err.message : undefined,
  };
}
