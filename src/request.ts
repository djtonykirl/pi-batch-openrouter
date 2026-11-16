import * as fs from "node:fs";
import * as path from "node:path";
import { toPosix } from "./context/package.js";
import { isInside } from "./fsutil.js";
import { discoverWorkflows } from "./workflows/definition.js";

export type RequestPlannerMode = "auto" | "goal" | "per_file" | "dataset" | "metadata";
export type ResolvedPlannerKind = "goal" | "per_file" | "dataset" | "metadata";

export interface ClassifiedPaths {
  files: string[];
  contexts: string[];
  datasetFile?: string;
}

const PER_FILE_PATTERNS = [
  /\b(?:each|every)\s+(?:[a-z0-9_+-]+\s+)?(?:file|module|component|script|doc|document|page|test|handler|route)\b/i,
  /\b(?:per[-\s]file|file[-\s]by[-\s]file|one\s+request\s+per\s+file|one\s+per\s+file|individually|separately\s+for\s+each)\b/i,
  /\bmap[-\s]?files\b/i,
  /\b(?:summarise|summarize|review|audit|check|analyse|analyze|inspect)\s+all\s+(?:the\s+)?[a-z0-9_.*+-]+\s+files\b/i,
];

const SINGLE_GOAL_PATTERNS = [
  /\b(?:single\s+request|one\s+combined|together\s+in\s+one|cross[-\s]file|interactions?\s+between|how\s+they\s+interact)\b/i,
];

/**
 * Wording that marks a request for the built-in `databricks-metadata` workflow (table descriptions and column
 * comments). Such a request must never fall through to the generic planners: they skip the per-table evidence
 * validation, the UC standards and the audit-column and PII rules.
 */
const METADATA_PATTERNS = [
  /\b(?:databricks|unity\s+catalog)\b/i,
  /\b(?:column|table)\s+(?:comments?|descriptions?|documentation)\b/i,
  /\b(?:uc|catalog|table|column)\s+metadata\b/i,
  /\bmetadata\s+(?:proposals?|enrichment|generation|descriptions?|comments?)\b/i,
];

/** True when the wording asks for Databricks / Unity Catalog table descriptions or column comments. */
export function looksLikeMetadataRequest(request: string): boolean {
  return METADATA_PATTERNS.some((re) => re.test(request));
}

/**
 * Extracts workspace-relative file/directory references (and simple `dir/*.ext` / `dir/**\/*.ext` patterns)
 * from either an explicit `paths` list or tokens inside the free-text `request`.
 */
export function resolveRequestPaths(workspaceRoot: string, request: string, explicitPaths?: readonly string[]): ClassifiedPaths {
  const root = path.resolve(workspaceRoot);
  const rawList = explicitPaths && explicitPaths.length > 0 ? [...explicitPaths] : extractPathCandidates(request);

  const files: string[] = [];
  const contexts: string[] = [];
  const seenFiles = new Set<string>();
  const seenContexts = new Set<string>();
  let datasetFile: string | undefined;

  const addFile = (rel: string) => {
    const norm = toPosix(rel).replace(/^\.\//, "");
    if (!seenFiles.has(norm)) {
      seenFiles.add(norm);
      files.push(norm);
    }
    if (!datasetFile && /\.(?:csv|jsonl)$/i.test(norm)) {
      datasetFile = norm;
    }
  };

  const addContext = (rel: string) => {
    const norm = toPosix(rel).replace(/^\.\//, "").replace(/\/+$/, "") || ".";
    if (!seenContexts.has(norm)) {
      seenContexts.add(norm);
      contexts.push(norm);
    }
  };

  for (const raw of rawList) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    // Support simple glob patterns like `src/**/*.ts`, `docs/*.md`, or `*.ts` by walking the base dir and filtering.
    const globMatch = /^(.*?)(?:\/|^)(\*\*\/)?\*(\.[A-Za-z0-9_-]+)$/.exec(trimmed.replace(/\\/g, "/"));
    if (globMatch) {
      const baseRel = globMatch[1] || ".";
      const recursive = Boolean(globMatch[2]);
      const ext = globMatch[3]!.toLowerCase();
      const baseAbs = path.resolve(root, baseRel);
      if (isInside(root, baseAbs) && fs.existsSync(baseAbs) && fs.statSync(baseAbs).isDirectory()) {
        for (const f of collectFilesByExtension(root, baseAbs, ext, recursive)) {
          addFile(f);
        }
        continue;
      }
    }

    const abs = path.resolve(root, trimmed);
    if (!fs.existsSync(abs)) {
      // If the user explicitly passed a missing path in `files`, keep it in `files` so the underlying planner
      // reports its standard `not_found` / `outside_workspace` blocker instead of silently dropping it.
      if (explicitPaths && explicitPaths.length > 0) addFile(trimmed);
      continue;
    }
    if (isInside(root, abs) && fs.statSync(abs).isDirectory()) {
      addContext(path.relative(root, abs));
    } else {
      addFile(isInside(root, abs) ? path.relative(root, abs) : trimmed);
    }
  }

  return { files, contexts, datasetFile };
}

/** Workspace-relative files under `dirAbs` with extension `ext` (generated and state directories are skipped). */
export function collectFilesByExtension(root: string, dirAbs: string, ext: string, recursive: boolean): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    const entries = fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".pi" || entry.name === "dist" || entry.name === ".test-build") {
        continue;
      }
      const full = path.join(d, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (recursive) walk(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(ext)) {
        out.push(toPosix(path.relative(root, full)));
      }
    }
  };
  walk(dirAbs);
  return out;
}

