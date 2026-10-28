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
}): ProviderDecision {
  const { level, model, userPin, catalog, accountNoTraining } = input;
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
  if (userPin) only = only.filter((p) => userPin.only.includes(p));
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

export function immediateProviderFields(level: PrivacyLevel): { data_collection?: "deny"; zdr?: true } {
  if (level === "no-training") return { data_collection: "deny" };
  if (level === "zdr") return { zdr: true };
  return {};
}
