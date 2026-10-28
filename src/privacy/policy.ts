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
  /**
   * Normalised model ID -> the endpoint tags of its `:batch` model (GET /models/{id}:batch/endpoints). Batch jobs run
   * only on these, which are a different set from the sync endpoints that /endpoints/zdr lists. No entry: unknown.
   */
  batchEndpoints?: Record<string, string[]>;
  /** A load is still in flight (only meaningful when not fresh): refusals say so rather than suggesting a refresh. */
  loading?: true;
}

/**
 * The batch-route ZDR view of one model: its ZDR (sync) endpoint tags, its batch endpoint tags (undefined when they
 * were not loaded), and `pinnable`, the batch endpoints whose exact tag is on the ZDR list. A batch endpoint is
 * treated as ZDR when its tag appears on OpenRouter's ZDR list.
 */
export function batchZdrView(catalog: CatalogView | undefined, model: string): { zdr: string[]; batch?: string[]; pinnable: string[] } {
  const slug = normaliseModelSlug(model);
  const zdr = [...new Set((catalog?.zdr ?? []).filter((e) => e.model === slug).map((e) => e.provider))].sort();
  const map = catalog?.batchEndpoints;
  const batch = map && Object.hasOwn(map, slug) && Array.isArray(map[slug]) ? [...new Set(map[slug])].sort() : undefined;
  return { zdr, batch, pinnable: batch ? batch.filter((t) => zdr.includes(t)) : [] };
}

/** Why `model` can't run on the batch route at zdr from the catalog alone (fresh catalog, no pin, no allow-list), or undefined. */
function batchZdrRefusal(slug: string, view: ReturnType<typeof batchZdrView>): string | undefined {
  // No ZDR endpoint at all is definitive: knowing the batch endpoints (a refresh) could not change the answer.
  const noZdr = () => `Privacy level zdr: ${slug} has no batch endpoint on OpenRouter's ZDR list (its batch endpoints: ${view.batch ? view.batch.join(", ") || "none" : "unknown"}; ZDR endpoints: ${view.zdr.join(", ") || "none"})`;
  if (view.zdr.length === 0) return noZdr();
  if (!view.batch) return `Privacy level zdr: the batch endpoints of ${slug} could not be loaded this session (run /batch privacy refresh)`;
  return view.pinnable.length === 0 ? noZdr() : undefined;
}

/**
 * The API path of a model's `:batch` endpoint list, each segment URL-encoded (`:` kept). Undefined for an ID with an
 * empty, "." or ".." segment, which is never requested.
 */
export function batchEndpointsPath(model: string): string | undefined {
  const segments = normaliseModelSlug(model).split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return undefined;
  return `/models/${segments.map((s) => encodeURIComponent(s).replace(/%3A/gi, ":")).join("/")}:batch/endpoints`;
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
      reason: catalog?.loading
        ? "Privacy level zdr: the model catalog is still loading; try again in a moment"
        : "Privacy level zdr: model catalog not loaded this session, so ZDR providers can't be verified (run /batch privacy refresh)",
    };
  }
  const slug = normaliseModelSlug(model);
  // Batch jobs run on the model's :batch endpoints only, so the pin is the ZDR tags that are also batch endpoint tags
  // (exact tag equality); provider.only is checked by the Batch API against the batch endpoints.
  const view = batchZdrView(catalog, slug);
  const refusal = batchZdrRefusal(slug, view);
  if (refusal) return { ok: false, reason: refusal };
  let only = view.pinnable;
  if (allow.length) {
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
