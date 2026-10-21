import { CsvError, parse as parseCsv } from "csv-parse/sync";

/**
 * Dataset input for project workflows: CSV (with header) or JSONL (one JSON
 * object per non-blank line). Only the ID field and the workflow's selected
 * fields are kept in memory; other columns are never read into a prompt.
 *
 * Diagnostics name rows/lines and fields, never values: a malformed row can
 * hold confidential data, so its content is not echoed (parser messages that
 * quote input are replaced with fixed descriptions).
 *
 * Policies:
 *   - UTF-8 only; a leading BOM is ignored. CRLF and LF (also mixed) are accepted.
 *   - CSV: RFC 4180 quoting (quoted delimiters, "" escapes, multi-line fields).
 *     Completely blank lines are ignored and counted. Every record must have
 *     exactly the header's column count. Duplicate header names are fatal.
 *   - JSONL: whitespace-only lines are ignored and counted; every other line must
 *     be a JSON object, else planning fails with that line number.
 *   - Source IDs: non-empty, at most 256 characters, no control characters; JSONL
 *     IDs may be strings or integers. Missing and duplicate IDs fail planning.
 *   - Field values: CSV values are strings (empty is a value); JSONL values must be
 *     strings, finite numbers or booleans (rendered with String()); null, missing,
 *     objects and arrays are row problems.
 */

export interface DatasetSpec {
  type: "csv" | "jsonl";
  idField: string;
  fields: readonly string[];
  delimiter?: string;
}

export interface DatasetRecord {
  /** 1-based record number in file order (CSV: data record, header excluded; JSONL: non-blank line count). */
  index: number;
  /** CSV only: equals `index`. */
  row?: number;
  /** JSONL only: physical line number. */
  line?: number;
  id?: string;
  /** Selected field values that are present and valid. */
  values: Record<string, string>;
  /** Row-level problems, free of row content. */
  problems: string[];
}

export interface ParsedDataset {
  type: "csv" | "jsonl";
  /** CSV header (column names are configuration, not row data). */
  header?: string[];
  records: DatasetRecord[];
  blankLines: number;
  /** File-level problems: nothing is plannable when non-empty. */
  fatal: string[];
}

export const MAX_SOURCE_ID_LENGTH = 256;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export function decodeDatasetBytes(bytes: Buffer): string | undefined {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\u0000")) return undefined;
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch {
    return undefined;
  }
}

function idProblem(raw: unknown, idField: string): { id?: string; problem?: string } {
  if (raw === undefined || raw === null) return { problem: `missing source ID (${idField})` };
  let id: string;
  if (typeof raw === "string") id = raw;
  else if (typeof raw === "number" && Number.isSafeInteger(raw)) id = String(raw);
  else return { problem: `source ID (${idField}) must be a string or an integer` };
  if (id.trim() === "") return { problem: `missing source ID (${idField} is empty)` };
  if (id.length > MAX_SOURCE_ID_LENGTH) return { problem: `source ID (${idField}) is longer than ${MAX_SOURCE_ID_LENGTH} characters` };
  if (CONTROL.test(id)) return { problem: `source ID (${idField}) contains control characters` };
  return { id };
}

const CSV_ERRORS: Record<string, string> = {
  CSV_INVALID_CLOSING_QUOTE: "a quoted field is followed by characters other than a delimiter or line break",
  CSV_QUOTE_NOT_CLOSED: "a quoted field is never closed",
  CSV_RECORD_INCONSISTENT_FIELDS_LENGTH: "the record does not have the same number of columns as the header",
  CSV_RECORD_INCONSISTENT_COLUMNS: "the record does not have the same number of columns as the header",
  CSV_INVALID_OPENING_QUOTE: "a quote appears inside an unquoted field",
  CSV_NON_TRIMABLE_CHAR_AFTER_CLOSING_QUOTE: "a quoted field is followed by characters other than a delimiter or line break",
};

