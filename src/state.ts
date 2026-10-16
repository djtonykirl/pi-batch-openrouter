/**
 * Local job lifecycle. Deliberately separate from the provider's status string,
 * which is stored verbatim alongside (`providerStatus`).
 */
export const LOCAL_STATUSES = [
  "draft",
  "previewed",
  "submitting",
  "submitted",
  "polling",
  "provider_completed",
  "retrieving",
  "ready",
  "partial",
  "failed",
  "cancel_requested",
  "cancelled",
  "expired",
  "corrupt",
] as const;

export type LocalStatus = (typeof LOCAL_STATUSES)[number];

const TRANSITIONS: Record<LocalStatus, readonly LocalStatus[]> = {
  draft: ["previewed", "failed"],
  previewed: ["submitting", "cancelled"],
  // `failed` from submitting covers both an explicit provider rejection and a
  // crash/timeout where acceptance is unknown (error_code: submission_unknown).
  submitting: ["submitted", "failed"],
  submitted: ["polling", "cancel_requested", "failed"],
  polling: ["polling", "provider_completed", "partial", "failed", "expired", "cancelled", "cancel_requested"],
  // Results can be absent on a completed batch (e.g. HTTP 402); retrieval then
  // returns to provider_completed and is retried on the next poll.
  provider_completed: ["retrieving", "failed"],
  retrieving: ["ready", "partial", "failed", "corrupt", "provider_completed"],
  // Provider cancellation is not a documented OpenRouter endpoint, so a
  // cancel request can lose the race to any provider terminal state.
  cancel_requested: ["cancel_requested", "cancelled", "provider_completed", "failed", "expired"],
  ready: [],
  partial: [],
  failed: [],
  cancelled: [],
  expired: [],
  corrupt: [],
};

export const TERMINAL_STATUSES: ReadonlySet<LocalStatus> = new Set(
  LOCAL_STATUSES.filter((s) => TRANSITIONS[s].length === 0),
);

/** Jobs the poller must reconcile with OpenRouter. */
export const POLLABLE_STATUSES: ReadonlySet<LocalStatus> = new Set<LocalStatus>([
  "submitted",
  "polling",
  "provider_completed",
  "cancel_requested",
]);

/** Jobs that represent in-flight inference (used for duplicate detection and the badge). */
export const ACTIVE_STATUSES: ReadonlySet<LocalStatus> = new Set<LocalStatus>([
  "submitting",
  "submitted",
  "polling",
  "provider_completed",
  "retrieving",
  "cancel_requested",
]);

export function isLocalStatus(value: unknown): value is LocalStatus {
  return typeof value === "string" && (LOCAL_STATUSES as readonly string[]).includes(value);
}

export function canTransition(from: LocalStatus, to: LocalStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class IllegalTransitionError extends Error {
  constructor(
    public readonly from: LocalStatus,
    public readonly to: LocalStatus,
    public readonly localId?: string,
  ) {
    super(`Illegal job transition ${from} -> ${to}${localId ? ` for ${localId}` : ""}`);
    this.name = "IllegalTransitionError";
  }
}

export function assertTransition(from: LocalStatus, to: LocalStatus, localId?: string): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to, localId);
}

export function allowedTransitions(from: LocalStatus): readonly LocalStatus[] {
  return TRANSITIONS[from];
}
