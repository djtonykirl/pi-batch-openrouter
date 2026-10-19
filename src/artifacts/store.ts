import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { appendJsonl, atomicWriteFile, atomicWriteJson, readJsonl } from "../fsutil.js";
import { newLocalJobId } from "../ids.js";
import { nowIso } from "../time.js";
import type { ArtifactFormat } from "./formats.js";

/**
 * Artifact provenance store: `<storage>/artifacts/<artifact-id>/`
 *
 *   manifest.json   provenance and state (atomic snapshot)
 *   events.jsonl    append-only history
 *   source.md       the exact Markdown that was rendered (template output, or the
 *                   local source file as read), so the render can be reproduced
 *                   without the model
 *   template.yaml   verbatim copy of the template used, if any
 *   rendered.<ext>  the file itself, ONLY when no --out destination was given
 *
 * Lives beside the job folders in the (gitignored) batch storage root; job
 * manifests are not modified. Artifacts link to jobs by ID.
 */

export const ARTIFACT_SCHEMA_VERSION = 1;
export const ARTIFACT_ID_PATTERN = /^A-\d{8}-[0-9A-HJKMNP-TV-Z]{4,8}$/;

export type ArtifactSourceType = "batch-result" | "batch-item" | "synthesis" | "local-source-file";

/**
 * What the rendered Markdown came from, relative to batch output:
 *   batch-generated              read directly from validated batch results
 *   unmodified-generated-output  a local file byte-identical to an earlier artifact's output
 *   modified-after-generation    a local file that was an artifact's output, since edited
 *   unlinked-local-file          a local file with no known artifact lineage
 */
export type SourceState = "batch-generated" | "unmodified-generated-output" | "modified-after-generation" | "unlinked-local-file";

export interface ArtifactSource {
  type: ArtifactSourceType;
  /** text (Markdown/prose) or json (a validated object). */
  kind: "text" | "json";
  state: SourceState;
  jobId?: string;
  itemOrdinal?: number;
  customId?: string;
  /** Dataset source ID of the item, when the job is a dataset job. */
  sourceId?: string;
  synthesisJobId?: string;
  /** Workspace-relative local source file (local-source-file). */
  path?: string;
  /** Workspace-relative files the source bytes were read from. */
  files: string[];
  /** SHA-256 of the exact source bytes (a JSON composite: of its canonical JSON). */
  sha256: string;
  /** batch-result over a partial job: items included / without a usable result. */
  items?: { included: number; excluded: number };
}

export interface ArtifactManifest {
  schemaVersion: 1;
  artifactId: string;
  status: "rendered" | "failed";
  format: ArtifactFormat;
  createdAt: string;
  source: ArtifactSource;
  lineage: {
    generation: number;
    previousArtifactId?: string;
    /** The artifact whose output file the local source was (Pi-curated route). */
    derivedFromArtifactId?: string;
    originJobId?: string;
    /** Output hash of `derivedFromArtifactId`: equal to source.sha256 only if unmodified. */
    originOutputSha256?: string;
    regeneratedFromArtifactId?: string;
  };
  template?: { name: string; file: string; sha256: string; inputSha256: string };
  intermediate?: { file: "source.md"; sha256: string; characters: number };
  output?: { path: string; sha256: string; bytes: number; pages?: number; internal: boolean };
  /** Hash of the file that an explicit --overwrite replaced. */
  replaced?: { sha256: string };
  renderer: { name: string; library?: string; version?: string };
  warnings: string[];
  error?: string;
}

export class ArtifactNotFoundError extends Error {
  constructor(id: string) {
    super(`No artifact ${id}. Use /artifact list to see artifacts.`);
    this.name = "ArtifactNotFoundError";
  }
}

export class ArtifactStore {
  constructor(public readonly root: string) {}

  public dir(id: string): string {
    if (!ARTIFACT_ID_PATTERN.test(id)) throw new ArtifactNotFoundError(id);
    return path.join(this.root, id);
  }

  /** Exclusive mkdir allocation (same scheme as job IDs, with an "A-" prefix). */
  public allocate(): string {
    fs.mkdirSync(this.root, { recursive: true });
    for (let attempt = 0; attempt < 20; attempt++) {
      const id = newLocalJobId(new Date(), attempt < 10 ? 4 : 6).replace(/^B-/, "A-");
      try {
        fs.mkdirSync(path.join(this.root, id));
        return id;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    }
    throw new Error("Could not allocate a unique artifact ID");
  }

  public writeFile(id: string, name: string, data: string | Buffer): string {
    const p = path.join(this.dir(id), name);
    atomicWriteFile(p, data);
    return p;
  }

  public save(m: ArtifactManifest, event: string, details?: Record<string, unknown>): void {
    appendJsonl(path.join(this.dir(m.artifactId), "events.jsonl"), { id: crypto.randomUUID(), artifactId: m.artifactId, eventType: event, eventAt: nowIso(), ...(details ? { details } : {}) });
    atomicWriteJson(path.join(this.dir(m.artifactId), "manifest.json"), m);
  }

  public read(id: string): ArtifactManifest {
    const p = path.join(this.dir(id), "manifest.json");
    if (!fs.existsSync(p)) throw new ArtifactNotFoundError(id);
    return JSON.parse(fs.readFileSync(p, "utf8")) as ArtifactManifest;
  }

  public events(id: string): Array<{ eventType: string; eventAt: string; details?: Record<string, unknown> }> {
    return readJsonl<{ eventType: string; eventAt: string; details?: Record<string, unknown> }>(path.join(this.dir(id), "events.jsonl")).records;
  }

  /** Newest first. Unreadable entries are skipped here and reported by `unreadable`. */
  public list(): { artifacts: ArtifactManifest[]; unreadable: string[] } {
    const out = { artifacts: [] as ArtifactManifest[], unreadable: [] as string[] };
    if (!fs.existsSync(this.root)) return out;
    for (const e of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!e.isDirectory() || !ARTIFACT_ID_PATTERN.test(e.name)) continue;
      try {
        out.artifacts.push(this.read(e.name));
      } catch {
        out.unreadable.push(e.name);
      }
    }
    out.artifacts.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.artifactId.localeCompare(a.artifactId)));
    return out;
  }

  /** Accepts a full ID or a unique suffix. */
  public resolveId(input: string): string {
    const wanted = input.trim().toUpperCase();
    if (ARTIFACT_ID_PATTERN.test(wanted) && fs.existsSync(path.join(this.root, wanted, "manifest.json"))) return wanted;
    const hits = this.list().artifacts.filter((a) => a.artifactId.endsWith(wanted));
    if (hits.length === 1) return hits[0]!.artifactId;
    if (hits.length > 1) throw new Error(`"${input}" is ambiguous: ${hits.map((h) => h.artifactId).join(", ")}`);
    throw new ArtifactNotFoundError(input);
  }
}
