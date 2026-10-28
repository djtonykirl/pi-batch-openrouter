import type { TagMap } from "./contract.js";

/**
 * Opt-in UC metadata standards for `databricks-metadata` (workflow version 2).
 *
 * Formats come from the Lighthouse data-governance references (DESCRIPTION_STANDARDS,
 * CLASSIFICATION_TAXONOMY): a six-line table description, a column comment with
 * required headers, and the ungoverned UC tag taxonomy with sparse column PII tags.
 * The model proposes only the classification and column PII tags; the other table
 * tags are facts that Pi derives from the plan options and the schema name.
 *
 * Every check is pure. Problem strings never include values from the evidence or
 * from the checked text, only header names, tag keys and allowed values.
 */

export interface MetadataStandards {
  /** Lowercase domain slug, e.g. "pinpoint". */
  domain: string;
  /** Registered table prefix, e.g. "PNPT_". */
  ucPrefix: string;
}

export const DOMAIN_PATTERN = /^[a-z][a-z0-9_]*$/;
export const UC_PREFIX_PATTERN = /^[A-Z0-9]+_$/;

export const TABLE_HEADERS = ["GRAIN:", "PURPOSE:", "SOURCE:", "REFRESH:", "OWNER:", "CLASSIFICATION:"] as const;
export const COLUMN_REQUIRED_HEADERS = ["TYPE:", "VALUES:", "SYNONYMS:", "NULL MEANS:"] as const;
export const COLUMN_OPTIONAL_HEADERS = ["UNIT:", "FORMULA:", "JOIN:"] as const;
export const COLUMN_TYPES = ["Dimension", "Measure", "Key", "Flag", "Timestamp"] as const;
export const CLASSIFICATIONS = ["public", "internal", "confidential", "restricted", "pii_scan_required"] as const;
export const PII_TYPES = ["email", "phone", "ssn", "name", "address", "dob", "ip_address", "device_id", "financial", "health", "biometric", "location"] as const;
export const SENSITIVITIES = ["low", "medium", "high"] as const;
export const BOOLEAN_TAG = ["true", "false"] as const;
export const MEDALLION_LAYERS = ["bronze", "silver", "gold"] as const;
/** Lighthouse framework audit columns: never sent to the model; the applier assigns their standard definitions. */
export const FRAMEWORK_AUDIT_COLUMNS = ["fw_pipelinerowchecksum", "fw_ingestdate", "pipeline_timestamp"] as const;

export type Classification = (typeof CLASSIFICATIONS)[number];
export type MedallionLayer = (typeof MEDALLION_LAYERS)[number];
export const TABLE_TAG_KEYS = ["classification", "data_domain", "uc_prefix", "medallion_layer", "pii"] as const;
export const COLUMN_TAG_KEYS = ["pii", "pii_type", "sensitivity", "requires_masking"] as const;

/** What the model proposes for a PII column (Pi adds `pii: "true"`). */
export interface PiiTags {
  pii_type: string;
  sensitivity: string;
  requires_masking: string;
}

/** Both options or neither; formats checked. The message names both options when one is missing. */
export function standardsFromOptions(domain: string | undefined, ucPrefix: string | undefined): { standards?: MetadataStandards; error?: string } {
  if (domain === undefined && ucPrefix === undefined) return {};
  if (domain === undefined || ucPrefix === undefined) return { error: "standards mode needs both --domain <slug> and --uc-prefix <PREFIX> (domain and ucPrefix); give both or neither" };
  const errors: string[] = [];
  if (!DOMAIN_PATTERN.test(domain)) errors.push("--domain (domain) must be a lowercase slug matching ^[a-z][a-z0-9_]*$");
  if (!UC_PREFIX_PATTERN.test(ucPrefix)) errors.push("--uc-prefix (ucPrefix) must match ^[A-Z0-9]+_$, e.g. PNPT_");
  return errors.length ? { error: errors.join("; ") } : { standards: { domain, ucPrefix } };
}

export function isAuditColumn(name: string): boolean {
  return (FRAMEWORK_AUDIT_COLUMNS as readonly string[]).includes(name.toLowerCase());
}

/** The medallion layer from the schema part of catalog.schema.table: the first of bronze|silver|gold found in it. */
export function medallionLayer(table: string): MedallionLayer | null {
  const schema = table.split(".")[1] ?? "";
  const m = /bronze|silver|gold/.exec(schema.toLowerCase());
  return m ? (m[0] as MedallionLayer) : null;
}