function parseCsvDataset(text: string, spec: DatasetSpec): ParsedDataset {
  const out: ParsedDataset = { type: "csv", records: [], blankLines: 0, fatal: [] };
  let rows: Array<{ record: string[]; info: { lines: number; empty_lines: number } }>;
  try {
    rows = parseCsv(text, {
      delimiter: spec.delimiter ?? ",",
      record_delimiter: ["\r\n", "\n"],
      skip_empty_lines: true,
      relax_column_count: false,
      relax_quotes: false,
      info: true,
      // csv-parse >= 6 types the sync result as string[][] even with `info: true`; at runtime each row is { record, info }.
    }) as unknown as typeof rows;
  } catch (err) {
    if (err instanceof CsvError) {
      const where = typeof (err as { lines?: number }).lines === "number" ? ` at line ${(err as unknown as { lines: number }).lines}` : "";
      out.fatal.push(`malformed CSV${where}: ${CSV_ERRORS[err.code] ?? err.code}`);
    } else {
      out.fatal.push("malformed CSV");
    }
    return out;
  }
  if (rows.length === 0) {
    out.fatal.push("the CSV file is empty (no header row)");
    return out;
  }
  const header = rows[0]!.record;
  out.header = header;
  out.blankLines = rows[rows.length - 1]!.info.empty_lines;
  const seen = new Map<string, number>();
  header.forEach((h, i) => {
    if (seen.has(h)) out.fatal.push(`duplicate header ${JSON.stringify(h)} (columns ${seen.get(h)! + 1} and ${i + 1})`);
    else seen.set(h, i);
  });
  const required = [spec.idField, ...spec.fields.filter((f) => f !== spec.idField)];
  const missing = required.filter((f) => !seen.has(f));
  if (missing.length > 0) out.fatal.push(`missing required column(s): ${missing.map((m) => JSON.stringify(m)).join(", ")} (header: ${header.map((h) => JSON.stringify(h)).join(", ")})`);
  if (rows.length === 1) out.fatal.push("the CSV file has a header but no data rows");
  if (out.fatal.length > 0) return out;

  const col = (name: string) => seen.get(name)!;
  rows.slice(1).forEach((r, i) => {
    const index = i + 1;
    const rec: DatasetRecord = { index, row: index, values: {}, problems: [] };
    const idr = idProblem(r.record[col(spec.idField)], spec.idField);
    if (idr.id !== undefined) rec.id = idr.id;
    else rec.problems.push(idr.problem!);
    for (const f of spec.fields) rec.values[f] = r.record[col(f)]!;
    out.records.push(rec);
  });
  return out;
}

function parseJsonlDataset(text: string, spec: DatasetSpec): ParsedDataset {
  const out: ParsedDataset = { type: "jsonl", records: [], blankLines: 0, fatal: [] };
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop(); // trailing newline
  let index = 0;
  lines.forEach((lineText, i) => {
    const line = i + 1;
    if (lineText.trim() === "") {
      out.blankLines++;
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(lineText);
    } catch {
      // The engine's message can quote the line; only the position is reported.
      out.fatal.push(`line ${line}: not valid JSON`);
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      out.fatal.push(`line ${line}: not a JSON object`);
      return;
    }
    index++;
    const obj = value as Record<string, unknown>;
    const rec: DatasetRecord = { index, line, values: {}, problems: [] };
    const has = (k: string) => Object.prototype.hasOwnProperty.call(obj, k);
    const idr = idProblem(has(spec.idField) ? obj[spec.idField] : undefined, spec.idField);
    if (idr.id !== undefined) rec.id = idr.id;
    else rec.problems.push(idr.problem!);
    for (const f of spec.fields) {
      const v = has(f) ? obj[f] : undefined;
      if (v === undefined) rec.problems.push(`missing field ${JSON.stringify(f)}`);
      else if (v === null) rec.problems.push(`field ${JSON.stringify(f)} is null`);
      else if (typeof v === "string") rec.values[f] = v;
      else if ((typeof v === "number" && Number.isFinite(v)) || typeof v === "boolean") rec.values[f] = String(v);
      else rec.problems.push(`field ${JSON.stringify(f)} is not a string, number or boolean`);
    }
    out.records.push(rec);
  });
  if (out.fatal.length === 0 && out.records.length === 0) out.fatal.push("the JSONL file contains no records");
  return out;
}

export function parseDataset(text: string, spec: DatasetSpec): ParsedDataset {
  return spec.type === "csv" ? parseCsvDataset(text, spec) : parseJsonlDataset(text, spec);
}

/** Missing and duplicate source IDs across the whole dataset (identity must be sound before any subset is planned). */
export function identityProblems(records: readonly DatasetRecord[], type: "csv" | "jsonl"): { missing: number; duplicates: number; messages: string[] } {
  const where = (r: DatasetRecord) => (type === "csv" ? `row ${r.row}` : `line ${r.line}`);
  const first = new Map<string, DatasetRecord>();
  const messages: string[] = [];
  let missing = 0;
  let duplicates = 0;
  for (const r of records) {
    if (r.id === undefined) {
      missing++;
      messages.push(`${where(r)}: ${r.problems[0] ?? "missing source ID"}`);
      continue;
    }
    const prev = first.get(r.id);
    if (prev) {
      duplicates++;
      messages.push(`${where(r)}: duplicate source ID ${JSON.stringify(r.id.slice(0, 64))} (first at ${where(prev)})`);
    } else {
      first.set(r.id, r);
    }
  }
  return { missing, duplicates, messages };
}
