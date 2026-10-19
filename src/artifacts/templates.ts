import * as fs from "node:fs";
import * as path from "node:path";
import { Ajv } from "ajv";
import { canonicalJson, isInside, sha256Hex } from "../fsutil.js";
import { decodeUtf8, hasProtoKey, parseYaml, schemaDiagnostics, type Diagnostic } from "../workflows/definition.js";
import { compileOutputSchema, outputSchemaProblems } from "../workflows/structured.js";
import { TemplateError, parseTemplate, renderTemplate } from "../workflows/template.js";

/**
 * Artifact templates: `.pi/artifact-templates/<name>.yaml`. DATA, not code.
 *
 *   schemaVersion: 1
 *   name: report                 # must equal the file name
 *   description: …
 *   input:
 *     type: json                 # json: a validated JSON object; text: the result text as {{content}}
 *     schema: { … }              # json only: JSON Schema draft-07 the data must satisfy before rendering
 *   body: |
 *     # {{title}}
 *     {{findings}}
 *
 * The body uses the Release 3 template engine: `{{field}}` only, single pass,
 * values never re-scanned. For json input every placeholder must be a REQUIRED
 * schema property, so missing data fails validation before anything is rendered.
 *
 * Values become Markdown by fixed rules (no code involved):
 *   string -> as is; number/boolean -> String(v)
 *   array of scalars -> "- item" lines
 *   array of objects of scalars -> "- **key:** value; **key:** value" lines
 *   object of scalars -> "- **key:** value" lines
 *   anything nested deeper, or null -> a render error
 */

export const ARTIFACT_TEMPLATE_DIR = ".pi/artifact-templates";
export const MAX_TEMPLATE_BYTES = 256 * 1024;
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface ArtifactTemplate {
  schemaVersion: 1;
  name: string;
  description?: string;
  input: { type: "json"; schema: Record<string, unknown> } | { type: "text" };
  body: string;
}

export interface TemplateEntry {
  name: string;
  /** Workspace-relative path. */
  file: string;
  valid: boolean;
  diagnostics: Diagnostic[];
  template?: ArtifactTemplate;
  /** SHA-256 of the template file bytes. */
  sha256?: string;
}

const TEMPLATE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "name", "input", "body"],
  properties: {
    schemaVersion: { const: 1 },
    name: { type: "string", pattern: NAME.source },
    description: { type: "string", minLength: 1, maxLength: 500 },
    input: {
      type: "object",
      additionalProperties: false,
      required: ["type"],
      properties: { type: { enum: ["json", "text"] }, schema: { type: "object" } },
    },
    body: { type: "string", minLength: 1, maxLength: 200_000 },
  },
} as const;

const templateValidator = new Ajv({ allErrors: true, strict: true, logger: false }).compile(TEMPLATE_SCHEMA);

function validateTemplateText(text: string, file: string, expectedName: string): { template?: ArtifactTemplate; diagnostics: Diagnostic[] } {
  const parsed = parseYaml(text, file);
  if (!parsed.ok) return { diagnostics: parsed.diagnostics };
  const v = parsed.value;
  if (!v || typeof v !== "object" || Array.isArray(v)) return { diagnostics: [{ file, path: "", message: "an artifact template must be a YAML mapping" }] };
  if (hasProtoKey(v)) return { diagnostics: [{ file, path: "", message: 'the key "__proto__" is not allowed' }] };
  if (!templateValidator(v)) return { diagnostics: schemaDiagnostics(file, templateValidator.errors ?? []) };
  const raw = v as { schemaVersion: 1; name: string; description?: string; input: { type: "json" | "text"; schema?: Record<string, unknown> }; body: string };
  const d: Diagnostic[] = [];
  if (raw.name !== expectedName) d.push({ file, path: "name", message: `name ${JSON.stringify(raw.name)} does not match the file name ${JSON.stringify(expectedName)}` });
  let fields: string[] = [];
  try {
    fields = parseTemplate(raw.body).fields;
  } catch (err) {
    if (err instanceof TemplateError) d.push({ file, path: "body", message: err.message });
    else throw err;
  }
  if (raw.input.type === "json") {
    if (!raw.input.schema) d.push({ file, path: "input.schema", message: "required when input.type is json" });
    else {
      for (const p of outputSchemaProblems(raw.input.schema)) d.push({ file, path: "input.schema", message: p.replace(/^output\.schema/, "input.schema") });
      const props = (raw.input.schema.properties ?? {}) as Record<string, unknown>;
      const required = new Set((raw.input.schema.required as string[] | undefined) ?? []);
      for (const f of fields) {
        if (!(f in props)) d.push({ file, path: "body", message: `{{${f}}} is not a property of input.schema` });
        else if (!required.has(f)) d.push({ file, path: "body", message: `{{${f}}} must be listed in input.schema.required (placeholders never render as empty)` });
      }
    }
  } else {
    if (raw.input.schema !== undefined) d.push({ file, path: "input.schema", message: "only allowed when input.type is json" });
    for (const f of fields) if (f !== "content") d.push({ file, path: "body", message: `text templates only support {{content}} (found {{${f}}})` });
  }
  if (fields.length === 0) d.push({ file, path: "body", message: "the body references no fields" });
  if (d.length > 0) return { diagnostics: d };
  const input: ArtifactTemplate["input"] = raw.input.type === "json" ? { type: "json", schema: raw.input.schema! } : { type: "text" };
  return { template: { schemaVersion: 1, name: raw.name, ...(raw.description ? { description: raw.description } : {}), input, body: raw.body }, diagnostics: [] };
}

