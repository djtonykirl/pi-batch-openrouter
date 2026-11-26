/**
 * Guard: no disclosed value of an identifier-like column may appear in approved text.
 * Port of Lighthouse contract/identifier_guard.py (keep the two in step).
 *
 * Tier-0 disclosure is for reference values (codes, statuses, names of things). An identifier column that repeats
 * its values often enough can still pass as tier 0 (usernames, Dataverse system-user GUIDs). Disclosure is the
 * first line of defence; this guard is the second. It matches on column name AND on value shape.
 * Findings name the table and column, never the value.
 */

import type { TableEvidence } from "./contract.js";

/** Column names that hold who-did-it or who-owns-it values. */
export const IDENTIFIER_NAME_RE = new RegExp(
  "usr|user|login|account|owner|owning|onbehalf|createdby|modifiedby|created_by|modified_by|updated_by|" +
    "(?:^|_)by(?:_|$)|_by_id|gpid|employee|(?:^|_)emp(?:_|$)|member|team|assignee|assigned_to|approver|requester|" +
    "submitter|submitted_by|inspector_id|auditor_id",
  "i",
);
const GUID_RE = /^\{?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}?$/;
const MIN_VALUE_LENGTH = 3;

export function isIdentifierValue(columnName: string, value: unknown): boolean {
  const text = String(value).trim();
  if (text.length < MIN_VALUE_LENGTH) return false;
  return GUID_RE.test(text) || IDENTIFIER_NAME_RE.test(columnName ?? "");
}

/** value -> the identifier column that disclosed it. */
export function forbiddenValues(columns: Iterable<{ name: string; sample_values?: ReadonlyArray<unknown> }>): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of columns) {
    for (const v of c.sample_values ?? []) {
      if (v === null || v === undefined) continue;
      if (isIdentifierValue(c.name, v)) {
        const key = String(v).trim();
        if (!out.has(key)) out.set(key, c.name);
      }
    }
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The identifier columns whose disclosed values appear in the text as whole tokens (names only, sorted). */
export function leaks(text: string | null | undefined, forbidden: ReadonlyMap<string, string>): string[] {
  if (!text || forbidden.size === 0) return [];
  const found = new Set<string>();
  for (const [value, column] of forbidden) if (new RegExp(`(?<![A-Za-z0-9])${escapeRe(value)}(?![A-Za-z0-9])`).test(text)) found.add(column);
  return [...found].sort();
}

/** Forbidden values over every column of the given evidence. */
export function forbiddenValuesOf(tables: Iterable<TableEvidence>): Map<string, string> {
  const cols: Array<{ name: string; sample_values?: ReadonlyArray<unknown> }> = [];
  for (const t of tables) cols.push(...t.columns);
  return forbiddenValues(cols);
}
