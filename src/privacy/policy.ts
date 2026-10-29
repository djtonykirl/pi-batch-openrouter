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
  /**
   * Normalised model ID -> the endpoint tags of its `:free` model (GET /models/{id}:free/endpoints). A `:free` request
   * runs only on these, which are usually not the paid endpoints /endpoints/zdr lists for the base model. No entry: unknown.
   */
  freeEndpoints?: Record<string, string[]>;
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

/** A model variant with its own endpoint list: `:batch` (Batch API) or `:free` (the free immediate route). */
export type EndpointVariant = "batch" | "free";

/**
 * The API path of a model variant's endpoint list (`/models/{id}:{variant}/endpoints`), each segment URL-encoded (`:`
 * kept). Undefined for an ID with an empty, "." or ".." segment, which is never requested.
 */
export function variantEndpointsPath(model: string, variant: EndpointVariant): string | undefined {
  const segments = normaliseModelSlug(model).split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return undefined;
  return `/models/${segments.map((s) => encodeURIComponent(s).replace(/%3A/gi, ":")).join("/")}:${variant}/endpoints`;
}

/** The API path of a model's `:batch` endpoint list (see variantEndpointsPath). */
export function batchEndpointsPath(model: string): string | undefined {
  return variantEndpointsPath(model, "batch");
}

/**
 * The free-route ZDR view of one model: its ZDR endpoint tags, its `:free` endpoint tags (undefined when they were not
 * loaded), and `qualifying`, the free endpoints whose exact tag is on the ZDR list (the batch rule, applied to `:free`).
 */
export function freeZdrView(catalog: CatalogView | undefined, model: string): { zdr: string[]; free?: string[]; qualifying: string[] } {
  const slug = normaliseModelSlug(model);
  const zdr = [...new Set((catalog?.zdr ?? []).filter((e) => e.model === slug).map((e) => e.provider))].sort();
  const map = catalog?.freeEndpoints;
  const free = map && Object.hasOwn(map, slug) && Array.isArray(map[slug]) ? [...new Set(map[slug])].sort() : undefined;
  return { zdr, free, qualifying: free ? free.filter((t) => zdr.includes(t)) : [] };
}

/** Whether an immediate-route model counts as ZDR: a `:free` ID by its free endpoints, any other by the ZDR list. */
export function immediateHasZdr(catalog: CatalogView | undefined, model: string): boolean {
  const slug = normaliseModelSlug(model);
  return model.endsWith(":free") ? freeZdrView(catalog, slug).qualifying.length > 0 : !!catalog?.zdr.some((e) => e.model === slug);
}

/**
 * Why an immediate-route model can't be sent at zdr, or undefined. The catalog must be fresh. A `:free` ID runs only on
 * its own free endpoints, so one of them must be on the ZDR list (unknown free endpoints are refused); a model free by
 * price runs on the base model's endpoints, so a ZDR endpoint for it suffices. Requests still carry `zdr: true`.
 */
export function immediateZdrRefusal(catalog: CatalogView | undefined, model: string): string | undefined {
  if (!catalog?.fresh) {
    return catalog?.loading
      ? "Privacy level zdr: the model catalog is still loading; try again in a moment"
      : "Privacy level zdr: model catalog not loaded this session, so ZDR endpoints can't be verified (run /batch privacy refresh)";
  }
  const slug = normaliseModelSlug(model);
  if (!model.endsWith(":free")) return catalog.zdr.some((e) => e.model === slug) ? undefined : `Privacy level zdr: no ZDR endpoint available for ${slug}`;
  const view = freeZdrView(catalog, slug);
  const noZdr = () =>
    `Privacy level zdr: ${model} has no free endpoint on OpenRouter's ZDR list (its free endpoints: ${view.free ? view.free.join(", ") || "none" : "unknown"}; ZDR endpoints: ${view.zdr.join(", ") || "none"})`;
  if (view.zdr.length === 0) return noZdr();
  if (!view.free) return `Privacy level zdr: the free endpoints of ${model} could not be loaded this session (run /batch privacy refresh)`;
  return view.qualifying.length === 0 ? noZdr() : undefined;
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
export const RETENTION_NOT_APPLICABLE = "Remote deletion: not applicable (never reached OpenRouter)";

/**
 * True for a job that ended without ever reaching OpenRouter (refused, rejected or cancelled before a provider batch
 * existed), so there is nothing to keep or delete there. A submit with an unknown outcome MAY have reached it, so it
 * never counts. Self-contained: the web page embeds this function's source.
 */
export function neverReachedOpenRouter(job: { providerBatchId?: string; localStatus: string; error?: { code: string } }): boolean {
  const ended = ["ready", "partial", "failed", "cancelled", "expired", "corrupt"].includes(job.localStatus);
  return ended && !job.providerBatchId && job.error?.code !== "submission_unknown";
}

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
