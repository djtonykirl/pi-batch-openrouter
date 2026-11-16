import * as fs from "node:fs";
import * as path from "node:path";
import { isInside } from "../fsutil.js";
import { collectFilesByExtension } from "../request.js";

/**
 * Finds the two input files of a `databricks-metadata` run from a loosely worded reference ("the finance tables",
 * "beverage context") for hosts that take plain-language requests.
 *
 * A reference that is an existing path is used as given (the planner applies every path, exclusion and size rule).
 * Otherwise the workspace is searched by name. One match is used and reported; several, or none, are refused with
 * the candidates listed. The context file is sent with every request of the batch, so it is never guessed.
 */

export type MetadataFileKind = "context" | "tables";

const KIND = {
  context: { ext: ".md", noun: "context file (the reviewed domain context, a .md file sent with every request)" },
  tables: { ext: ".jsonl", noun: "tables file (.jsonl, one Databricks table per line)" },
} as const;

/** Words that say what kind of file is meant, not which one. */
const FILLER = new Set(["the", "a", "an", "my", "our", "for", "of", "in", "from", "file", "files", "domain", "md", "jsonl"]);

const MAX_LISTED = 10;

export interface LocatedFile {
  /** Workspace-relative path (or the reference as given when it is an existing path). */
  path: string;
  /** Set when the file was found by name, so the caller can tell the user which file is meant. */
  note?: string;
}

function listed(files: readonly string[]): string {
  const shown = files.slice(0, MAX_LISTED).map((f) => `  - ${f}`);
  if (files.length > MAX_LISTED) shown.push(`  … ${files.length - MAX_LISTED} more`);
  return shown.join("\n");
}

function candidates(workspaceRoot: string, kind: MetadataFileKind): string[] {
  const root = path.resolve(workspaceRoot);
  return collectFilesByExtension(root, root, KIND[kind].ext, true);
}

export function locateMetadataFile(workspaceRoot: string, reference: string, kind: MetadataFileKind): LocatedFile {
  const raw = reference.trim();
  const { ext, noun } = KIND[kind];
  if (!raw) throw new Error(`Say which ${noun} to use.`);
  const root = path.resolve(workspaceRoot);
  const abs = path.resolve(root, raw);
  // An existing path, inside the workspace or not: the planner reports anything wrong with it.
  if (fs.existsSync(abs) || !isInside(root, abs)) return { path: raw };

  const tokens = raw
    .toLowerCase()
    .replace(/\\/g, "/")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !FILLER.has(t));
  const all = candidates(workspaceRoot, kind);
  const matches = tokens.length ? all.filter((f) => tokens.every((t) => f.toLowerCase().includes(t))) : [];
  if (matches.length === 1) return { path: matches[0]!, note: `Using ${matches[0]} as the ${kind} file ("${raw}" is not a path in this workspace).` };
  if (matches.length > 1) throw new Error(`"${raw}" matches more than one ${ext} file. Which ${kind} file did you mean?\n${listed(matches)}`);
  throw new Error(
    `No ${noun} matching "${raw}" was found in this workspace.` + (all.length ? ` ${ext} files here:\n${listed(all)}` : ` There are no ${ext} files in this workspace.`),
  );
}

/** The refusal for a metadata request that names no context file: the likely candidates, nearest the tables file first. */
export function missingContextMessage(workspaceRoot: string, tablesPath: string): string {
  const all = candidates(workspaceRoot, "context");
  const dir = path.posix.dirname(tablesPath.replace(/\\/g, "/"));
  const near = all.filter((f) => path.posix.dirname(f) === dir);
  const named = all.filter((f) => /context/i.test(path.posix.basename(f)) && !near.includes(f));
  const likely = [...near, ...named];
  return (
    `Say which ${KIND.context.noun} to use; it is never guessed.` +
    (likely.length ? ` Likely candidates:\n${listed(likely)}` : all.length ? ` Markdown files here:\n${listed(all)}` : " There are no .md files in this workspace.")
  );
}
