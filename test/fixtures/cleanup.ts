import { CHAT_MANIFEST_SCHEMA_VERSION, type JobManifest } from "../../src/types.js";
import type { JobRegistry } from "../../src/registry.js";
import type { LocalStatus } from "../../src/state.js";

export interface MkJob {
  status?: LocalStatus;
  kind?: JobManifest["kind"];
  parentJobId?: string;
  threadId?: string;
  sourceJobId?: string;
  createdAt?: string;
  providerBatchId?: string;
}

/** Writes a minimal job manifest (schema v4) into the registry. */
export function mkJob(registry: JobRegistry, o: MkJob = {}): JobManifest {
  registry.ensureRoot();
  return registry.create(
    (localId) =>
      ({
        schemaVersion: CHAT_MANIFEST_SCHEMA_VERSION,
        localId,
        kind: o.kind ?? (o.threadId ? "chat" : "goal"),
        retryCount: 0,
        objective: `Job ${localId}`,
        model: "m",
        provider: "openrouter",
        account: "openrouter",
        endpoint: "/v1/chat/completions",
        format: "markdown",
        localStatus: o.status ?? "ready",
        requestCount: 1,
        customIds: [],
        createdAt: o.createdAt ?? new Date().toISOString(),
        pollAttempts: 0,
        consecutivePollFailures: 0,
        ...(o.parentJobId ? { parentJobId: o.parentJobId } : {}),
        ...(o.providerBatchId ? { providerBatchId: o.providerBatchId } : {}),
        ...(o.threadId ? { chat: { threadId: o.threadId, purpose: "turn", throughSeq: 1, titleItem: false } } : {}),
        ...(o.sourceJobId ? { synthesis: { sourceJobId: o.sourceJobId, expectedItems: 1, included: [], excluded: [], allowPartial: false } } : {}),
      }) as unknown as JobManifest,
  );
}
