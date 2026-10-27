import { Ajv } from "ajv";
import { canonicalJson, sha256Hex } from "../fsutil.js";
import { formatErrors } from "../workflows/structured.js";
import { BOOLEAN_TAG, CLASSIFICATIONS, PII_TYPES, SENSITIVITIES, columnCommentProblems, descriptionProblems, isAuditColumn, piiTextProblems, type MetadataStandards, type PiiTags } from "./standards.js";

/**
 * Phase 1 Databricks metadata enrichment: the data contracts.
 *
 *   tables.jsonl   one Databricks table per line (exported by Databricks)
 *   proposal       what the model must return for one table
 *   approved.jsonl the reviewed handoff back to Databricks (no SQL, no instructions)
 *
 * All three are validated strictly: unknown fields are rejected, nothing is
 * coerced or defaulted. Only descriptions and column comments are in scope, plus
 * (in opt-in standards mode, see standards.ts) the classification and column PII tags.
 */

/** catalog.schema.table: three non-empty parts without whitespace, dots or control characters. */
export const TABLE_NAME_PATTERN = "^[^.\\s\\u0000-\\u001f`]+\\.[^.\\s\\u0000-\\u001f`]+\\.[^.\\s\\u0000-\\u001f`]+$";
export const CONFIDENCE = ["high", "medium", "low", "insufficient"] as const;
export type Confidence = (typeof CONFIDENCE)[number];
const MAX_SAMPLES = 20;

/** Ungoverned UC tags: key to string value. Key order is significant in the handoff. */
export type TagMap = Record<string, string>;

export interface ColumnEvidence {
  name: string;
  data_type: string;
  nullable: boolean;
  existing_comment: string | null;
  existing_tags?: TagMap;
  sample_values?: Array<string | number | boolean | null>;
}

export interface TableEvidence {
  table: string;
  existing_description: string | null;
  existing_tags?: TagMap;
  columns: ColumnEvidence[];
}

export interface ColumnProposal {
  name: string;
  comment: string | null;
  confidence: Confidence;
  reason: string;
  /** Standards mode only: PII tags for a column that holds personal data, otherwise null. */
  pii_tags?: PiiTags | null;
}

export interface TableProposal {
  table: string;
  /** Standards mode only. */
  classification?: string;
  table_description: { comment: string | null; confidence: Confidence; reason: string };
  columns: ColumnProposal[];
}

export interface ApprovedRow {
  table: string;
  existing_description: string | null;
  approved_description: string | null;
  columns: Array<{ name: string; existing_comment: string | null; approved_comment: string | null }>;
  provenance: {
    job_id: string;
    result_job_id: string | null;
    result_custom_id: string | null;
    input_sha256: string;
    context_sha256: string;
    proposal_sha256: string | null;
  };
}

const nullableText = { anyOf: [{ type: "string", minLength: 1, maxLength: 4000 }, { type: "null" }] };
const tagMap = { type: "object", maxProperties: 50, propertyNames: { minLength: 1, maxLength: 255 }, additionalProperties: { type: "string", maxLength: 1000 } };

export const TABLE_EVIDENCE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["table", "existing_description", "columns"],
  properties: {
    table: { type: "string", pattern: TABLE_NAME_PATTERN, maxLength: 765 },
    existing_description: nullableText,
    existing_tags: tagMap,
    columns: {
      type: "array",
      minItems: 1,
      maxItems: 2000,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "data_type", "nullable", "existing_comment"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 255 },
          data_type: { type: "string", minLength: 1, maxLength: 1000 },
          nullable: { type: "boolean" },
          existing_comment: nullableText,
          existing_tags: tagMap,
          sample_values: { type: "array", maxItems: MAX_SAMPLES, items: { anyOf: [{ type: "string", maxLength: 500 }, { type: "number" }, { type: "boolean" }, { type: "null" }] } },
        },
      },
    },
  },
} as const;

