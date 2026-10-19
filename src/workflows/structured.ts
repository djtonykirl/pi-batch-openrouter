import { Ajv, type ErrorObject } from "ajv";

/**
 * Structured (JSON) output for project workflows.
 *
 * Extraction policy (strict, predictable; shared with Release 2 `--format json`):
 *   - the whole response, trimmed, must be one JSON object; or
 *   - exactly one outer code fence (``` or ```json) whose whole content is that object
 *     (accepted with a warning).
 *   Prose before/after the JSON, several fences, arrays and scalars are invalid.
 *   JSON is never searched for inside surrounding text.
 *
 * Validation uses Ajv (JSON Schema draft-07): strict schema compilation, no type
 * coercion, no defaults, no removal of properties, no remote $ref loading. Ajv
 * compiles a schema into a validation function; schema values are embedded as
 * escaped data, and the schema itself is the user's local workflow configuration.
 */

export const MAX_OUTPUT_SCHEMA_CHARACTERS = 100_000;
const MAX_SCHEMA_DEPTH = 32;
const MAX_REPORTED_ERRORS = 20;
const DRAFT_07 = new Set(["http://json-schema.org/draft-07/schema#", "http://json-schema.org/draft-07/schema"]);

export type JsonExtraction = { ok: true; value: Record<string, unknown>; fenced: boolean } | { ok: false; error: string };

export function extractJsonObject(text: string): JsonExtraction {
  let body = text.trim();
  let fenced = false;
  const fence = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(body);
  if (fence) {
    body = fence[1]!.trim();
    fenced = true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, error: fenced ? "fenced output is not valid JSON" : "output is not valid JSON (a single JSON object was required; prose around JSON is not accepted)" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, error: "output is valid JSON but not a JSON object" };
  return { ok: true, value: parsed as Record<string, unknown>, fenced };
}

/** Errors for one parsed output (empty = valid). `customId` identifies the item, for per-item expectations. */
export type OutputValidator = (value: unknown, customId?: string) => string[];

function depth(v: unknown, d = 0): number {
  if (d > MAX_SCHEMA_DEPTH) return d;
  if (Array.isArray(v)) return Math.max(d, ...v.map((x) => depth(x, d + 1)));
  if (v && typeof v === "object") return Math.max(d, ...Object.values(v).map((x) => depth(x, d + 1)));
  return d;
}

/** Problems that prevent `schema` from being used as an output schema (empty = OK). */
export function outputSchemaProblems(schema: unknown): string[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return ["output.schema must be a JSON Schema object"];
  const s = schema as Record<string, unknown>;
  const problems: string[] = [];
  if (JSON.stringify(schema).length > MAX_OUTPUT_SCHEMA_CHARACTERS) problems.push(`output.schema is larger than ${MAX_OUTPUT_SCHEMA_CHARACTERS} characters`);
  if (depth(schema) > MAX_SCHEMA_DEPTH) problems.push(`output.schema is nested deeper than ${MAX_SCHEMA_DEPTH} levels`);
  if (s.$schema !== undefined && !DRAFT_07.has(String(s.$schema))) problems.push(`output.schema.$schema ${JSON.stringify(s.$schema)} is not supported; only JSON Schema draft-07 is`);
  if (s.type !== "object") problems.push('output.schema.type must be "object" (each item must return one JSON object)');
  if (problems.length > 0) return problems;
  const compiled = compileOutputSchema(schema);
  return compiled.ok ? [] : [compiled.error];
}

export function compileOutputSchema(schema: unknown): { ok: true; validate: OutputValidator } | { ok: false; error: string } {
  // A fresh instance per schema: no shared cache, so two workflows' $id values cannot collide.
  const ajv = new Ajv({
    strict: true,
    strictTypes: false,
    strictTuples: false,
    strictRequired: false,
    allErrors: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
    addUsedSchema: false,
    logger: false,
  });
  let fn: ReturnType<Ajv["compile"]>;
  try {
    fn = ajv.compile(schema as object);
  } catch (err) {
    return { ok: false, error: `output.schema is not a usable JSON Schema: ${(err as Error).message}` };
  }
  return {
    ok: true,
    validate: (value) => (fn(value) ? [] : formatErrors(fn.errors ?? [])),
  };
}

/** Error text names the location and rule, never the offending value. */
export function formatErrors(errors: readonly ErrorObject[]): string[] {
  const out = errors.slice(0, MAX_REPORTED_ERRORS).map((e) => {
    const at = e.instancePath || "(root)";
    // Ajv messages name the rule (and, for `required`, the property), not the instance value.
    const extra = e.keyword === "additionalProperties" ? ` (${JSON.stringify((e.params as { additionalProperty?: string }).additionalProperty)})` : "";
    return `${at} ${e.message ?? e.keyword}${extra}`;
  });
  if (errors.length > MAX_REPORTED_ERRORS) out.push(`… ${errors.length - MAX_REPORTED_ERRORS} more schema error(s)`);
  return out;
}
