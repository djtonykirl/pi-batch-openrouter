import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { BatchConfig } from "../config.js";
import { isInside, sha256Hex } from "../fsutil.js";
import { MAX_NOTEBOOK_RAW_BYTES, cleanNotebook, isNotebookPath } from "./notebook.js";
import { IgnoreMatcher, hardDenyMatcher } from "./ignore.js";
import { scanForSecrets, type SecretFinding } from "./secrets.js";

/**
 * Explicit context selection -> deterministic text package.
 *
 * Order of evaluation for every candidate file (first match decides):
 *   1. hard-deny rules         (not configurable; explicit selection cannot bypass)
 *   2. .pi/batchignore
 *   3. .gitignore              (via `git check-ignore`, fallback: root .gitignore)
 *   4. configured exclusions   (config.context.excludePatterns)
 *   5. explicit selection      (--file / --context)
 *
 * An explicitly named file (`--file`, or `--context` pointing at a file) that is
 * excluded, binary, too large, unreadable or outside the workspace BLOCKS the
 * submission — requested files are never silently skipped. Files discovered by
 * expanding a `--context` directory are skipped when excluded, and every skip
 * is listed in the package's `excluded` array and the preview.
 */

export type ExclusionLayer = "hard-deny" | "batchignore" | "gitignore" | "config" | "binary" | "too-large" | "symlink" | "invalid-notebook";

export interface ExcludedFile {
  relPath: string;
  layer: ExclusionLayer;
  rule?: string;
}

export interface SelectedFile {
  relPath: string;
  bytes: number;
  characters: number;
  sha256: string;
  lineEndings: "lf" | "crlf" | "mixed" | "none";
  selectedBy: "file" | "context";
  /** Set when `content` is derived from the file (cleaned `.ipynb`): `bytes`/`sha256` describe the file on disk, `characters`/`content` the text sent. */
  transform?: "ipynb-cleaned";
  /** Packaged text: UTF-8, CRLF normalised to LF so hashes are stable across checkouts. */
  content: string;
}

export interface PackageProblem {
  kind: "outside_workspace" | "not_found" | "binary" | "too_large" | "excluded" | "unreadable" | "context_too_large" | "not_a_file" | "invalid_notebook";
  path: string;
  message: string;
}

export interface ContextPackage {
  objective: string;
  files: SelectedFile[];
  excluded: ExcludedFile[];
  problems: PackageProblem[];
  secretFindings: SecretFinding[];
  warnings: string[];
  /** The user message text exactly as it will be submitted. */
  contextText: string;
  characters: number;
}

export interface PackageInput {
  workspaceRoot: string;
  objective: string;
  files: string[];
  contexts: string[];
  includeInstructions: boolean;
  format: "markdown" | "json";
  config: BatchConfig;
  /** Exact values that must never be submitted (e.g. current API key). */
  knownSecrets: string[];
  /** Override for tests; default uses `git check-ignore`. */
  gitIgnored?: (root: string, relPaths: string[]) => Set<string> | null;
  /**
   * false: collect and check files only (no combined context text, no package-size
   * check). Used by workflows, which build one prompt per item and apply their own
   * per-item and total limits. Every other check (path, exclusion, binary, size,
   * secret scan) still runs.
   */
  renderPackage?: boolean;
}

const KNOWN_TEXT_EXTENSIONS = new Set(
  ".ts .tsx .js .jsx .mjs .cjs .py .sql .ps1 .psm1 .sh .bash .json .jsonc .yaml .yml .toml .md .txt .cs .java .scala .kt .go .rs .rb .php .c .h .cpp .hpp .html .css .scss .xml .ini .cfg .conf .csv .tsv .ipynb .graphql .proto .tf .dockerfile .gitignore .editorconfig"
    .split(" "),
);

export const RESPONSE_REQUIREMENTS = [
  "Separate evidence from interpretation.",
  "Identify unsupported assumptions.",
  "Reference relevant file paths.",
  "State uncertainty explicitly.",
  "Do not claim defects are confirmed without direct evidence.",
];

export const SYSTEM_PROMPT =
  "You are performing deferred, asynchronous analysis for a software engineer. " +
  "Your output is an advisory artefact that will be reviewed by a human and an interactive agent before any change is made. " +
  "You cannot modify files. You may propose changes, including candidate patches as text.";

