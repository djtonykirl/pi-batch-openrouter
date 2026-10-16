import type { NormalisedUsage } from "./openrouter/normalise-result.js";
import type { ProviderPin } from "./openrouter/types.js";
import type { LocalStatus } from "./state.js";

/**
 * One Pi deferred goal = one OpenRouter batch = (in Release 1) one request.
 * `customIds` is an array so Release 2 can carry several request items.
 *
 * Persisted as `<storage>/<localId>/manifest.json` (atomic snapshot). The
 * append-only `events.jsonl` next to it is the lifecycle history.
 * All timestamps are ISO-8601 UTC strings.
 */
export interface JobManifest {
  schemaVersion: 1;
  localId: string;
  providerBatchId?: string;
  parentJobId?: string;
  retryCount: number;

  objective: string;
  model: string;
  /** Service the job was sent to. Always "openrouter" in Release 1. */
  provider: "openrouter";
  /** Pi provider/account alias whose API key is used (e.g. "openrouter-work"). */
  account: string;
  /** Optional upstream provider pin (`provider.only` in the OpenRouter request). */
  providerPin?: ProviderPin;
  endpoint: "/v1/chat/completions";
  format: "markdown" | "json";

  localStatus: LocalStatus;
  /** Verbatim provider status string; never interpreted as local status. */
  providerStatus?: string;

  requestCount: number;
  completedCount?: number;
  failedCount?: number;
  customIds: string[];

  createdAt: string;
  submittedAt?: string;
  providerCreatedAt?: string;
  finalizedAt?: string;
  retrievedAt?: string;
  injectedAt?: string;
  cancelRequestedAt?: string;

  nextPollAt?: string;
  lastPollAt?: string;
  pollAttempts: number;
  consecutivePollFailures: number;
  lastPollError?: { category: string; message: string; httpStatus?: number; at: string };

  usage?: NormalisedUsage;

  /** SHA-256 of the exact bytes POSTed to OpenRouter. */
  requestSha256?: string;
  /** SHA-256 of the canonical request with custom_ids masked; used for duplicate detection. */
  contentSha256?: string;

  context: { fileCount: number; characters: number; excludedCount: number };
  injectionCount: number;

  error?: { code: string; message: string };
  warnings: string[];
}

export interface JobEvent {
  id: string;
  localId: string;
  eventType: string;
  previousStatus?: LocalStatus;
  newStatus?: LocalStatus;
  eventAt: string;
  details?: Record<string, unknown>;
}
