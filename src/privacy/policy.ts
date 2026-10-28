import { providerAllowed } from "../openrouter/routing.js";
import type { ProviderPin } from "../openrouter/types.js";

/** Pure privacy policy: no I/O. Decides what provider fields a request may carry, or refuses. */

export type PrivacyLevel = "standard" | "no-training" | "zdr";

/** Ordered, least to most strict. */
export const PRIVACY_LEVELS: readonly PrivacyLevel[] = ["standard", "no-training", "zdr"];

export function isPrivacyLevel(v: unknown): v is PrivacyLevel {
  return typeof v === "string" && (PRIVACY_LEVELS as readonly string[]).includes(v);
}

export function stricter(a: PrivacyLevel, b: PrivacyLevel): PrivacyLevel {
  return PRIVACY_LEVELS.indexOf(a) >= PRIVACY_LEVELS.indexOf(b) ? a : b;
}

export function effectiveLevel(project: PrivacyLevel, thread?: PrivacyLevel): PrivacyLevel {
  return thread ? stricter(project, thread) : project;
}

/** Strips the `:batch` and `:free` suffixes so catalog lookups match the base model ID. */
export function normaliseModelSlug(id: string): string {
  return id.replace(/:(batch|free)$/, "");
}

export type Route = "batch" | "immediate";

export function routeForModel(id: string, explicit?: Route): Route {
  if (explicit) return explicit;
  return id.endsWith(":free") ? "immediate" : "batch";
}

/** `model` is already normalised; `provider` is a slug usable in `provider.only`. */
export interface ZdrEndpoint {
  model: string;
  provider: string;
}

export interface CatalogView {
  fresh: boolean;
  zdr: ZdrEndpoint[];
}

export type ProviderDecision =
  | { ok: true; provider?: { only: string[]; allow_fallbacks: false } | ProviderPin; enforcement: string }
  | { ok: false; reason: string };

export function resolveBatchProvider(input: {
  level: PrivacyLevel;
  model: string;
  userPin?: ProviderPin;
  catalog?: CatalogView;
  accountNoTraining: boolean;
  /** routing.allowedProviders (trimmed); at zdr the ZDR endpoint tags are intersected with it. Empty or absent: no restriction. */
  allowedProviders?: readonly string[];
}): ProviderDecision {
  const { level, model, userPin, catalog, accountNoTraining } = input;
  const allow = input.allowedProviders ?? [];
  if (level === "standard") return { ok: true, provider: userPin, enforcement: "none" };
  if (level === "no-training") {
    if (accountNoTraining) return { ok: true, provider: userPin, enforcement: "account attested no-training" };
    return {
      ok: false,
      reason:
        "Privacy level no-training: batch providers can't be filtered per request; confirm your OpenRouter account disables training (/batch privacy attest) or use an immediate-route model",
    };
  }
  if (!catalog?.fresh) {
    return {
      ok: false,
      reason: "Privacy level zdr: model catalog not loaded this session, so ZDR providers can't be verified (run /batch privacy refresh)",
    };
  }
  const slug = normaliseModelSlug(model);
  let only = [...new Set(catalog.zdr.filter((e) => e.model === slug).map((e) => e.provider))].sort();
  if (allow.length && only.length) {
    only = only.filter((p) => providerAllowed(allow, p));
    if (only.length === 0) return { ok: false, reason: `Privacy level zdr: no ZDR provider for ${slug} within routing.allowedProviders (${allow.join(", ")})` };
  }
  // routing.allowFallbacks never applies here: the ZDR pin is always without fallbacks.
  if (userPin) only = only.filter((p) => providerAllowed(userPin.only, p));
  if (only.length === 0) {
    return {
      ok: false,
      reason: `Privacy level zdr: no ZDR provider available for ${slug}${userPin ? " within your provider pin" : ""}`,
    };
  }
  return { ok: true, provider: { only, allow_fallbacks: false }, enforcement: `pinned to ZDR providers: ${only.join(", ")}` };
}

/** Retention lines (`/batch show`, `/batch chat context`, web job detail). */
export const RETENTION_DELETED = "Batch jobs are held at OpenRouter until finished; deleted after retrieval, or once they fail, expire or are cancelled";
export const RETENTION_KEPT = "Batch jobs are kept up to 30 days";

/** routing.allowedProviders as the immediate route sends it. */
export interface ImmediateAllowList {
  only: string[];
  allowFallbacks: boolean;
}

/**
 * The immediate (chat/completions) `provider` object: the privacy fields for the level and, with a non-empty
 * allow-list, `only` (in list order) plus `allow_fallbacks: false` when fallbacks are off. Empty: nothing to send.
 */
export function immediateProviderFields(
  level: PrivacyLevel,
  allowList?: ImmediateAllowList,
): { only?: string[]; allow_fallbacks?: false; data_collection?: "deny"; zdr?: true } {
  const routing = allowList && allowList.only.length ? { only: [...allowList.only], ...(allowList.allowFallbacks ? {} : { allow_fallbacks: false as const }) } : {};
  if (level === "no-training") return { ...routing, data_collection: "deny" };
  if (level === "zdr") return { ...routing, zdr: true };
  return routing;
}
