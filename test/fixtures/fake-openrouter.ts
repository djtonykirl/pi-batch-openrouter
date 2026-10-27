import * as path from "node:path";
import { DEFAULT_CONFIG, type BatchConfig } from "../../src/config.js";
import { OpenRouterBatchClient, type FetchLike } from "../../src/openrouter/client.js";
import { JobRegistry } from "../../src/registry.js";
import { BatchService } from "../../src/service.js";
import type { JobManifest } from "../../src/types.js";
import { batchObject } from "./openrouter.js";

export const FAKE_KEY = "sk-or-v1-" + "fa4e".repeat(16);

/**
 * Provider-side rules the fake enforces on every submission. These reflect what
 * real testing showed (custom_id charset: HTTP 422 from an Anthropic batch
 * endpoint, 2026-10-17) and what OpenRouter documents (minItems 1, unique
 * custom_id, `requests` after the other top-level fields). Passing the fake does
 * NOT prove every upstream rule is met.
 */
export const PROVIDER_CUSTOM_ID = /^[A-Za-z0-9_-]{1,64}$/;

export type Reply = { status: number; body: unknown } | Error | (() => Promise<{ status: number; body: unknown }>);

/** Scripted OpenRouter: queues of replies per route; records every request; validates submissions. */
export class FakeOpenRouter {
  public readonly requests: Array<{ method: string; url: string; headers: Record<string, string>; body?: string }> = [];
  public submitReplies: Reply[] = [];
  public getReplies: Reply[] = [];
  public cancelReplies: Reply[] = [];
  public deleteReplies: Reply[] = [];
  public offline = false;
  /** Bodies of submissions that passed validation, in order. */
  public readonly accepted: Array<{ model: string; requests: Array<{ custom_id: string; body: unknown }> }> = [];

  public readonly fetch: FetchLike = async (url, init) => {
    this.requests.push({ method: init.method, url, headers: init.headers, body: init.body });
    if (this.offline) throw new TypeError("fetch failed (offline)");
    const isSubmit = init.method === "POST" && url.endsWith("/batches");
    if (isSubmit) {
      const rejection = validateSubmission(init.body ?? "");
      if (rejection) return { status: rejection.status, text: async () => JSON.stringify({ error: { code: rejection.status, message: rejection.message } }) };
      this.accepted.push(JSON.parse(init.body!));
    }
    const queue = isSubmit ? this.submitReplies : init.method === "DELETE" ? this.deleteReplies : url.endsWith("/cancel") ? this.cancelReplies : this.getReplies;
    const reply = queue.length > 1 ? queue.shift()! : queue[0];
    if (!reply) throw new Error(`no scripted reply for ${init.method} ${url}`);
    if (reply instanceof Error) throw reply;
    const r = typeof reply === "function" ? await reply() : reply;
    return { status: r.status, text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)) };
  };

  /** custom_ids of the most recently accepted submission, in submission order. */
  public lastCustomIds(): string[] {
    return this.accepted[this.accepted.length - 1]!.requests.map((r) => r.custom_id);
  }
}

export function validateSubmission(bodyText: string): { status: number; message: string } | undefined {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return { status: 400, message: "invalid JSON" };
  }
  const keys = Object.keys(body);
  if (keys[keys.length - 1] !== "requests") return { status: 400, message: "requests must come after endpoint/model/provider/completion_window" };
  const requests = body.requests as Array<{ custom_id?: unknown; body?: { model?: unknown } }>;
  if (!Array.isArray(requests) || requests.length === 0) return { status: 400, message: "requests must contain at least one item" };
  const seen = new Set<string>();
  for (const [i, r] of requests.entries()) {
    if (typeof r.custom_id !== "string" || !r.custom_id) return { status: 400, message: `custom_id is required on requests[${i}]` };
    if (!PROVIDER_CUSTOM_ID.test(r.custom_id)) {
      return { status: 422, message: `Request at line ${i + 1} has an invalid custom_id '${r.custom_id}'; this provider's custom_id may only contain characters in [A-Za-z0-9_-].` };
    }
    if (seen.has(r.custom_id)) return { status: 422, message: `duplicate custom_id '${r.custom_id}'` };
    seen.add(r.custom_id);
    if (r.body?.model !== undefined && r.body.model !== body.model) return { status: 400, message: `requests[${i}] model differs from batch model` };
  }
  return undefined;
}

export function makeConfig(over: (c: BatchConfig) => void = () => {}): BatchConfig {
  const c = structuredClone(DEFAULT_CONFIG);
  c.polling.intervalSeconds = 60;
  c.polling.maxBackoffSeconds = 900;
  over(c);
  return c;
}

export function makeService(root: string, fake: FakeOpenRouter, cfg = makeConfig(), settled: JobManifest[] = []): BatchService {
  return new BatchService({
    registry: new JobRegistry(path.join(root, ".pi", "batches")),
    workspaceRoot: root,
    getConfig: () => cfg,
    resolveApiKey: async () => FAKE_KEY,
    createClient: (apiKey, timeoutMs) => new OpenRouterBatchClient({ apiKey, fetchImpl: fake.fetch, timeoutMs }),
    gitIgnored: () => new Set(),
    onSettled: (j) => settled.push(j),
  });
}

export function accepted(id = "batch_123") {
  return { status: 202, body: batchObject({ id }) };
}
