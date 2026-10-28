import * as fs from "node:fs";
import { atomicWriteJson } from "../fsutil.js";
import type { Logger } from "../logger.js";
import { batchEndpointsPath, batchZdrView, normaliseModelSlug, routeForModel, type CatalogView, type ZdrEndpoint } from "../privacy/policy.js";

export interface CatalogModel {
  id: string;
  name: string;
  /** ID ends with `:free`, or prompt and completion pricing are both "0". */
  free: boolean;
  contextLength?: number;
}

export interface CatalogSnapshot extends CatalogView {
  models: CatalogModel[];
  /** Always set on a snapshot (empty when nothing was loaded); a model without an entry has unknown batch endpoints. */
  batchEndpoints: Record<string, string[]>;
  loadedAt: string;
  /** Set when the last load failed; the data then comes from the last-known copy on disk. */
  error?: string;
}

export interface CatalogData {
  models: CatalogModel[];
  zdr: ZdrEndpoint[];
  /** Normalised model ID -> its `:batch` endpoint tags. Absent or missing a model: unknown for that model. */
  batchEndpoints?: Record<string, string[]>;
}

export interface CatalogDeps {
  /** Throws only when the core lists (/models, /endpoints/zdr) fail; per-model batch-endpoint failures leave that model out. */
  fetch: () => Promise<CatalogData>;
  /** Last-known copy, used for display only. */
  file: string;
  now?: () => Date;
  logger?: Logger;
}

/**
 * Whether `route: "immediate"` may be chosen explicitly for `modelId`: only a `:free` ID, or a model the catalog loaded
 * this session lists as free under that exact ID (a copy read from disk may be out of date, and a model that has since
 * been priced would be billed at full non-batch rates). Anything else goes through the batch route's privacy checks.
 */
export function immediateRouteAllowed(modelId: string, snapshot: CatalogSnapshot | undefined): boolean {
  return modelId.endsWith(":free") || (!!snapshot?.fresh && snapshot.models.some((m) => m.id === modelId && m.free));
}

export function immediateRouteRefusal(modelId: string): string {
  return `Route immediate is only for free models (a ":free" ID or one the model catalog loaded this session lists as free); ${modelId} is not one (if the catalog failed to load, refresh it and try again)`;
}

/** How many per-model `:batch` endpoint requests run at once. */
export const BATCH_ENDPOINT_CONCURRENCY = 8;

/** Overall limit for loading the per-model `:batch` endpoints, so a slow API can't hold up the first zdr decision. */
export const BATCH_ENDPOINTS_DEADLINE_MS = 20_000;

/**
 * Loads the `:batch` endpoint tags of every `:batch` model in `models`, at most `concurrency` at a time, within
 * `deadlineMs`. A model whose request fails or is still pending at the deadline is listed in `failed` and has no entry
 * (unknown); it never fails the whole load. IDs with an unsafe path segment are never requested (also `failed`).
 */
export async function loadBatchEndpoints(
  models: CatalogModel[],
  fetchOne: (batchModelId: string) => Promise<string[]>,
  concurrency = BATCH_ENDPOINT_CONCURRENCY,
  deadlineMs = BATCH_ENDPOINTS_DEADLINE_MS,
): Promise<{ endpoints: Record<string, string[]>; failed: string[] }> {
  const all = [...new Set(models.map((m) => m.id).filter((id) => id.endsWith(":batch") && normaliseModelSlug(id) !== "__proto__"))];
  const ids = all.filter((id) => batchEndpointsPath(id) !== undefined);
  const endpoints: Record<string, string[]> = {};
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<"expired">((resolve) => {
    timer = setTimeout(() => resolve("expired"), deadlineMs);
  });
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < ids.length) {
      const id = ids[next++]!;
      try {
        const tags = await Promise.race([fetchOne(id), expired]);
        if (tags === "expired") return;
        endpoints[normaliseModelSlug(id)] = tags;
      } catch {
        // unknown: listed in `failed` below
      }
    }
  };
  try {
    await Promise.race([Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, ids.length)) }, worker)), expired]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  // Snapshot at return: a request that finishes after the deadline must not change the result.
  const result = { ...endpoints };
  const failed = all.filter((id) => !Object.hasOwn(result, normaliseModelSlug(id))).sort();
  return { endpoints: result, failed };
}

/** The client calls the catalog needs (all public endpoints). */
export interface CatalogClient {
  listModels(): Promise<{ models: CatalogModel[] }>;
  listZdrEndpoints(): Promise<{ endpoints: ZdrEndpoint[] }>;
  listBatchEndpoints(model: string): Promise<{ tags: string[] }>;
}

/** The full catalog load: /models and /endpoints/zdr (which must succeed), then each `:batch` model's endpoints. */
export async function fetchCatalogData(client: CatalogClient, logger?: Logger): Promise<CatalogData> {
  const [models, zdr] = await Promise.all([client.listModels(), client.listZdrEndpoints()]);
  const batch = await loadBatchEndpoints(models.models, async (id) => (await client.listBatchEndpoints(id)).tags);
  if (batch.failed.length) logger?.log("warn", "catalog.batch_endpoints_failed", { count: batch.failed.length, models: batch.failed.slice(0, 20) });
  return { models: models.models, zdr: zdr.endpoints, batchEndpoints: batch.endpoints };
}

