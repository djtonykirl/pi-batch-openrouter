import * as fs from "node:fs";
import * as path from "node:path";
import { Ajv, type ErrorObject } from "ajv";
import { parseDocument, visit } from "yaml";
import type { BatchConfig } from "../config.js";
import { canonicalJson, isInside, sha256Hex } from "../fsutil.js";
import { resolveWorkspaceInput } from "../workspace-paths.js";
import { outputSchemaProblems } from "./structured.js";
import { FIELD_NAME_PATTERN, TemplateError, parseTemplate } from "./template.js";

/**
 * Project workflow definitions: declarative YAML configuration for the existing
 * batch engine. A workflow can choose a model, select dataset fields, fill ONE
 * prompt template per row, and declare an output schema and local limits. It
 * cannot run code, call URLs, import other files or reference the environment.
 *
 * Discovery: `<workspace>/.pi/batch-workflows/*.yaml|*.yml`, non-recursive,
 * sorted by file name. A workflow's `name` must equal its file name (without the
 * extension), so a name maps to exactly one file; two files claiming one name
 * (e.g. x.yaml and x.yml) are both reported as duplicates and neither is usable.
 */

export const WORKFLOW_DIR = ".pi/batch-workflows";
export const WORKFLOW_SCHEMA_VERSIONS = [1] as const;
export const MAX_WORKFLOW_BYTES = 256 * 1024;
export const WORKFLOW_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const BUILTIN_WORKFLOWS = [
  {
    name: "map-files",
    description: "One request per selected workspace file (or per group of files), sharing one objective, in one batch.",
    usage: '/batch run map-files --file <path> [--file <path> ...] --prompt "<objective>" [--group-size n] [--preview]',
  },
] as const;

export interface WorkflowDefinition {
  schemaVersion: 1;
  name: string;
  description?: string;
  model: { default?: string; provider?: string };
  input: { type: "csv" | "jsonl"; idField: string; fields: string[]; delimiter?: string };
  request: { system?: string; prompt: string; maxTokens?: number };
  output: { type: "markdown" } | { type: "json"; schema: Record<string, unknown> };
  synthesis: { enabled: boolean };
  limits: { maxRequests?: number; maxRows?: number; maxCharactersPerItem?: number; maxTotalCharacters?: number };
}

export interface Diagnostic {
  /** Workspace-relative file. */
  file: string;
  /** Location inside the definition, e.g. `request.prompt` ("" = whole file). */
  path: string;
  message: string;
}

export interface WorkflowEntry {
  name: string;
  /** Workspace-relative path. */
  file: string;
  origin: "project";
  valid: boolean;
  diagnostics: Diagnostic[];
  warnings: Diagnostic[];
  definition?: WorkflowDefinition;
  /** SHA-256 of the definition file's bytes. */
  definitionSha256?: string;
  /** SHA-256 of the canonical resolved definition. */
  resolvedSha256?: string;
  /** Exact file bytes (persisted verbatim with each job). */
  bytes?: Buffer;
}

const FIELD = FIELD_NAME_PATTERN.source;
const POSITIVE = { type: "integer", minimum: 1 } as const;

/** JSON Schema for the definition itself. Every object rejects unknown properties. */
const DEFINITION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "name", "input", "request", "output"],
  properties: {
    schemaVersion: { type: "integer" },
    name: { type: "string", pattern: WORKFLOW_NAME_PATTERN.source },
    description: { type: "string", minLength: 1, maxLength: 500 },
    model: {
      type: "object",
      additionalProperties: false,
      properties: {
        default: { type: "string", minLength: 1, maxLength: 200, pattern: "^[^\\s]+$" },
        provider: { type: "string", pattern: "^[A-Za-z0-9._/-]{1,100}$" },
      },
    },
    input: {
      type: "object",
      additionalProperties: false,
      required: ["type", "idField", "fields"],
      properties: {
        type: { enum: ["csv", "jsonl"] },
        idField: { type: "string", pattern: FIELD },
        fields: { type: "array", minItems: 1, maxItems: 100, uniqueItems: true, items: { type: "string", pattern: FIELD } },
        delimiter: { enum: [",", ";", "\t", "|"] },
      },
    },
    request: {
      type: "object",
      additionalProperties: false,
      required: ["prompt"],
      properties: {
        system: { type: "string", minLength: 1, maxLength: 20_000 },
        prompt: { type: "string", minLength: 1, maxLength: 100_000 },
        maxTokens: { type: "integer", minimum: 1, maximum: 1_000_000 },
      },
    },
    output: {
      type: "object",
      additionalProperties: false,
      required: ["type"],
      properties: { type: { enum: ["markdown", "json"] }, schema: { type: "object" } },
    },
    synthesis: { type: "object", additionalProperties: false, required: ["enabled"], properties: { enabled: { type: "boolean" } } },
    limits: {
      type: "object",
      additionalProperties: false,
      properties: { maxRequests: POSITIVE, maxRows: POSITIVE, maxCharactersPerItem: POSITIVE, maxTotalCharacters: POSITIVE },
    },
  },
} as const;

