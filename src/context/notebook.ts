/**
 * `.ipynb` -> Databricks notebook source text.
 *
 * Keeps only markdown and code cell sources. Outputs, execution counts, attachments, raw cells and all metadata are
 * dropped, so cached DataFrame output, base64 images and anything echoed by a cell never leave the repository.
 */

/** Raw on-disk ceiling for a notebook before cleaning; `context.maxFileBytes` applies to the cleaned text. */
export const MAX_NOTEBOOK_RAW_BYTES = 32 * 1024 * 1024;

export const NOTEBOOK_HEADER = "# Databricks notebook source";
export const NOTEBOOK_CELL_SEPARATOR = "\n\n# COMMAND ----------\n\n";

export type CleanNotebookResult =
  | { ok: true; text: string; cells: number; droppedOutputs: number }
  | { ok: false; reason: string };

export function isNotebookPath(p: string): boolean {
  return p.toLowerCase().endsWith(".ipynb");
}

function sourceText(source: unknown): string | null {
  if (typeof source === "string") return source;
  if (Array.isArray(source) && source.every((s) => typeof s === "string")) return (source as string[]).join("");
  return null;
}

export function cleanNotebook(text: string): CleanNotebookResult {
  let doc: unknown;
  try {
    doc = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (err) {
    return { ok: false, reason: `not valid JSON (${(err as Error).message})` };
  }
  if (!doc || typeof doc !== "object" || !Array.isArray((doc as { cells?: unknown }).cells)) {
    return { ok: false, reason: 'not a notebook (no "cells" array)' };
  }
  const blocks: string[] = [];
  let droppedOutputs = 0;
  for (const cell of (doc as { cells: unknown[] }).cells) {
    if (!cell || typeof cell !== "object") return { ok: false, reason: "a cell is not an object" };
    const c = cell as { cell_type?: unknown; source?: unknown; outputs?: unknown };
    if (c.cell_type !== "markdown" && c.cell_type !== "code") continue; // raw and unknown cells are dropped
    if (c.cell_type === "code" && Array.isArray(c.outputs)) droppedOutputs += c.outputs.length;
    const src = sourceText(c.source ?? "");
    if (src === null) return { ok: false, reason: "a cell source is neither a string nor a string array" };
    const norm = src.replace(/\r\n/g, "\n");
    if (c.cell_type === "code") {
      blocks.push(norm);
    } else {
      const body = norm.endsWith("\n") ? norm.slice(0, -1) : norm;
      const lines = body.split("\n").map((l) => (l === "" ? "# MAGIC" : `# MAGIC ${l}`));
      blocks.push(["# MAGIC %md", ...lines].join("\n"));
    }
  }
  return { ok: true, text: [NOTEBOOK_HEADER, blocks.join(NOTEBOOK_CELL_SEPARATOR)].join("\n"), cells: blocks.length, droppedOutputs };
}