/** Session model catalog: one deduplicated load at a time; `fresh` is true only after a successful network load. */
export class ModelCatalog {
  private current: CatalogSnapshot | undefined;
  private inFlight: Promise<CatalogSnapshot> | undefined;

  constructor(private readonly deps: CatalogDeps) {}

  public load(): Promise<CatalogSnapshot> {
    if (this.inFlight) return this.inFlight;
    const p = this.doLoad().finally(() => {
      this.inFlight = undefined;
    });
    this.inFlight = p;
    return p;
  }

  public snapshot(): CatalogSnapshot | undefined {
    return this.current;
  }

  /**
   * The current snapshot for a privacy decision, marked `loading` while a load is in flight, so a refusal can say
   * "still loading" rather than "not loaded". A fresh snapshot stays usable while a refresh runs.
   */
  public view(): (CatalogSnapshot & { loading?: true }) | undefined {
    if (!this.inFlight) return this.current;
    return { ...(this.current ?? { fresh: false, zdr: [], models: [], batchEndpoints: {}, loadedAt: "" }), loading: true };
  }

  /** Waits for the in-flight load (if any) for up to `timeoutMs`; resolves `undefined` on timeout. */
  public async whenLoaded(timeoutMs: number): Promise<CatalogSnapshot | undefined> {
    if (!this.inFlight) return this.current;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), timeoutMs);
    });
    try {
      return await Promise.race([this.inFlight, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  public labels(modelId: string): { free: boolean; zdr: boolean } {
    const base = normaliseModelSlug(modelId);
    const snap = this.current;
    if (!snap) return { free: false, zdr: false };
    const model = snap.models.find((m) => m.id === modelId) ?? snap.models.find((m) => normaliseModelSlug(m.id) === base && m.free);
    // Batch route: ZDR only when one of its batch endpoints is on the ZDR list; immediate route: the sync ZDR endpoints.
    const zdr = routeForModel(modelId) === "batch" ? batchZdrView(snap, base).pinnable.length > 0 : snap.zdr.some((z) => z.model === base);
    return { free: !!model?.free, zdr };
  }

  private async doLoad(): Promise<CatalogSnapshot> {
    const now = (this.deps.now ?? (() => new Date()))();
    try {
      const { models, zdr, batchEndpoints = {} } = await this.deps.fetch();
      const snap: CatalogSnapshot = { fresh: true, models, zdr, batchEndpoints, loadedAt: now.toISOString() };
      try {
        atomicWriteJson(this.deps.file, { models, zdr, batchEndpoints, loadedAt: snap.loadedAt });
      } catch (err) {
        this.deps.logger?.log("warn", "catalog.save_failed", { error: errorText(err) });
      }
      this.current = snap;
      return snap;
    } catch (err) {
      const error = errorText(err);
      this.deps.logger?.log("warn", "catalog.load_failed", { error });
      const last = this.readLastKnown();
      const snap: CatalogSnapshot = {
        fresh: false,
        models: last?.models ?? [],
        zdr: last?.zdr ?? [],
        batchEndpoints: last?.batchEndpoints ?? {},
        loadedAt: last?.loadedAt ?? now.toISOString(),
        error,
      };
      this.current = snap;
      return snap;
    }
  }

  private readLastKnown(): { models: CatalogModel[]; zdr: ZdrEndpoint[]; batchEndpoints: Record<string, string[]>; loadedAt?: string } | undefined {
    try {
      const j = JSON.parse(fs.readFileSync(this.deps.file, "utf8")) as Record<string, unknown>;
      if (!Array.isArray(j.models) || !Array.isArray(j.zdr)) return undefined;
      // The file is outside this process's control: malformed elements are dropped, so callers can rely on the types.
      return {
        models: j.models.filter(isCatalogModel),
        zdr: j.zdr.filter(isZdrEndpoint),
        batchEndpoints: readBatchEndpoints(j.batchEndpoints),
        loadedAt: typeof j.loadedAt === "string" ? j.loadedAt : undefined,
      };
    } catch {
      return undefined;
    }
  }
}

function isCatalogModel(v: unknown): v is CatalogModel {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m.id === "string" &&
    m.id.length > 0 &&
    typeof m.name === "string" &&
    typeof m.free === "boolean" &&
    (m.contextLength === undefined || (typeof m.contextLength === "number" && Number.isFinite(m.contextLength)))
  );
}

function isZdrEndpoint(v: unknown): v is ZdrEndpoint {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const e = v as Record<string, unknown>;
  return typeof e.model === "string" && e.model.length > 0 && typeof e.provider === "string" && e.provider.length > 0;
}

/** The disk copy's batch endpoints: entries that aren't a non-empty key with an array are dropped, and so are non-string or empty tags. */
function readBatchEndpoints(v: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (typeof v !== "object" || v === null || Array.isArray(v)) return out;
  for (const [model, tags] of Object.entries(v as Record<string, unknown>)) {
    if (!model || model === "__proto__" || !Array.isArray(tags)) continue;
    out[model] = tags.filter((t): t is string => typeof t === "string" && t.length > 0);
  }
  return out;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