export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function realpath(p: string): string {
  return fs.realpathSync.native(p);
}

export function isProbablyBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  if (sample.includes(0)) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return false;
  } catch {
    return true;
  }
}

function lineEndingsOf(text: string): SelectedFile["lineEndings"] {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  if (crlf === 0 && lf === 0) return "none";
  if (crlf === 0) return "lf";
  if (lf === 0) return "crlf";
  return "mixed";
}

/** `git check-ignore` honours nested .gitignore files and global excludes. Returns null if git is unusable. */
export function gitCheckIgnore(root: string, relPaths: string[]): Set<string> | null {
  if (relPaths.length === 0) return new Set();
  try {
    const out = execFileSync("git", ["-C", root, "check-ignore", "--stdin", "-z"], {
      input: relPaths.join("\0") + "\0",
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    return new Set(out.split("\0").filter(Boolean));
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    if (e.status === 1) return new Set(); // nothing ignored
    if (e.status === 0 && typeof e.stdout === "string") return new Set(e.stdout.split("\0").filter(Boolean));
    return null; // not a repo / git missing
  }
}

interface Candidate {
  relPath: string;
  absPath: string;
  explicit: boolean;
  selectedBy: "file" | "context";
}

export function buildContextPackage(input: PackageInput): ContextPackage {
  const { config } = input;
  const problems: PackageProblem[] = [];
  const excluded: ExcludedFile[] = [];
  const warnings: string[] = [];
  const rootReal = realpath(path.resolve(input.workspaceRoot));

  const readIgnoreFile = (rel: string): IgnoreMatcher | null => {
    const p = path.resolve(rootReal, rel);
    return fs.existsSync(p) ? IgnoreMatcher.fromText(fs.readFileSync(p, "utf8")) : null;
  };
  const batchIgnore = readIgnoreFile(config.context.batchIgnoreFile);
  const configured = new IgnoreMatcher(config.context.excludePatterns);
  const gitignoreFallback = readIgnoreFile(".gitignore");

  // ---- 1. resolve user-supplied paths (path security) ----
  const candidates: Candidate[] = [];
  const resolveUserPath = (raw: string, selectedBy: "file" | "context"): void => {
    const lexical = path.resolve(rootReal, raw);
    if (!fs.existsSync(lexical)) {
      problems.push({ kind: "not_found", path: raw, message: `not found: ${raw}` });
      return;
    }
    let real: string;
    try {
      real = realpath(lexical);
    } catch (err) {
      problems.push({ kind: "unreadable", path: raw, message: `cannot resolve ${raw}: ${(err as Error).message}` });
      return;
    }
    // Both the lexical path and the symlink-resolved path must stay inside the workspace.
    const inside = isInside(rootReal, lexical) && isInside(rootReal, real);
    if (!inside && !config.security.allowOutsideWorkspace) {
      problems.push({
        kind: "outside_workspace",
        path: raw,
        message: `${raw} resolves outside the workspace (${rootReal}); outside-workspace files are disabled`,
      });
      return;
    }
    const rel = inside ? toPosix(path.relative(rootReal, real)) : toPosix(real);
    const stat = fs.statSync(real);
    if (stat.isDirectory()) {
      if (selectedBy === "file") {
        problems.push({ kind: "not_a_file", path: raw, message: `${raw} is a directory; use --context for directories` });
        return;
      }
      walkDirectory(real, rel);
      return;
    }
    if (!stat.isFile()) {
      problems.push({ kind: "not_a_file", path: raw, message: `${raw} is not a regular file` });
      return;
    }
    candidates.push({ relPath: rel, absPath: real, explicit: true, selectedBy });
  };

  const exclusionFor = (relPath: string, isDir: boolean): ExcludedFile | null => {
    const hard = hardDenyMatcher.match(relPath, isDir);
    if (hard) return { relPath, layer: "hard-deny", rule: hard.pattern };
    const bi = batchIgnore?.match(relPath, isDir);
    if (bi) return { relPath, layer: "batchignore", rule: bi.pattern };
    return null; // gitignore is batched after the walk; config checked last
  };

  const walkDirectory = (dirReal: string, dirRel: string): void => {
    const entries = fs.readdirSync(dirReal, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const abs = path.join(dirReal, entry.name);
      const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        excluded.push({ relPath: rel, layer: "symlink", rule: "symlinks are not followed during directory expansion" });
        continue;
      }
      if (entry.isDirectory()) {
        // Prune excluded directories early (avoids walking node_modules / .git).
        const ex = exclusionFor(rel, true) ?? (configured.match(rel, true) ? { relPath: rel, layer: "config" as const, rule: configured.match(rel, true)!.pattern } : null);
        if (ex) {
          excluded.push({ ...ex, relPath: rel + "/" });
          continue;
        }
        walkDirectory(abs, rel);
      } else if (entry.isFile()) {
        candidates.push({ relPath: rel, absPath: abs, explicit: false, selectedBy: "context" });
      }
    }
  };

  for (const f of input.files) resolveUserPath(f, "file");
  for (const c of input.contexts) resolveUserPath(c, "context");

  // De-duplicate (case-insensitively on Windows); keep first selection.
  const seen = new Set<string>();
  const unique = candidates.filter((c) => {
    const key = process.platform === "win32" ? c.relPath.toLowerCase() : c.relPath;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // ---- 2. exclusions, in precedence order ----
  const gitIgnoredSet = config.context.respectGitignore
    ? (input.gitIgnored ?? gitCheckIgnore)(rootReal, unique.map((c) => c.relPath))
    : new Set<string>();
  if (config.context.respectGitignore && gitIgnoredSet === null) {
    warnings.push("git unavailable or not a repository; applied root .gitignore only");
  }

  const accepted: Candidate[] = [];
  for (const c of unique) {
    let ex = exclusionFor(c.relPath, false);
    if (!ex && config.context.respectGitignore) {
      const gi = gitIgnoredSet ? (gitIgnoredSet.has(c.relPath) ? { pattern: "(git check-ignore)" } : null) : gitignoreFallback?.match(c.relPath) ?? null;
      if (gi) ex = { relPath: c.relPath, layer: "gitignore", rule: gi.pattern };
    }
    if (!ex) {
      const cm = configured.match(c.relPath);
      if (cm) ex = { relPath: c.relPath, layer: "config", rule: cm.pattern };
    }
    if (ex) {
      if (c.explicit) {
        problems.push({
          kind: "excluded",
          path: c.relPath,
          message: `${c.relPath} is excluded by ${ex.layer} rule "${ex.rule}"${ex.layer === "hard-deny" ? " (cannot be overridden)" : ""}`,
        });
      }
      excluded.push(ex);
      continue;
    }
    accepted.push(c);
  }

  // ---- 3. read, size/binary checks ----
  const files: SelectedFile[] = [];
  for (const c of accepted) {
    const notebook = isNotebookPath(c.relPath);
    let buf: Buffer;
    try {
      const size = fs.statSync(c.absPath).size;
      const limit = notebook ? MAX_NOTEBOOK_RAW_BYTES : config.context.maxFileBytes;
      if (size > limit) {
        if (c.explicit) {
          problems.push({ kind: "too_large", path: c.relPath, message: `${c.relPath} is ${size} bytes (limit ${limit})` });
        } else {
          excluded.push({ relPath: c.relPath, layer: "too-large", rule: `> ${limit} bytes` });
        }
        continue;
      }
      buf = fs.readFileSync(c.absPath);
    } catch (err) {
      problems.push({ kind: "unreadable", path: c.relPath, message: `cannot read ${c.relPath}: ${(err as Error).message}` });
      continue;
    }
    if (isProbablyBinary(buf)) {
      if (c.explicit) problems.push({ kind: "binary", path: c.relPath, message: `${c.relPath} is binary or not valid UTF-8; only text files are supported` });
      else excluded.push({ relPath: c.relPath, layer: "binary", rule: "binary or non-UTF-8 content" });
      continue;
    }
    let raw = buf.toString("utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // strip BOM
    const ext = path.extname(c.relPath).toLowerCase();
    if (ext && !KNOWN_TEXT_EXTENSIONS.has(ext)) warnings.push(`${c.relPath}: unrecognised extension "${ext}", accepted because content is valid text`);
    let content = raw.replace(/\r\n/g, "\n");
    let transform: SelectedFile["transform"];
    if (notebook) {
      // Never sent raw: outputs may hold cached data, images or secrets. maxFileBytes applies to the cleaned text.
      const cleaned = cleanNotebook(content);
      if (!cleaned.ok) {
        if (c.explicit) problems.push({ kind: "invalid_notebook", path: c.relPath, message: `${c.relPath} is not a readable notebook: ${cleaned.reason}` });
        else excluded.push({ relPath: c.relPath, layer: "invalid-notebook", rule: cleaned.reason });
        continue;
      }
      const cleanedBytes = Buffer.byteLength(cleaned.text, "utf8");
      if (cleanedBytes > config.context.maxFileBytes) {
        if (c.explicit) {
          problems.push({ kind: "too_large", path: c.relPath, message: `${c.relPath} is ${cleanedBytes} bytes after cleaning (limit ${config.context.maxFileBytes})` });
        } else {
          excluded.push({ relPath: c.relPath, layer: "too-large", rule: `> ${config.context.maxFileBytes} bytes after cleaning` });
        }
        continue;
      }
      content = cleaned.text;
      transform = "ipynb-cleaned";
      warnings.push(`${c.relPath}: notebook outputs stripped`); // shown in every preview's warnings
    }
    files.push({
      relPath: c.relPath,
      bytes: buf.length,
      characters: content.length,
      sha256: sha256Hex(buf),
      lineEndings: lineEndingsOf(raw),
      selectedBy: c.selectedBy,
      ...(transform ? { transform } : {}),
      content,
    });
  }

  if (input.contexts.length > 0 && files.length === 0 && problems.length === 0) {
    warnings.push("context selection produced no files after exclusions");
  }

  // ---- 4. secret scan (objective + every file) BEFORE request construction is used ----
  const secretFindings: SecretFinding[] = [];
  if (config.security.scanSecrets) {
    secretFindings.push(...scanForSecrets(input.objective, "<objective>", input.knownSecrets));
    for (const f of files) secretFindings.push(...scanForSecrets(f.content, f.relPath, input.knownSecrets));
  } else {
    warnings.push("secret scanning is disabled by configuration");
  }

  const contextText = input.renderPackage === false ? "" : renderContextText(input.objective, files, input.includeInstructions, input.format);
  if (input.renderPackage !== false && contextText.length > config.context.maxContextCharacters) {
    problems.push({
      kind: "context_too_large",
      path: "<package>",
      message: `context package is ${contextText.length} characters (limit ${config.context.maxContextCharacters})`,
    });
  }

  return {
    objective: input.objective,
    files,
    excluded,
    problems,
    secretFindings,
    warnings,
    contextText,
    characters: contextText.length,
  };
}

export function heading(text: string, char = "="): string {
  return `${text}\n${char.repeat(text.length)}`;
}

export function renderContextText(
  objective: string,
  files: ReadonlyArray<Pick<SelectedFile, "relPath" | "content">>,
  includeInstructions: boolean,
  format: "markdown" | "json",
): string {
  const parts: string[] = [heading("OBJECTIVE"), "", objective.trim(), ""];
  if (files.length > 0) {
    parts.push(heading("CONTEXT MANIFEST"), "");
    files.forEach((f, i) => parts.push(`${i + 1}. ${f.relPath}`));
    parts.push("");
    for (const f of files) {
      parts.push(heading(`FILE: ${f.relPath}`), "", f.content.endsWith("\n") ? f.content.slice(0, -1) : f.content, "", "END FILE", "");
    }
  }
  if (includeInstructions) {
    parts.push(heading("RESPONSE REQUIREMENTS"), "");
    for (const r of RESPONSE_REQUIREMENTS) parts.push(`- ${r}`);
    if (format === "json") parts.push("- Respond with a single valid JSON object and no surrounding prose or code fences.");
    parts.push("");
  } else if (format === "json") {
    parts.push("Respond with a single valid JSON object and no surrounding prose or code fences.", "");
  }
  return parts.join("\n");
}