/**
 * The table's medallion layer in standards mode. Contract v2 evidence's `layer` is used when
 * present ("other" names no medallion layer); otherwise the schema name's layer. The plan blocks
 * a v2 `layer` that disagrees with the schema name, so the two never differ in a job.
 */
export function evidenceLayer(ev: { table: string; layer?: string }): MedallionLayer | null {
  if (ev.layer !== undefined) return (MEDALLION_LAYERS as readonly string[]).includes(ev.layer) ? (ev.layer as MedallionLayer) : null;
  return medallionLayer(ev.table);
}

/**
 * Contract v2 `domain_prefix` (four characters, e.g. "PNPT") against --uc-prefix ("PNPT_"):
 * equal, case-insensitively, once the uc prefix's trailing "_" separator is left off.
 */
export function domainPrefixMatches(domainPrefix: string, ucPrefix: string): boolean {
  return domainPrefix.toLowerCase() === ucPrefix.replace(/_$/, "").toLowerCase();
}

/** The last part of catalog.schema.table starts with the prefix (case-insensitive). */
export function hasUcPrefix(table: string, ucPrefix: string): boolean {
  const name = table.split(".").pop() ?? "";
  return name.toLowerCase().startsWith(ucPrefix.toLowerCase());
}

const MIN_LENGTH = 30;
const lines = (text: string) => text.replace(/\r\n/g, "\n").split("\n").map((l) => l.trim());
const lineIndex = (ls: string[], header: string) => ls.findIndex((l) => l.startsWith(header));
const headerValue = (ls: string[], header: string): string | undefined => {
  const i = lineIndex(ls, header);
  return i < 0 ? undefined : ls[i]!.slice(header.length).trim();
};
/** "Restricted." -> "restricted"; "PII scan required" -> "pii_scan_required". */
const normaliseClassification = (v: string) => v.trim().replace(/\.+$/, "").trim().toLowerCase().replace(/\s+/g, "_");

function headersInOrder(ls: string[], headers: readonly string[], what: string): string[] {
  const problems: string[] = [];
  const found = headers.map((h) => ({ h, i: lineIndex(ls, h) }));
  for (const { h, i } of found) if (i < 0) problems.push(`${what} is missing the ${h} line`);
  const present = found.filter((f) => f.i >= 0);
  if (present.some((f, k) => k > 0 && f.i < present[k - 1]!.i)) problems.push(`${what} headers are out of order; expected ${headers.join(" ")}`);
  return problems;
}

/** Table description: the six header lines in order, at least 30 characters, CLASSIFICATION: matching the tag. */
export function descriptionProblems(text: string, classification?: string): string[] {
  const problems: string[] = [];
  if (text.trim().length < MIN_LENGTH) problems.push(`table description is shorter than ${MIN_LENGTH} characters`);
  const ls = lines(text);
  problems.push(...headersInOrder(ls, TABLE_HEADERS, "table description"));
  const value = headerValue(ls, "CLASSIFICATION:");
  if (value !== undefined) {
    const v = normaliseClassification(value);
    if (!(CLASSIFICATIONS as readonly string[]).includes(v)) problems.push(`table description CLASSIFICATION: is not one of ${CLASSIFICATIONS.join(", ")}`);
    else if (classification !== undefined && v !== classification) problems.push(`table description CLASSIFICATION: does not match the classification tag ("${classification}")`);
  }
  return problems;
}

