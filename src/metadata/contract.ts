import { Ajv } from "ajv";
import { canonicalJson, sha256Hex } from "../fsutil.js";
import { formatErrors } from "../workflows/structured.js";
import { BOOLEAN_TAG, CLASSIFICATIONS, PII_TYPES, SENSITIVITIES, columnCommentProblems, descriptionProblems, isAuditColumn, piiTextProblems, type MetadataStandards, type PiiTags } from "./standards.js";

/**
 * Databricks metadata enrichment: the data contracts.
 *
 *   tables.jsonl   one Databricks table per line (exported by Databricks)
 *   proposal       what the model must return for one table
 *   approved.jsonl the reviewed handoff back to Databricks (no SQL, no instructions)
 *
 * All three are validated strictly: unknown fields are rejected, nothing is
 * coerced or defaulted. Only descriptions and column comments are in scope, plus
 * (in opt-in standards mode, see standards.ts) the classification and column PII tags.
 *
 * tables.jsonl contract v2 is a strict superset of v1: it adds optional,
 * already-obfuscated evidence computed inside Databricks (a per-column `profile`
 * and table-level layer/grain/lineage fields). Every v1 line is a valid v2 line and
 * hashes exactly as before. The schema mirrors the Databricks side's
 * `contract/tables.v2.schema.json` field for field (checked by test).
 *
 * Pi also accepts optional `existing_tags` (ungoverned UC tags) on tables and columns,
 * used by standards mode; it is not part of the Databricks v2 contract file (see
 * PI_TABLE_EVIDENCE_SCHEMA).
 */

/** catalog.schema.table: three non-empty parts without whitespace, dots or control characters. */
export const TABLE_NAME_PATTERN = "^[^.\\s\\u0000-\\u001f`]+\\.[^.\\s\\u0000-\\u001f`]+\\.[^.\\s\\u0000-\\u001f`]+$";
export const CONFIDENCE = ["high", "medium", "low", "insufficient"] as const;
export type Confidence = (typeof CONFIDENCE)[number];
const MAX_SAMPLES = 20;

/** Ungoverned UC tags: key to string value. Key order is significant in the handoff. */
export type TagMap = Record<string, string>;

/** 0 open (reference values), 1 shape, 2 statistics, 3 label only. */
export type DisclosureTier = 0 | 1 | 2 | 3;

export interface ColumnProfile {
  disclosure_tier: DisclosureTier;
  tier_reason: string;
  column_family_id?: string;
  pct_null?: number;
  pct_unique?: number;
  is_candidate_key?: boolean;
  format_masks?: Array<{ mask: string; pct: number }>;
  len_min?: number;
  len_max?: number;
  numeric_sign?: "positive" | "negative" | "mixed" | "zero";
  magnitude_order?: number;
  decimal_places?: number;
  join_hints?: Array<{ target_table: string; target_column: string; pct_overlap: number }>;
  semantic_label?: string;
}

export interface ColumnEvidence {
  name: string;
  data_type: string;
  nullable: boolean;
  existing_comment: string | null;
  existing_tags?: TagMap;
  sample_values?: Array<string | number | boolean | null>;
  /** v2 only. */
  profile?: ColumnProfile;
}

export interface TableEvidence {
  table: string;
  existing_description: string | null;
  existing_tags?: TagMap;
  columns: ColumnEvidence[];
  /** v2 only: "2" makes a profile required on every column. */
  contract_version?: "2";
  layer?: "bronze" | "silver" | "gold" | "other";
  domain_prefix?: string;
  object_type?: "MANAGED" | "EXTERNAL" | "VIEW" | "MATERIALIZED_VIEW" | "STREAMING_TABLE";
  row_count_band?: "0" | "1-1K" | "1K-100K" | "100K-10M" | ">10M";
  write_cadence?: "daily" | "weekly" | "monthly" | "adhoc" | "unknown";
  grain_candidates?: string[][];
  upstream_tables?: string[];
  writer_logic?: string;
  view_definition?: string;
}

const V2_TABLE_FIELDS = ["contract_version", "layer", "domain_prefix", "object_type", "row_count_band", "write_cadence", "grain_candidates", "upstream_tables", "writer_logic", "view_definition"] as const;