/** Pulls plausible workspace-relative path or glob tokens out of a natural-language sentence. */
export function extractPathCandidates(request: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const push = (val: string) => {
    const cleaned = val
      .trim()
      .replace(/^[`"'([{<]+|[`"')\]}>.,;:!?]+$/g, "")
      .replace(/\\/g, "/");
    if (!cleaned || cleaned.startsWith("http://") || cleaned.startsWith("https://")) return;
    if (!seen.has(cleaned)) {
      seen.add(cleaned);
      found.push(cleaned);
    }
  };

  // 1. Backticked segments (`src/api/`, `src/**/*.ts`, `data/rows.jsonl`)
  for (const m of request.matchAll(/`([^`\n]+)`/g)) {
    const inner = m[1]!.trim();
    if (/^[A-Za-z0-9_./*-]+$/.test(inner) && (inner.includes("/") || inner.includes("."))) {
      push(inner);
    }
  }

  // 2. Bare path-like tokens (contains `/` or ends with a known file extension)
  for (const raw of request.split(/\s+/)) {
    const tok = raw.replace(/^[`"'([{<]+|[`"')\]}>.,;:!?]+$/g, "");
    if (!tok || !/^[A-Za-z0-9_./*-]+$/.test(tok)) continue;
    // Skip model slugs like `anthropic/claude-opus-5.5` or `openai/gpt-5`
    if (/^(?:anthropic|openai|google|deepseek|meta-llama|mistralai|qwen|x-ai|cohere)\/[A-Za-z0-9._:-]+$/i.test(tok)) {
      continue;
    }
    if (tok.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(tok)) {
      push(tok);
    }
  }

  return found;
}

export interface PlannerChoice {
  kind: ResolvedPlannerKind;
  reason: string;
  workflow?: string;
  datasetInput?: string;
}

/**
 * Decides which batch planner (`goal`, `per_file`, or `dataset`) fits the user's natural-language request.
 */
export function choosePlanner(input: {
  workspaceRoot: string;
  request: string;
  mode?: RequestPlannerMode;
  workflow?: string;
  groupSize?: number;
  classified: ClassifiedPaths;
  expandedFileCount: number;
}): PlannerChoice {
  const mode = input.mode ?? "auto";
  const { classified, request } = input;

  // 0. Databricks metadata (built-in workflow). Checked before the dataset inference so a project workflow that merely
  //    takes .jsonl input cannot claim a tables file, and before the goal fallback so it is never sent unvalidated.
  const tablesFile = classified.files.find((f) => /\.jsonl$/i.test(f));
  const autoMetadata =
    mode === "auto" && !input.workflow && tablesFile !== undefined && looksLikeMetadataRequest(request) && namedWorkflow(input.workspaceRoot, request) === undefined;
  if (mode === "metadata" || autoMetadata) {
    if (!tablesFile) {
      throw new Error("Pass the tables file (.jsonl, one Databricks table per line, exported from Databricks) to generate metadata proposals for.");
    }
    return { kind: "metadata", datasetInput: tablesFile, reason: `Databricks table descriptions and column comments for the tables in ${tablesFile}` };
  }

  // 1. Explicit or inferred dataset workflow
  if (mode === "dataset" || input.workflow) {
    const wf = input.workflow ?? inferWorkflowName(input.workspaceRoot, request, classified.datasetFile);
    if (!wf) {
      throw new Error(
        "Could not determine which project workflow (.pi/batch-workflows/*.yaml) to run. Pass `workflow` or ask to list workflows with batch_list_workflows.",
      );
    }
    const dsInput = classified.datasetFile ?? classified.files[0];
    if (!dsInput) {
      throw new Error(`Pass the dataset file (.csv or .jsonl) to process with workflow "${wf}".`);
    }
    return {
      kind: "dataset",
      workflow: wf,
      datasetInput: dsInput,
      reason: `dataset workflow "${wf}" on ${dsInput}`,
    };
  }

  if (mode === "auto" && classified.datasetFile && classified.files.length === 1 && classified.contexts.length === 0) {
    const wf = inferWorkflowName(input.workspaceRoot, request, classified.datasetFile);
    if (wf) {
      return {
        kind: "dataset",
        workflow: wf,
        datasetInput: classified.datasetFile,
        reason: `matched dataset ${classified.datasetFile} with project workflow "${wf}"`,
      };
    }
  }

  // 2. Explicit mode override
  if (mode === "per_file") {
    return { kind: "per_file", reason: "per-file mode requested" };
  }
  if (mode === "goal") {
    return { kind: "goal", reason: "single-goal mode requested" };
  }

  // 3. Auto heuristic between `per_file` and `goal`
  if (input.groupSize && input.groupSize >= 1 && input.expandedFileCount > 1) {
    return { kind: "per_file", reason: `group_size=${input.groupSize} across ${input.expandedFileCount} files` };
  }

  const wantsSingleGoal = SINGLE_GOAL_PATTERNS.some((re) => re.test(request));
  const wantsPerFile = PER_FILE_PATTERNS.some((re) => re.test(request));

  if (wantsPerFile && input.expandedFileCount >= 1 && !wantsSingleGoal) {
    return { kind: "per_file", reason: `one request per file (${input.expandedFileCount} file${input.expandedFileCount === 1 ? "" : "s"})` };
  }

  if (!wantsSingleGoal && classified.contexts.length > 0 && input.expandedFileCount > 4) {
    return {
      kind: "per_file",
      reason: `directory sweep across ${input.expandedFileCount} files (one request per file avoids context dilution)`,
    };
  }

  return {
    kind: "goal",
    reason:
      input.expandedFileCount > 1
        ? `single combined analysis across ${input.expandedFileCount} files`
        : input.expandedFileCount === 1
          ? `single request on 1 file`
          : `single goal request`,
  };
}

/** A project workflow explicitly named in the request (even if invalid, so planDataset reports its diagnostics). */
function namedWorkflow(workspaceRoot: string, request: string): string | undefined {
  const lower = request.toLowerCase();
  return discoverWorkflows(workspaceRoot).entries.find((e) => lower.includes(e.name.toLowerCase()))?.name;
}

/** How much of a dataset is read to learn its field names. */
const FIELD_PROBE_BYTES = 256 * 1024;

/**
 * The field names of a dataset's first record (JSONL keys, or the CSV header), or undefined when they cannot be read.
 * Only names are returned; no value leaves this function.
 */
function datasetFieldNames(workspaceRoot: string, datasetFile: string, type: "csv" | "jsonl"): string[] | undefined {
  try {
    const abs = path.resolve(workspaceRoot, datasetFile);
    if (!isInside(path.resolve(workspaceRoot), abs)) return undefined;
    const fd = fs.openSync(abs, "r");
    let head: string;
    try {
      const buf = Buffer.alloc(FIELD_PROBE_BYTES);
      head = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0)).toString("utf8").replace(/^﻿/, "");
    } finally {
      fs.closeSync(fd);
    }
    const first = head.split(/\r?\n/).find((l) => l.trim() !== "");
    if (first === undefined) return undefined;
    if (type === "jsonl") {
      const row: unknown = JSON.parse(first);
      return row && typeof row === "object" && !Array.isArray(row) ? Object.keys(row) : undefined;
    }
    return first.split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
  } catch {
    return undefined;
  }
}

function inferWorkflowName(workspaceRoot: string, request: string, datasetFile: string | undefined): string | undefined {
  const catalog = discoverWorkflows(workspaceRoot);
  if (catalog.entries.length === 0) return undefined;

  const named = namedWorkflow(workspaceRoot, request);
  if (named) return named;

  const valid = catalog.entries.filter((e) => e.valid && e.definition);
  if (datasetFile) {
    const ext = datasetFile.toLowerCase().endsWith(".csv") ? "csv" : datasetFile.toLowerCase().endsWith(".jsonl") ? "jsonl" : undefined;
    if (ext) {
      // An unnamed workflow is inferred only when it is the one workflow of this format AND the dataset really has the
      // fields it sends: the file extension alone would hand any .jsonl file to an unrelated workflow.
      const matchingFormat = valid.filter((e) => e.definition!.input.type === ext);
      if (matchingFormat.length === 1) {
        const names = datasetFieldNames(workspaceRoot, datasetFile, ext);
        const wanted = matchingFormat[0]!.definition!.input.fields;
        if (names !== undefined && wanted.every((f) => names.includes(f))) return matchingFormat[0]!.name;
      }
    }
  }
  return undefined;
}

/** Rough token estimate (~4 chars per token) formatted for humans. */
export function formatTokenEstimate(characters: number): string {
  const approxTokens = Math.max(1, Math.ceil(characters / 4));
  return `~${approxTokens.toLocaleString("en-US")} tokens (${characters.toLocaleString("en-US")} chars)`;
}