/** Templates in file-name order; symlinks are not followed; bad files are reported, never thrown. */
export function discoverTemplates(workspaceRoot: string): TemplateEntry[] {
  const dir = path.join(workspaceRoot, ...ARTIFACT_TEMPLATE_DIR.split("/"));
  if (!fs.existsSync(dir)) return [];
  const rootReal = fs.realpathSync.native(workspaceRoot);
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => /\.ya?ml$/i.test(e.name))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((e): TemplateEntry => {
      const file = `${ARTIFACT_TEMPLATE_DIR}/${e.name}`;
      const name = e.name.replace(/\.ya?ml$/i, "");
      const abs = path.join(dir, e.name);
      if (!e.isFile() || !isInside(rootReal, fs.realpathSync.native(abs))) return { name, file, valid: false, diagnostics: [{ file, path: "", message: "not a regular file inside the workspace (symbolic links are not followed)" }] };
      const bytes = fs.readFileSync(abs);
      const sha256 = sha256Hex(bytes);
      if (bytes.length > MAX_TEMPLATE_BYTES) return { name, file, valid: false, sha256, diagnostics: [{ file, path: "", message: `file is larger than ${MAX_TEMPLATE_BYTES} bytes` }] };
      const text = decodeUtf8(bytes);
      if (text === undefined) return { name, file, valid: false, sha256, diagnostics: [{ file, path: "", message: "file is not valid UTF-8 text" }] };
      const r = validateTemplateText(text, file, name);
      return r.template ? { name, file, valid: true, diagnostics: [], template: r.template, sha256 } : { name, file, valid: false, diagnostics: r.diagnostics, sha256 };
    });
}

export function findTemplate(workspaceRoot: string, name: string): TemplateEntry {
  if (!NAME.test(name)) throw new Error(`invalid template name ${JSON.stringify(name)} (use [a-z0-9-])`);
  const all = discoverTemplates(workspaceRoot);
  const hits = all.filter((t) => t.name === name);
  if (hits.length === 0) throw new Error(`No artifact template named ${JSON.stringify(name)} in ${ARTIFACT_TEMPLATE_DIR}/.${all.length ? ` Available: ${all.map((t) => t.name).join(", ")}.` : ""}`);
  if (hits.length > 1) throw new Error(`Artifact template ${JSON.stringify(name)} is defined twice (${hits.map((h) => h.file).join(", ")}); remove one.`);
  return hits[0]!;
}

// ------------------------------------------------------------------ values

const isScalar = (v: unknown) => typeof v === "string" || typeof v === "number" || typeof v === "boolean";

function indentContinuation(s: string): string {
  return s.replace(/\n/g, "\n  ");
}

function scalarText(v: unknown, at: string): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  throw new TemplateError(`${at} is ${v === null ? "null" : Array.isArray(v) ? "a nested list" : "a nested object"}; only one level of structure can be placed in a document`);
}

function objectLine(o: Record<string, unknown>, at: string): string {
  return Object.entries(o)
    .map(([k, v]) => `**${k}:** ${indentContinuation(scalarText(v, `${at}.${k}`))}`)
    .join("; ");
}

/** Deterministic Markdown for one placeholder value (see module comment). */
export function formatValue(v: unknown, field: string): string {
  if (isScalar(v)) return scalarText(v, field);
  if (Array.isArray(v)) {
    return v
      .map((item, i) => {
        const at = `${field}[${i}]`;
        if (isScalar(item)) return `- ${indentContinuation(scalarText(item, at))}`;
        if (item && typeof item === "object" && !Array.isArray(item)) return `- ${objectLine(item as Record<string, unknown>, at)}`;
        return `- ${scalarText(item, at)}`;
      })
      .join("\n");
  }
  if (v && typeof v === "object") {
    return Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => `- **${k}:** ${indentContinuation(scalarText(x, `${field}.${k}`))}`)
      .join("\n");
  }
  return scalarText(v, field);
}

export interface TemplateRender {
  markdown: string;
  /** SHA-256 of the canonical resolved input (the data or {content}). */
  inputSha256: string;
}

/**
 * Validates the input against the template (json: Ajv against input.schema) and
 * renders the body. Throws TemplateError with locations (never values) on failure.
 */
export function applyTemplate(t: ArtifactTemplate, input: { kind: "json"; data: unknown } | { kind: "text"; text: string }): TemplateRender {
  if (t.input.type !== input.kind) {
    throw new TemplateError(`template ${t.name} expects ${t.input.type} input, but the selected source is ${input.kind === "json" ? "structured JSON" : "text"}`);
  }
  const parsed = parseTemplate(t.body);
  let values: Record<string, string>;
  let resolved: unknown;
  if (input.kind === "json" && t.input.type === "json") {
    const compiled = compileOutputSchema(t.input.schema);
    if (!compiled.ok) throw new TemplateError(compiled.error);
    const errors = compiled.validate(input.data);
    if (errors.length > 0) throw new TemplateError(`the source data does not satisfy template ${t.name}'s input schema; nothing was rendered:\n  - ${errors.join("\n  - ")}`);
    const data = input.data as Record<string, unknown>;
    values = Object.fromEntries(parsed.fields.map((f) => [f, formatValue(data[f], f)]));
    resolved = data;
  } else {
    const text = (input as { text: string }).text;
    values = { content: text.trimEnd() };
    resolved = { content: text };
  }
  const md = renderTemplate(parsed, values);
  return { markdown: md.endsWith("\n") ? md : md + "\n", inputSha256: sha256Hex(canonicalJson(resolved)) };
}