/** True when a record uses any v2 field (table-level or a column profile). */
export function usesV2Evidence(t: TableEvidence): boolean {
  return V2_TABLE_FIELDS.some((k) => t[k] !== undefined) || t.columns.some((c) => c.profile !== undefined);
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

export interface ApprovedColumn {
  name: string;
  existing_comment: string | null;
  approved_comment: string | null;
  /** Standards mode only (required there, rejected on a version 1 job). */
  existing_tags?: TagMap;
  approved_tags?: TagMap;
}

/**
 * One table of approved.jsonl. Key order is part of the contract (TDD §3.3):
 * table, existing_description, approved_description, [existing_tags, approved_tags,]
 * columns[name, existing_comment, approved_comment, [existing_tags, approved_tags]], provenance.
 * Version 1 rows carry no tag keys.
 */
export interface ApprovedRow {
  table: string;
  existing_description: string | null;
  approved_description: string | null;
  existing_tags?: TagMap;
  approved_tags?: TagMap;
  columns: ApprovedColumn[];
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

/**
 * tables.jsonl line, contract v2 (strict superset of v1). Tier rules are schema-enforced:
 * sample_values only at tier 0 (or without a profile); no masks/lengths at tiers 2-3;
 * no numeric shape at tier 3; contract_version "2" requires a profile on every column.
 */
export const TABLE_EVIDENCE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["table", "existing_description", "columns"],
  definitions: {
    tableName: { type: "string", pattern: TABLE_NAME_PATTERN, maxLength: 765 },
    nullableText,
    pct: { type: "number", minimum: 0, maximum: 100 },
    profile: {
      type: "object",
      additionalProperties: false,
      required: ["disclosure_tier", "tier_reason"],
      properties: {
        disclosure_tier: { type: "integer", minimum: 0, maximum: 3 },
        tier_reason: { type: "string", minLength: 1, maxLength: 500 },
        column_family_id: { type: "string", pattern: "^[a-z0-9_]{1,64}$" },
        pct_null: { $ref: "#/definitions/pct" },
        pct_unique: { $ref: "#/definitions/pct" },
        is_candidate_key: { type: "boolean" },
        format_masks: {
          type: "array",
          maxItems: 5,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["mask", "pct"],
            properties: {
              mask: { type: "string", minLength: 1, maxLength: 64, pattern: "^[Aa9 ._/:,()#+\\-]+$" },
              pct: { $ref: "#/definitions/pct" },
            },
          },
        },
        len_min: { type: "integer", minimum: 0 },
        len_max: { type: "integer", minimum: 0 },
        numeric_sign: { enum: ["positive", "negative", "mixed", "zero"] },
        magnitude_order: { type: "integer", minimum: -12, maximum: 18 },
        decimal_places: { type: "integer", minimum: 0, maximum: 38 },
        join_hints: {
          type: "array",
          maxItems: 5,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["target_table", "target_column", "pct_overlap"],
            properties: {
              target_table: { $ref: "#/definitions/tableName" },
              target_column: { type: "string", minLength: 1, maxLength: 255 },
              pct_overlap: { $ref: "#/definitions/pct" },
            },
          },
        },
        semantic_label: { type: "string", minLength: 1, maxLength: 200 },
      },
      allOf: [
        {
          if: { properties: { disclosure_tier: { minimum: 2 } } },
          then: { not: { anyOf: [{ required: ["format_masks"] }, { required: ["len_min"] }, { required: ["len_max"] }] } },
        },
        {
          if: { properties: { disclosure_tier: { const: 3 } } },
          then: { not: { anyOf: [{ required: ["numeric_sign"] }, { required: ["magnitude_order"] }, { required: ["decimal_places"] }] } },
        },
      ],
    },
    column: {
      type: "object",
      additionalProperties: false,
      required: ["name", "data_type", "nullable", "existing_comment"],
      properties: {
        name: { type: "string", minLength: 1, maxLength: 255 },
        data_type: { type: "string", minLength: 1, maxLength: 1000 },
        nullable: { type: "boolean" },
        existing_comment: { $ref: "#/definitions/nullableText" },
        sample_values: { type: "array", maxItems: MAX_SAMPLES, items: { anyOf: [{ type: "string", maxLength: 500 }, { type: "number" }, { type: "boolean" }, { type: "null" }] } },
        profile: { $ref: "#/definitions/profile" },
      },
      if: { required: ["profile"], properties: { profile: { required: ["disclosure_tier"], properties: { disclosure_tier: { minimum: 1 } } } } },
      then: { not: { required: ["sample_values"] } },
    },
  },
  properties: {
    table: { $ref: "#/definitions/tableName" },
    existing_description: { $ref: "#/definitions/nullableText" },
    columns: { type: "array", minItems: 1, maxItems: 2000, items: { $ref: "#/definitions/column" } },
    contract_version: { const: "2" },
    layer: { enum: ["bronze", "silver", "gold", "other"] },
    domain_prefix: { type: "string", pattern: "^[A-Z0-9]{4}$" },
    object_type: { enum: ["MANAGED", "EXTERNAL", "VIEW", "MATERIALIZED_VIEW", "STREAMING_TABLE"] },
    row_count_band: { enum: ["0", "1-1K", "1K-100K", "100K-10M", ">10M"] },
    write_cadence: { enum: ["daily", "weekly", "monthly", "adhoc", "unknown"] },
    grain_candidates: { type: "array", maxItems: 5, items: { type: "array", minItems: 1, maxItems: 8, items: { type: "string", minLength: 1, maxLength: 255 } } },
    upstream_tables: { type: "array", maxItems: 50, items: { $ref: "#/definitions/tableName" } },
    writer_logic: { type: "string", minLength: 1, maxLength: 8000 },
    view_definition: { type: "string", minLength: 1, maxLength: 8000 },
  },
  if: { required: ["contract_version"] },
  then: { properties: { columns: { items: { required: ["profile"] } } } },
} as const;