const definitionValidator = new Ajv({ allErrors: true, strict: true, logger: false }).compile(DEFINITION_SCHEMA);

/** `/input/fields/0` -> `input.fields[0]` */
function displayPath(pointer: string): string {
  return pointer
    .split("/")
    .slice(1)
    .map((seg) => seg.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce((acc, seg) => (/^\d+$/.test(seg) ? `${acc}[${seg}]` : acc ? `${acc}.${seg}` : seg), "");
}

function schemaDiagnostics(file: string, errors: readonly ErrorObject[]): Diagnostic[] {
  return errors.map((e) => {
    const at = displayPath(e.instancePath);
    if (e.keyword === "additionalProperties") {
      const prop = (e.params as { additionalProperty: string }).additionalProperty;
      return { file, path: at ? `${at}.${prop}` : prop, message: `unknown property ${JSON.stringify(prop)}` };
    }
    if (e.keyword === "required") {
      const prop = (e.params as { missingProperty: string }).missingProperty;
      return { file, path: at ? `${at}.${prop}` : prop, message: "required property is missing" };
    }
    if (e.keyword === "enum") return { file, path: at, message: `must be one of ${(e.params as { allowedValues: unknown[] }).allowedValues.map((v) => JSON.stringify(v)).join(", ")}` };
    return { file, path: at, message: e.message ?? e.keyword };
  });
}

/** Parses YAML strictly: one document, unique keys, no aliases/anchors, no custom tags. */
function parseYaml(text: string, file: string): { ok: true; value: unknown } | { ok: false; diagnostics: Diagnostic[] } {
  const doc = parseDocument(text, { uniqueKeys: true, merge: false, version: "1.2", schema: "core", prettyErrors: false });
  const problems = [...doc.errors, ...doc.warnings].map((e) => {
    const pos = e.linePos?.[0];
    return { file, path: pos ? `line ${pos.line}, column ${pos.col}` : "", message: `YAML ${e.code}: ${e.message.split("\n")[0]}` };
  });
  let aliases = 0;
  visit(doc, {
    Alias() {
      aliases++;
    },
    Node(_key, node) {
      if ((node as { anchor?: string }).anchor) aliases++;
    },
  });
  if (aliases > 0) problems.push({ file, path: "", message: "YAML anchors and aliases are not supported in workflow definitions" });
  if (problems.length > 0) return { ok: false, diagnostics: problems };
  return { ok: true, value: doc.toJS({ maxAliasCount: 0 }) };
}

function hasProtoKey(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(hasProtoKey);
  if (v && typeof v === "object") return Object.keys(v).some((k) => k === "__proto__" || hasProtoKey((v as Record<string, unknown>)[k]));
  return false;
}

/** The definition with workflow-level defaults applied (independent of local config, so its hash identifies the workflow). */
function resolveDefinition(raw: Record<string, unknown>): WorkflowDefinition {
  const r = raw as unknown as WorkflowDefinition & { synthesis?: { enabled: boolean }; model?: WorkflowDefinition["model"]; limits?: WorkflowDefinition["limits"] };
  const output: WorkflowDefinition["output"] = r.output.type === "json" ? { type: "json", schema: (r.output as { schema: Record<string, unknown> }).schema } : { type: "markdown" };
  return {
    schemaVersion: 1,
    name: r.name,
    ...(r.description !== undefined ? { description: r.description } : {}),
    model: { ...(r.model?.default ? { default: r.model.default } : {}), ...(r.model?.provider ? { provider: r.model.provider } : {}) },
    input: {
      type: r.input.type,
      idField: r.input.idField,
      fields: [...r.input.fields],
      ...(r.input.type === "csv" ? { delimiter: r.input.delimiter ?? "," } : {}),
    },
    request: {
      ...(r.request.system !== undefined ? { system: r.request.system } : {}),
      prompt: r.request.prompt,
      ...(r.request.maxTokens !== undefined ? { maxTokens: r.request.maxTokens } : {}),
    },
    output,
    synthesis: { enabled: r.synthesis?.enabled ?? false },
    limits: { ...(r.limits ?? {}) },
  };
}

/** Validates definition text. `expectedName` (the file stem) is enforced for discovered workflows. */
export function validateDefinitionText(
  text: string,
  file: string,
  opts: { expectedName?: string; nameMustMatch: boolean },
): { definition?: WorkflowDefinition; diagnostics: Diagnostic[]; warnings: Diagnostic[] } {
  const parsed = parseYaml(text, file);
  if (!parsed.ok) return { diagnostics: parsed.diagnostics, warnings: [] };
  const value = parsed.value;
  const d: Diagnostic[] = [];
  const warnings: Diagnostic[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return { diagnostics: [{ file, path: "", message: "a workflow definition must be a YAML mapping" }], warnings };
  const obj = value as Record<string, unknown>;
  if (hasProtoKey(obj)) return { diagnostics: [{ file, path: "", message: 'the key "__proto__" is not allowed' }], warnings };
  if (obj.schemaVersion === undefined) return { diagnostics: [{ file, path: "schemaVersion", message: "required property is missing (this release supports schemaVersion: 1)" }], warnings };
  if (!(WORKFLOW_SCHEMA_VERSIONS as readonly unknown[]).includes(obj.schemaVersion)) {
    return { diagnostics: [{ file, path: "schemaVersion", message: `unsupported schemaVersion ${JSON.stringify(obj.schemaVersion)}; this release supports: ${WORKFLOW_SCHEMA_VERSIONS.join(", ")}` }], warnings };
  }
  if (!definitionValidator(obj)) return { diagnostics: schemaDiagnostics(file, definitionValidator.errors ?? []), warnings };

  const def = resolveDefinition(obj);
  if (BUILTIN_WORKFLOWS.some((b) => b.name === def.name)) d.push({ file, path: "name", message: `"${def.name}" is a built-in workflow name and cannot be redefined` });
  if (opts.expectedName !== undefined && def.name !== opts.expectedName) {
    const diag = { file, path: "name", message: `name ${JSON.stringify(def.name)} does not match the file name ${JSON.stringify(opts.expectedName)}` };
    (opts.nameMustMatch ? d : warnings).push(diag);
  }
  if (def.input.type !== "csv" && (obj.input as Record<string, unknown>).delimiter !== undefined) d.push({ file, path: "input.delimiter", message: "only applies to csv input" });

  try {
    const t = parseTemplate(def.request.prompt);
    const unknown = t.fields.filter((f) => !def.input.fields.includes(f));
    for (const f of unknown) d.push({ file, path: "request.prompt", message: `template references {{${f}}}, which is not listed in input.fields` });
    const unused = def.input.fields.filter((f) => !t.fields.includes(f));
    for (const f of unused) d.push({ file, path: "input.fields", message: `field ${JSON.stringify(f)} is selected but never used in request.prompt (only fields sent to the model may be selected)` });
    if (t.fields.length === 0) d.push({ file, path: "request.prompt", message: "the prompt references no fields; every request would be identical" });
  } catch (err) {
    if (err instanceof TemplateError) d.push({ file, path: "request.prompt", message: err.message });
    else throw err;
  }
  if (def.request.system !== undefined && def.request.system.includes("{{")) {
    d.push({ file, path: "request.system", message: "the system prompt is literal text; {{...}} templates are only supported in request.prompt" });
  }

  const rawOutput = obj.output as Record<string, unknown>;
  if (def.output.type === "json") {
    if (rawOutput.schema === undefined) d.push({ file, path: "output.schema", message: "required when output.type is json" });
    else for (const p of outputSchemaProblems(rawOutput.schema)) d.push({ file, path: "output.schema", message: p });
  } else if (rawOutput.schema !== undefined) {
    d.push({ file, path: "output.schema", message: "only allowed when output.type is json" });
  }
  return d.length > 0 ? { diagnostics: d, warnings } : { definition: def, diagnostics: [], warnings };
}

export function resolvedHash(def: WorkflowDefinition): string {
  return sha256Hex(canonicalJson(def));
}

function decodeUtf8(bytes: Buffer): string | undefined {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch {
    return undefined;
  }
}

function entryFromBytes(bytes: Buffer, file: string, opts: { expectedName?: string; nameMustMatch: boolean }): WorkflowEntry {
  const stemName = opts.expectedName ?? path.basename(file).replace(/\.ya?ml$/i, "");
  const base: WorkflowEntry = { name: stemName, file, origin: "project", valid: false, diagnostics: [], warnings: [], definitionSha256: sha256Hex(bytes), bytes };
  if (bytes.length > MAX_WORKFLOW_BYTES) return { ...base, diagnostics: [{ file, path: "", message: `file is ${bytes.length} bytes (limit ${MAX_WORKFLOW_BYTES})` }] };
  const text = decodeUtf8(bytes);
  if (text === undefined) return { ...base, diagnostics: [{ file, path: "", message: "file is not valid UTF-8 text" }] };
  const r = validateDefinitionText(text, file, opts);
  if (!r.definition) return { ...base, diagnostics: r.diagnostics, warnings: r.warnings };
  return { ...base, name: r.definition.name, valid: true, definition: r.definition, resolvedSha256: resolvedHash(r.definition), warnings: r.warnings };
}

export interface Catalog {
  dir: string;
  entries: WorkflowEntry[];
}

/** Deterministic: entries sorted by file name (code-unit order). Never throws for a bad file. */
export function discoverWorkflows(workspaceRoot: string): Catalog {
  const dirAbs = path.join(workspaceRoot, ...WORKFLOW_DIR.split("/"));
  const out: Catalog = { dir: WORKFLOW_DIR, entries: [] };
  if (!fs.existsSync(dirAbs)) return out;
  const rootReal = fs.realpathSync.native(workspaceRoot);
  const names = fs
    .readdirSync(dirAbs, { withFileTypes: true })
    .filter((e) => /\.ya?ml$/i.test(e.name))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of names) {
    const file = `${WORKFLOW_DIR}/${e.name}`;
    const stem = e.name.replace(/\.ya?ml$/i, "");
    if (!e.isFile()) {
      out.entries.push({ name: stem, file, origin: "project", valid: false, warnings: [], diagnostics: [{ file, path: "", message: e.isSymbolicLink() ? "symbolic links are not followed for workflow definitions" : "not a regular file" }] });
      continue;
    }
    const abs = path.join(dirAbs, e.name);
    if (!isInside(rootReal, fs.realpathSync.native(abs))) {
      out.entries.push({ name: stem, file, origin: "project", valid: false, warnings: [], diagnostics: [{ file, path: "", message: "resolves outside the workspace" }] });
      continue;
    }
    out.entries.push(entryFromBytes(fs.readFileSync(abs), file, { expectedName: stem, nameMustMatch: true }));
  }
  // Duplicate names (x.yaml + x.yml; or case variants on case-sensitive file systems): none is usable.
  const byName = new Map<string, WorkflowEntry[]>();
  for (const e of out.entries) {
    const key = e.name.toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), e]);
  }
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    for (const e of group) {
      e.valid = false;
      e.diagnostics.push({ file: e.file, path: "name", message: `duplicate workflow name ${JSON.stringify(e.name)}: also defined by ${group.filter((g) => g !== e).map((g) => g.file).join(", ")}` });
    }
  }
  return out;
}

