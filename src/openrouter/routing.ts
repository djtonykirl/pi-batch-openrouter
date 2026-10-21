import type { BatchConfig } from "../config.js";
import type { ProviderPin } from "./types.js";

/**
 * Provider routing policy for batch submissions.
 *
 * The Batch API accepts only `provider.only` and `provider.allow_fallbacks`; the sync
 * preferences (`order`, `sort`, `zdr`, `data_collection`, …) are rejected
 * (https://openrouter.ai/docs/batch-quickstart, verified 2026-10-21). So:
 *
 *   - routing.allowedProviders becomes `provider.only` on every batch (an allow-list);
 *   - zero data retention and data-collection rules cannot be sent with a batch. They are
 *     enforced by the OpenRouter account's privacy settings (or a guardrail on the key).
 *     When the local policy requires them, the user must attest that the account enforces
 *     them, otherwise planning is blocked.
 */

export interface ResolvedRouting {
  pin?: ProviderPin;
  blockers: string[];
}

const uniq = (xs: readonly string[]): string[] => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];

/** Applies the routing policy to an optional explicit `--provider` pin. */
export function resolveRouting(config: BatchConfig, explicitPin?: string): ResolvedRouting {
  const r = config.routing;
  const allow = uniq(r.allowedProviders);
  const blockers: string[] = [];
  let pin: ProviderPin | undefined;
  if (explicitPin) {
    if (allow.length && !allow.includes(explicitPin)) blockers.push(`provider pin ${JSON.stringify(explicitPin)} is not in routing.allowedProviders (${allow.join(", ")})`);
    pin = { only: [explicitPin], allow_fallbacks: false };
  } else if (allow.length) {
    pin = { only: allow, allow_fallbacks: r.allowFallbacks };
  }
  if (r.requireZdr && !r.accountZdrEnforced) {
    blockers.push("routing.requireZdr is set, but zero data retention cannot be requested on a batch submission. Enable ZDR in the OpenRouter account's privacy settings (or a guardrail on this key), then set routing.accountZdrEnforced to true.");
  }
  if (r.requireNoDataCollection && !r.accountDataCollectionDenied) {
    blockers.push("routing.requireNoDataCollection is set, but data-collection preferences cannot be sent on a batch submission. Deny prompt training/data collection in the OpenRouter account's privacy settings, then set routing.accountDataCollectionDenied to true.");
  }
  return { pin, blockers };
}

/** One-line description of a pin, for previews and status views. */
export function formatPin(pin: ProviderPin | undefined): string {
  if (!pin) return "none";
  return `${pin.only.join(",")} (${pin.allow_fallbacks === false ? "no fallbacks" : "fallbacks within the list"})`;
}

/** The account-level privacy requirements, for previews. */
export function formatPrivacyPolicy(config: BatchConfig): string {
  const r = config.routing;
  const part = (required: boolean, attested: boolean, what: string) => (required ? `${what} required (${attested ? "account-enforced, attested" : "NOT attested"})` : `${what} not required`);
  return `${part(r.requireZdr, r.accountZdrEnforced, "ZDR")}; ${part(r.requireNoDataCollection, r.accountDataCollectionDenied, "no data collection")}`;
}