/**
 * What Pi validates tables.jsonl lines against: the Databricks contract above (kept a verbatim
 * mirror) plus the optional `existing_tags` on the table and on each column (standards mode).
 * Both are optional, so v1 and v2 lines validate and hash exactly as before.
 */
export const PI_TABLE_EVIDENCE_SCHEMA = {
  ...TABLE_EVIDENCE_SCHEMA,
  definitions: {
    ...TABLE_EVIDENCE_SCHEMA.definitions,
    column: { ...TABLE_EVIDENCE_SCHEMA.definitions.column, properties: { ...TABLE_EVIDENCE_SCHEMA.definitions.column.properties, existing_tags: tagMap } },
  },
  properties: { ...TABLE_EVIDENCE_SCHEMA.properties, existing_tags: tagMap },
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

/**
 * approved.jsonl row schema. `tags` decides the tag keys: "none" is the version 1
 * contract (tag keys are unknown properties), "optional" is the published schema,
 * and "required" is what a standards-mode (version 2) job's rows must satisfy.
 */
function approvedSchema(tags: "none" | "optional" | "required") {
  const tagProps = tags === "none" ? {} : { existing_tags: tagMap, approved_tags: tagMap };
  const tagKeys = tags === "required" ? ["existing_tags", "approved_tags"] : [];
  return {
    type: "object",
    additionalProperties: false,
    required: ["table", "existing_description", "approved_description", ...tagKeys, "columns", "provenance"],
    properties: {
      table: { type: "string", pattern: TABLE_NAME_PATTERN },
      existing_description: nullableText,
      approved_description: nullableText,
      ...tagProps,
      columns: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "existing_comment", "approved_comment", ...tagKeys],
          properties: { name: { type: "string", minLength: 1 }, existing_comment: nullableText, approved_comment: nullableText, ...tagProps },
        },
      },
      provenance: APPROVED_PROVENANCE,
    },
  };
}

const APPROVED_PROVENANCE = {
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
} as const;

/** The published approved.jsonl schema: tag keys allowed; validateApprovedText requires or rejects them by job version. */
export const APPROVED_SCHEMA = approvedSchema("optional");

// strictRequired is off because the v2 tier rules use `if: { required: [...] }` conditionals
// (an authoring check only; validation is unchanged).
const ajv = new Ajv({ allErrors: true, strict: true, strictTypes: false, strictRequired: false, coerceTypes: false, useDefaults: false, removeAdditional: false, logger: false });
const tableValidator = ajv.compile(PI_TABLE_EVIDENCE_SCHEMA);
const proposalValidator = ajv.compile(PROPOSAL_SCHEMA);
const proposalValidatorV2 = ajv.compile(PROPOSAL_SCHEMA_V2);
const approvedValidatorV1 = ajv.compile(approvedSchema("none"));
const approvedValidatorV2 = ajv.compile(approvedSchema("required"));

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

/** Schema problems of one approved row: version 1 rejects tag keys; standards mode requires them. */
export function approvedRowProblems(value: unknown, standards?: MetadataStandards): string[] {
  const validator = standards ? approvedValidatorV2 : approvedValidatorV1;
  return validator(value) ? [] : formatErrors(validator.errors ?? []);
}
