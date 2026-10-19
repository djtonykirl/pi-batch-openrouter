import { heading } from "../context/package.js";

/**
 * `map-files`: one OpenRouter request per selected file (or, with
 * `--group-size n`, per deterministic group of n consecutive files in
 * selection order). Each request carries ONLY its own file(s) plus the shared
 * objective; files are never concatenated into every request.
 *
 * Pure functions: planning and I/O live in BatchService.
 */
export const MAP_FILES = { name: "map-files", version: 1 } as const;

export const MAP_FILES_REQUIREMENTS = [
  "Base findings on the supplied file.",
  "Cite the relevant path and code where practical.",
  "Separate direct evidence from interpretation.",
  "State uncertainty explicitly.",
  "Do not describe an issue as confirmed without direct evidence.",
  "Identify dependencies on unseen files or runtime behaviour.",
  "Return usable Markdown.",
];

const JSON_REQUIREMENT = "Respond with a single valid JSON object and no surrounding prose or code fences.";

export interface ItemFile {
  relPath: string;
  content: string;
}

/** Deterministic: consecutive chunks of `groupSize` in the given order; no file omitted or repeated. */
export function groupFiles<T>(files: readonly T[], groupSize: number): T[][] {
  if (!Number.isInteger(groupSize) || groupSize < 1) throw new Error(`group size must be a positive integer (got ${groupSize})`);
  const groups: T[][] = [];
  for (let i = 0; i < files.length; i += groupSize) groups.push(files.slice(i, i + groupSize));
  return groups;
}

/** The exact user prompt for one map-files item. */
export function renderMapFilesPrompt(
  objective: string,
  files: readonly ItemFile[],
  opts: { format: "markdown" | "json"; includeInstructions: boolean },
): string {
  const parts: string[] = [heading("OBJECTIVE"), "", objective.trim(), ""];
  if (files.length === 1) {
    parts.push(heading("SOURCE"), "", `Path: ${files[0]!.relPath}`, "");
  } else {
    parts.push(heading("SOURCES"), "", ...files.map((f, i) => `${i + 1}. ${f.relPath}`), "");
  }
  for (const f of files) {
    const body = f.content.endsWith("\n") ? f.content.slice(0, -1) : f.content;
    parts.push(heading(files.length === 1 ? "FILE CONTENT" : `FILE CONTENT: ${f.relPath}`), "", body, "", heading("END FILE"), "");
  }
  if (opts.includeInstructions) {
    const reqs = files.length === 1 ? MAP_FILES_REQUIREMENTS : MAP_FILES_REQUIREMENTS.map((r) => r.replace("the supplied file", "the supplied files"));
    parts.push(heading("RESPONSE REQUIREMENTS"), "", ...reqs.map((r) => `- ${r}`));
    if (opts.format === "json") parts.push(`- ${JSON_REQUIREMENT}`);
    parts.push("");
  } else if (opts.format === "json") {
    parts.push(JSON_REQUIREMENT, "");
  }
  return parts.join("\n");
}