export class WorkflowNotFoundError extends Error {
  constructor(name: string, available: string[]) {
    super(`No workflow named ${JSON.stringify(name)}. ${available.length ? `Project workflows: ${available.join(", ")}.` : `No project workflows in ${WORKFLOW_DIR}/.`} Built-in: ${BUILTIN_WORKFLOWS.map((b) => b.name).join(", ")}.`);
    this.name = "WorkflowNotFoundError";
  }
}

/** The catalog entry for `name` (valid or not). Throws WorkflowNotFoundError. */
export function findWorkflow(workspaceRoot: string, name: string): WorkflowEntry {
  const catalog = discoverWorkflows(workspaceRoot);
  const hits = catalog.entries.filter((e) => e.name === name);
  if (hits.length === 0) throw new WorkflowNotFoundError(name, catalog.entries.map((e) => e.name));
  return hits[0]!;
}

/** Validates any workspace file as a workflow definition (`/batch workflow validate --file`). Name/file mismatch is a warning here. */
export function validateWorkflowFile(workspaceRoot: string, raw: string, config: BatchConfig): WorkflowEntry {
  const resolved = resolveWorkspaceInput(workspaceRoot, raw, config, { what: "workflow file", maxBytes: MAX_WORKFLOW_BYTES });
  if (!resolved.ok) return { name: raw, file: raw, origin: "project", valid: false, warnings: [], diagnostics: [{ file: raw, path: "", message: resolved.message }] };
  const stem = path.basename(resolved.relPath).replace(/\.ya?ml$/i, "");
  return entryFromBytes(fs.readFileSync(resolved.absPath), resolved.relPath, { expectedName: stem, nameMustMatch: false });
}

export function formatDiagnostics(list: readonly Diagnostic[]): string {
  return list.map((x) => `  ${x.file}${x.path ? ` [${x.path}]` : ""}: ${x.message}`).join("\n");
}