const confidenceProp = { enum: [...CONFIDENCE] };
const reasonProp = { type: "string", minLength: 1, maxLength: 2000 };
const commentProp = { anyOf: [{ type: "string", minLength: 1, maxLength: 4000 }, { type: "null" }] };

/** The output contract given to the model and enforced locally (draft-07). */
export const PROPOSAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["table", "table_description", "columns"],
  properties: {
    table: { type: "string" },
    table_description: {
      type: "object",
      additionalProperties: false,
      required: ["comment", "confidence", "reason"],
      properties: { comment: commentProp, confidence: confidenceProp, reason: reasonProp },
    },
    columns: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "comment", "confidence", "reason"],
        properties: { name: { type: "string" }, comment: commentProp, confidence: confidenceProp, reason: reasonProp },
      },
    },
  },
} as const;

const piiTagsProp = {
  anyOf: [
    { type: "null" },
    {
      type: "object",
      additionalProperties: false,
      required: ["pii_type", "sensitivity", "requires_masking"],
      properties: { pii_type: { enum: [...PII_TYPES] }, sensitivity: { enum: [...SENSITIVITIES] }, requires_masking: { enum: [...BOOLEAN_TAG] } },
    },
  ],
};

/**
 * Standards mode (workflow version 2): v1 plus the table `classification` and each
 * column's `pii_tags`. The model never proposes data_domain, uc_prefix,
 * medallion_layer or the table pii tag; Pi derives those (standards.ts).
 */
export const PROPOSAL_SCHEMA_V2 = {
  type: "object",
  additionalProperties: false,
  required: ["table", "classification", "table_description", "columns"],
  properties: {
    table: { type: "string" },
    classification: { enum: [...CLASSIFICATIONS] },
    table_description: PROPOSAL_SCHEMA.properties.table_description,
    columns: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "comment", "confidence", "reason", "pii_tags"],
        properties: { ...PROPOSAL_SCHEMA.properties.columns.items.properties, pii_tags: piiTagsProp },
      },
    },
  },
} as const;

export const APPROVED_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["table", "existing_description", "approved_description", "columns", "provenance"],
  properties: {
    table: { type: "string", pattern: TABLE_NAME_PATTERN },
    existing_description: nullableText,
    approved_description: nullableText,
    columns: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "existing_comment", "approved_comment"],
        properties: { name: { type: "string", minLength: 1 }, existing_comment: nullableText, approved_comment: nullableText },
      },
    },
    provenance: {
      type: "object",
      additionalProperties: false,
      required: ["job_id", "result_job_id", "result_custom_id", "input_sha256", "context_sha256", "proposal_sha256"],
      properties: {
        job_id: { type: "string", pattern: "^B-\\d{8}-[0-9A-Z]{4,8}$" },
        result_job_id: { anyOf: [{ type: "string" }, { type: "null" }] },
        result_custom_id: { anyOf: [{ type: "string" }, { type: "null" }] },
        input_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
        context_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
        proposal_sha256: { anyOf: [{ type: "string", pattern: "^[0-9a-f]{64}$" }, { type: "null" }] },
      },
    },
  },
} as const;

const ajv = new Ajv({ allErrors: true, strict: true, strictTypes: false, coerceTypes: false, useDefaults: false, removeAdditional: false, logger: false });
const tableValidator = ajv.compile(TABLE_EVIDENCE_SCHEMA);
const proposalValidator = ajv.compile(PROPOSAL_SCHEMA);
const proposalValidatorV2 = ajv.compile(PROPOSAL_SCHEMA_V2);
const approvedValidator = ajv.compile(APPROVED_SCHEMA);

/** Databricks identifiers are case-insensitive: duplicates are compared case-insensitively. */
export const identityKey = (s: string): string => s.toLowerCase();

