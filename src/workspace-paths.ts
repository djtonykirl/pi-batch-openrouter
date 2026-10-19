import * as fs from "node:fs";
import * as path from "node:path";
import type { BatchConfig } from "./config.js";
import { IgnoreMatcher, hardDenyMatcher } from "./context/ignore.js";
import { isInside } from "./fsutil.js";

/**
 * Path checks for Release 3 inputs (dataset files, workflow files given with
 * --file) and outputs (exports). Same containment rules as context packaging:
 * the lexical AND the symlink-resolved path must stay inside the workspace, and
 * hard-deny rules cannot be bypassed by naming a file explicitly.
 *
 * Unlike context packaging, .gitignore is NOT applied to dataset inputs: data
 * files are routinely gitignored precisely because they are data. Hard-deny,
 * .pi/batchignore and configured exclusions still apply, and the provider-bound
 * content of every row is secret-scanned.
 */

export type PathProblemKind = "not_found" | "outside_workspace" | "not_a_file" | "excluded" | "too_large" | "unreadable";

export type ResolvedInput = { ok: true; relPath: string; absPath: string; bytes: number } | { ok: false; kind: PathProblemKind; message: string };

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

export function resolveWorkspaceInput(workspaceRoot: string, raw: string, config: BatchConfig, opts: { what: string; maxBytes: number }): ResolvedInput {
  const rootReal = fs.realpathSync.native(path.resolve(workspaceRoot));
  const lexical = path.resolve(rootReal, raw);
  if (!fs.existsSync(lexical)) return { ok: false, kind: "not_found", message: `${opts.what} not found: ${raw}` };
  let real: string;
  try {
    real = fs.realpathSync.native(lexical);
  } catch (err) {
    return { ok: false, kind: "unreadable", message: `cannot resolve ${opts.what} ${raw}: ${(err as Error).message}` };
  }
  const inside = isInside(rootReal, lexical) && isInside(rootReal, real);
  if (!inside && !config.security.allowOutsideWorkspace) {
    return { ok: false, kind: "outside_workspace", message: `${opts.what} ${raw} resolves outside the workspace; outside-workspace files are disabled` };
  }
  const stat = fs.statSync(real);
  if (!stat.isFile()) return { ok: false, kind: "not_a_file", message: `${opts.what} ${raw} is not a regular file` };
  const relPath = inside ? toPosix(path.relative(rootReal, real)) : toPosix(real);
  const hard = hardDenyMatcher.match(relPath);
  if (hard) return { ok: false, kind: "excluded", message: `${opts.what} ${relPath} is excluded by hard-deny rule "${hard.pattern}" (cannot be overridden)` };
  const biPath = path.resolve(rootReal, config.context.batchIgnoreFile);
  if (fs.existsSync(biPath)) {
    const bi = IgnoreMatcher.fromText(fs.readFileSync(biPath, "utf8")).match(relPath);
    if (bi) return { ok: false, kind: "excluded", message: `${opts.what} ${relPath} is excluded by batchignore rule "${bi.pattern}"` };
  }
  const cm = new IgnoreMatcher(config.context.excludePatterns).match(relPath);
  if (cm) return { ok: false, kind: "excluded", message: `${opts.what} ${relPath} is excluded by config rule "${cm.pattern}"` };
  if (stat.size > opts.maxBytes) return { ok: false, kind: "too_large", message: `${opts.what} ${relPath} is ${stat.size} bytes (limit ${opts.maxBytes})` };
  return { ok: true, relPath, absPath: real, bytes: stat.size };
}

export type ResolvedOutput = { ok: true; relPath: string; absPath: string; exists: boolean } | { ok: false; message: string };

/**
 * A destination for a file this extension writes on the user's explicit request.
 * Must stay inside the workspace (also after resolving any existing ancestor
 * directory's symlinks), must not be a hard-denied or .git path, and must not be
 * an existing symlink or directory.
 */
export function resolveWorkspaceOutput(workspaceRoot: string, raw: string): ResolvedOutput {
  const rootReal = fs.realpathSync.native(path.resolve(workspaceRoot));
  const lexical = path.resolve(rootReal, raw);
  if (!isInside(rootReal, lexical) || lexical === rootReal) return { ok: false, message: `output path ${raw} is outside the workspace` };
  // The deepest existing ancestor must also resolve inside the workspace (no escape via a symlinked directory).
  let ancestor = path.dirname(lexical);
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  if (!isInside(rootReal, fs.realpathSync.native(ancestor))) return { ok: false, message: `output path ${raw} resolves outside the workspace` };
  const relPath = toPosix(path.relative(rootReal, lexical));
  const hard = hardDenyMatcher.match(relPath);
  if (hard) return { ok: false, message: `output path ${relPath} is protected by hard-deny rule "${hard.pattern}"` };
  let exists = false;
  try {
    const st = fs.lstatSync(lexical);
    exists = true;
    if (st.isSymbolicLink()) return { ok: false, message: `output path ${relPath} is a symbolic link; refusing to write through it` };
    if (!st.isFile()) return { ok: false, message: `output path ${relPath} exists and is not a regular file` };
  } catch {
    exists = false;
  }
  return { ok: true, relPath, absPath: lexical, exists };
}
