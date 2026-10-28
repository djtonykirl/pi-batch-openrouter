import * as fs from "node:fs";
import { atomicWriteJson } from "../fsutil.js";
import type { Logger } from "../logger.js";
import { normaliseModelSlug, type CatalogView, type ZdrEndpoint } from "../privacy/policy.js";

export interface CatalogModel {
  id: string;
  name: string;
  /** ID ends with `:free`, or prompt and completion pricing are both "0". */
  free: boolean;
  contextLength?: number;
}

export interface CatalogSnapshot extends CatalogView {
  models: CatalogModel[];
  loadedAt: string;
  /** Set when the last load failed; the data then comes from the last-known copy on disk. */
  error?: string;
}

export interface CatalogDeps {
  fetch: () => Promise<{ models: CatalogModel[]; zdr: ZdrEndpoint[] }>;
  /** Last-known copy, used for display only. */
  file: string;
  now?: () => Date;
  logger?: Logger;
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
    return { free: !!model?.free, zdr: snap.zdr.some((z) => z.model === base) };
  }

  private async doLoad(): Promise<CatalogSnapshot> {
    const now = (this.deps.now ?? (() => new Date()))();
    try {
      const { models, zdr } = await this.deps.fetch();
      const snap: CatalogSnapshot = { fresh: true, models, zdr, loadedAt: now.toISOString() };
      try {
        atomicWriteJson(this.deps.file, { models, zdr, loadedAt: snap.loadedAt });
      } catch (err) {
        this.deps.logger?.log("warn", "catalog.save_failed", { error: errorText(err) });
      }
      this.current = snap;
      return snap;
    } catch (err) {
      const error = errorText(err);
      this.deps.logger?.log("warn", "catalog.load_failed", { error });
      const last = this.readLastKnown();
      const snap: CatalogSnapshot = { fresh: false, models: last?.models ?? [], zdr: last?.zdr ?? [], loadedAt: last?.loadedAt ?? now.toISOString(), error };
      this.current = snap;
      return snap;
    }
  }

  private readLastKnown(): { models: CatalogModel[]; zdr: ZdrEndpoint[]; loadedAt?: string } | undefined {
    try {
      const j = JSON.parse(fs.readFileSync(this.deps.file, "utf8")) as Record<string, unknown>;
      if (!Array.isArray(j.models) || !Array.isArray(j.zdr)) return undefined;
      // The file is outside this process's control: malformed elements are dropped, so callers can rely on the types.
      return { models: j.models.filter(isCatalogModel), zdr: j.zdr.filter(isZdrEndpoint), loadedAt: typeof j.loadedAt === "string" ? j.loadedAt : undefined };
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

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