/** Column comment: a definition line, then TYPE:/VALUES:/SYNONYMS:/NULL MEANS: in order (UNIT:/FORMULA:/JOIN: optional), at least 30 characters. */
export function columnCommentProblems(text: string): string[] {
  const problems: string[] = [];
  if (text.trim().length < MIN_LENGTH) problems.push(`column comment is shorter than ${MIN_LENGTH} characters`);
  const ls = lines(text);
  const first = ls[0] ?? "";
  if (!first || [...COLUMN_REQUIRED_HEADERS, ...COLUMN_OPTIONAL_HEADERS].some((h) => first.startsWith(h))) problems.push("column comment must start with a plain-English definition line");
  problems.push(...headersInOrder(ls, COLUMN_REQUIRED_HEADERS, "column comment"));
  const type = headerValue(ls, "TYPE:");
  if (type !== undefined && !(COLUMN_TYPES as readonly string[]).includes(type.replace(/\.+$/, "").trim())) problems.push(`column comment TYPE: must be one of ${COLUMN_TYPES.join(", ")}`);
  return problems;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/;
const PHONE = /\b(?:\+?\d{1,3}[ .-])?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/;

/** Personal data that must never be copied into UC metadata. The match itself is never echoed. */
export function piiTextProblems(text: string): string[] {
  const problems: string[] = [];
  if (EMAIL.test(text)) problems.push("contains what looks like an email address (personal data must not be copied into metadata)");
  if (SSN.test(text)) problems.push("contains what looks like an SSN (personal data must not be copied into metadata)");
  if (PHONE.test(text)) problems.push("contains what looks like a phone number (personal data must not be copied into metadata)");
  return problems;
}

const keyProblems = (tags: TagMap, keys: readonly string[], what: string): string[] => {
  const problems: string[] = [];
  for (const k of Object.keys(tags)) if (!keys.includes(k)) problems.push(`${what} has an unknown key ${JSON.stringify(k)} (allowed: ${keys.join(", ")})`);
  for (const k of keys) if (!(k in tags)) problems.push(`${what} is missing the ${k} key`);
  return problems;
};
const enumProblem = (tags: TagMap, key: string, allowed: readonly string[], what: string): string[] =>
  key in tags && !allowed.includes(tags[key]!) ? [`${what} ${key} must be one of ${allowed.join(", ")}`] : [];

/** Table tags: exactly the five keys, the derived facts as expected, `pii` true iff some column is PII. */
export function tableTagProblems(tags: TagMap, expected: { domain: string; ucPrefix: string; layer: string | null }, anyColumnPii: boolean): string[] {
  const what = "table tags";
  const problems = keyProblems(tags, TABLE_TAG_KEYS, what);
  problems.push(...enumProblem(tags, "classification", CLASSIFICATIONS, what), ...enumProblem(tags, "medallion_layer", MEDALLION_LAYERS, what), ...enumProblem(tags, "pii", BOOLEAN_TAG, what));
  if ("data_domain" in tags && tags.data_domain !== expected.domain) problems.push(`${what} data_domain must be "${expected.domain}"`);
  if ("uc_prefix" in tags && tags.uc_prefix !== expected.ucPrefix) problems.push(`${what} uc_prefix must be "${expected.ucPrefix}"`);
  if ("medallion_layer" in tags && expected.layer !== null && tags.medallion_layer !== expected.layer) problems.push(`${what} medallion_layer must be "${expected.layer}" (from the schema name)`);
  const pii = anyColumnPii ? "true" : "false";
  if ("pii" in tags && tags.pii !== pii) problems.push(`${what} pii must be "${pii}" (${anyColumnPii ? "a column is tagged PII" : "no column is tagged PII"})`);
  if (tags.classification === "public" && (anyColumnPii || tags.pii === "true")) problems.push(`${what} classification "public" is not allowed on a table with PII; use a stricter classification`);
  return problems;
}

/** Column tags: `{}` for a non-PII column, or exactly pii "true" with pii_type, sensitivity and requires_masking. */
export function columnTagProblems(tags: TagMap): string[] {
  if (Object.keys(tags).length === 0) return [];
  const what = "column tags";
  if (tags.pii === "false") return [`${what} pii "false" is never emitted on a column; a non-PII column has no tags ({})`];
  const problems = keyProblems(tags, COLUMN_TAG_KEYS, what);
  if ("pii" in tags && tags.pii !== "true") problems.push(`${what} pii must be "true"`);
  problems.push(...enumProblem(tags, "pii_type", PII_TYPES, what), ...enumProblem(tags, "sensitivity", SENSITIVITIES, what), ...enumProblem(tags, "requires_masking", BOOLEAN_TAG, what));
  return problems;
}

/** The table tags in their fixed key order (handoff rows are compared byte for byte). */
export function deriveTableTags(classification: string, standards: MetadataStandards, layer: string, anyColumnPii: boolean): TagMap {
  return { classification, data_domain: standards.domain, uc_prefix: standards.ucPrefix, medallion_layer: layer, pii: anyColumnPii ? "true" : "false" };
}

/** A column's tags from its proposed `pii_tags`, in fixed key order; `{}` when not PII. */
export function columnTagsFromProposal(piiTags: PiiTags | null): TagMap {
  if (!piiTags) return {};
  return { pii: "true", pii_type: piiTags.pii_type, sensitivity: piiTags.sensitivity, requires_masking: piiTags.requires_masking };
}