/** Schema errors plus duplicate-column checks for one evidence record (no values in messages). */
export function tableEvidenceProblems(value: unknown): string[] {
  if (!tableValidator(value)) return formatErrors(tableValidator.errors ?? []);
  const t = value as TableEvidence;
  const seen = new Map<string, number>();
  const problems: string[] = [];
  t.columns.forEach((c, i) => {
    const k = identityKey(c.name);
    if (seen.has(k)) problems.push(`duplicate column ${JSON.stringify(c.name)} (columns ${seen.get(k)! + 1} and ${i + 1})`);
    else seen.set(k, i);
  });
  return problems;
}

/** SHA-256 of the canonical evidence record: identifies exactly what was sent for this table. */
export function evidenceHash(t: TableEvidence): string {
  return sha256Hex(canonicalJson(t));
}

/** The evidence sent to the model: in standards mode, without the framework audit columns. */
export function promptEvidence(ev: TableEvidence, standards?: MetadataStandards): TableEvidence {
  if (!standards) return ev;
  return { ...ev, columns: ev.columns.filter((c) => !isAuditColumn(c.name)) };
}

/**
 * Proposal checks for one table: the JSON Schema, then deterministic consistency
 * with the evidence the request was built from (`expected` is the evidence as sent,
 * see promptEvidence). They check identity and structure, not whether the prose is
 * right. With `standards`, the v2 schema applies, and every non-null comment must
 * follow the description/comment formats and carry no PII-looking text.
 */
export function proposalProblems(value: unknown, expected: TableEvidence, standards?: MetadataStandards): string[] {
  const validator = standards ? proposalValidatorV2 : proposalValidator;
  if (!validator(value)) return formatErrors(validator.errors ?? []);
  const p = value as TableProposal;
  const problems: string[] = [];
  if (p.table !== expected.table) problems.push(`/table is not the requested table (expected ${JSON.stringify(expected.table)})`);
  const expectedNames = new Map(expected.columns.map((c) => [c.name, c]));
  const seen = new Set<string>();
  for (const [i, c] of p.columns.entries()) {
    if (!expectedNames.has(c.name)) {
      const caseOnly = expected.columns.find((e) => identityKey(e.name) === identityKey(c.name));
      problems.push(caseOnly ? `/columns/${i}/name differs in case from input column ${JSON.stringify(caseOnly.name)}; names must match exactly` : `/columns/${i}/name ${JSON.stringify(c.name)} is not a column of the table (invented column)`);
      continue;
    }
    if (seen.has(c.name)) problems.push(`/columns/${i}/name ${JSON.stringify(c.name)} appears more than once`);
    seen.add(c.name);
  }
  for (const c of expected.columns) if (!seen.has(c.name)) problems.push(`column ${JSON.stringify(c.name)} is missing from the proposal`);
  const consistency = (at: string, x: { comment: string | null; confidence: Confidence }) => {
    if (x.comment === null && x.confidence !== "insufficient") problems.push(`${at}: a null comment requires confidence "insufficient"`);
    if (x.comment !== null && x.confidence === "insufficient") problems.push(`${at}: confidence "insufficient" requires a null comment (no guess)`);
  };
  consistency("/table_description", p.table_description);
  p.columns.forEach((c, i) => consistency(`/columns/${i}`, c));
  if (standards) {
    const td = p.table_description.comment;
    if (td !== null) problems.push(...[...descriptionProblems(td, p.classification), ...piiTextProblems(td)].map((m) => `/table_description/comment: ${m}`));
    p.columns.forEach((c, i) => {
      if (c.comment !== null) problems.push(...[...columnCommentProblems(c.comment), ...piiTextProblems(c.comment)].map((m) => `/columns/${i}/comment: ${m}`));
    });
    const piiColumns = p.columns.filter((c) => c.pii_tags).length;
    if (p.classification === "public" && piiColumns > 0) problems.push(`/classification: "public" is not allowed when a column has pii_tags (${piiColumns} column(s)); use a stricter classification`);
  }
  return problems;
}

export function approvedRowProblems(value: unknown): string[] {
  return approvedValidator(value) ? [] : formatErrors(approvedValidator.errors ?? []);
}
