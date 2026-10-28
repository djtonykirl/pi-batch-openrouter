import type { BatchConfig } from "../config.js";
import type { PrivacyLevel } from "../privacy/policy.js";
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
 *
 * Linked with the privacy levels (src/privacy/policy.ts): a job whose effective level is
 * `zdr` is pinned per request to ZDR endpoints (intersected with the allow-list), so it
 * satisfies routing.requireZdr; `no-training` and `zdr` satisfy
 * routing.requireNoDataCollection (on the batch route only with the account's no-training
 * attestation, which the level itself requires; on the immediate route per request).
 */

export interface ResolvedRouting {
  pin?: ProviderPin;
  blockers: string[];
}

const uniq = (xs: readonly string[]): string[] => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];

/** routing.allowedProviders, trimmed and de-duplicated; empty means no restriction. */
export function allowedProviders(config: BatchConfig): string[] {
  return uniq(config.routing.allowedProviders);
}

/** An allow-list entry admits a provider slug equal to it, or one whose base provider (before the first "/") it names: `azure` admits `azure/eu`. */
export function providerAllowed(allow: readonly string[], slug: string): boolean {
  if (allow.includes(slug)) return true;
  const i = slug.indexOf("/");
  return i > 0 && allow.includes(slug.slice(0, i));
}

/** The allow-list as a pin, or undefined when there is none. */
export function allowListPin(config: BatchConfig): ProviderPin | undefined {
  const allow = allowedProviders(config);
  return allow.length ? { only: allow, allow_fallbacks: config.routing.allowFallbacks } : undefined;
}

/** A blocker when a pin names a provider outside the allow-list (none when there is no allow-list). */
export function pinOutsideAllowList(config: BatchConfig, pin: ProviderPin | undefined): string | undefined {
  const allow = allowedProviders(config);
  if (!pin || !allow.length) return undefined;
  const outside = pin.only.filter((p) => !providerAllowed(allow, p));
  if (!outside.length) return undefined;
  return `provider pin ${outside.map((p) => JSON.stringify(p)).join(", ")} is not in routing.allowedProviders (${allow.join(", ")})`;
}

/**
 * routing.requireZdr / requireNoDataCollection. Each is satisfied by the account attestation
 * or by the job's effective privacy level (zdr pins ZDR endpoints per request; no-training and
 * zdr deny data collection). `level` absent means the level isn't known: master's attestation-only rule.
 */
export function accountRequirementBlockers(config: BatchConfig, level?: PrivacyLevel, route: "batch" | "immediate" = "batch"): string[] {
  const r = config.routing;
  const blockers: string[] = [];
  // The batch texts are master's; an immediate-route refusal is worded without "batch submission".
  const immediate = (what: string, attestation: string) =>
    `${what} is set, but it cannot be guaranteed for this request at privacy level ${level ?? "standard"} without the account attestation. Raise the privacy level, or confirm the OpenRouter account enforces it and set ${attestation} to true.`;
  if (r.requireZdr && !r.accountZdrEnforced && level !== "zdr") {
    if (route === "immediate") blockers.push(immediate("routing.requireZdr", "routing.accountZdrEnforced"));
    else blockers.push("routing.requireZdr is set, but zero data retention cannot be requested on a batch submission. Enable ZDR in the OpenRouter account's privacy settings (or a guardrail on this key), then set routing.accountZdrEnforced to true.");
  }
  if (r.requireNoDataCollection && !r.accountDataCollectionDenied && level !== "no-training" && level !== "zdr") {
    if (route === "immediate") blockers.push(immediate("routing.requireNoDataCollection", "routing.accountDataCollectionDenied"));
    else blockers.push("routing.requireNoDataCollection is set, but data-collection preferences cannot be sent on a batch submission. Deny prompt training/data collection in the OpenRouter account's privacy settings, then set routing.accountDataCollectionDenied to true.");
  }
  return blockers;
}

/**
 * Applies the routing policy to an optional explicit `--provider` pin. `level` is the job's
 * effective privacy level when known (the project level at prepare time); it can satisfy the
 * account requirements (see accountRequirementBlockers).
 */
export function resolveRouting(config: BatchConfig, explicitPin?: string, level?: PrivacyLevel): ResolvedRouting {
  const blockers: string[] = [];
  let pin: ProviderPin | undefined;
  if (explicitPin) {
    pin = { only: [explicitPin], allow_fallbacks: false };
    const outside = pinOutsideAllowList(config, pin);
    if (outside) blockers.push(outside);
  } else {
    pin = allowListPin(config);
  }
  blockers.push(...accountRequirementBlockers(config, level));
  return { pin, blockers };
}

/** One-line description of a pin, for previews and status views. */
export function formatPin(pin: ProviderPin | undefined): string {
  if (!pin) return "none";
  return `${pin.only.join(",")} (${pin.allow_fallbacks === false ? "no fallbacks" : "fallbacks within the list"})`;
}

/** A preview's pin: at an effective level of zdr the job is pinned to ZDR endpoints when it is created, not to this pin. */
export const ZDR_PIN_PREVIEW = "pinned to ZDR endpoints when the job is created";
export function previewPin(pin: ProviderPin | undefined, level?: PrivacyLevel): string {
  return level === "zdr" ? ZDR_PIN_PREVIEW : formatPin(pin);
}

/**
 * The account-level privacy requirements, for previews (batch route). With `privacy`, a requirement the level
 * satisfies says so; no-training satisfies requireNoDataCollection on a batch only with the no-training attestation.
 */
export function formatPrivacyPolicy(config: BatchConfig, privacy?: { level: PrivacyLevel; accountNoTraining: boolean }): string {
  const r = config.routing;
  const level = privacy?.level;
  const part = (required: boolean, attested: boolean, byLevel: boolean, what: string, note = "") =>
    // Names the setting, so "off" never reads as a privacy claim at a strict level.
    required ? `${what}: on (${attested ? "account-enforced, attested" : byLevel ? `satisfied by privacy level ${level}` : "NOT attested"})${note}` : `${what}: off`;
  const ntUnattested = level === "no-training" && !privacy?.accountNoTraining;
  return `${part(r.requireZdr, r.accountZdrEnforced, level === "zdr", "routing.requireZdr")}; ${part(
    r.requireNoDataCollection,
    r.accountDataCollectionDenied,
    level === "zdr" || (level === "no-training" && !ntUnattested),
    "routing.requireNoDataCollection",
    ntUnattested && !r.accountDataCollectionDenied ? " (needs /batch privacy attest)" : "",
  )}`;
}

/** The routing policy in one line, for `/batch privacy` and the web privacy panel. */
export function formatRoutingPolicy(config: BatchConfig, privacy?: { level: PrivacyLevel; accountNoTraining: boolean }): string {
  return `Provider allow-list: ${formatPin(allowListPin(config))}; ${formatPrivacyPolicy(config, privacy)}`;
}
