import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.js";
import { discoverWorkflows, findWorkflow, validateDefinitionText, validateWorkflowFile, WorkflowNotFoundError } from "../src/workflows/definition.js";
import { parseTemplate, renderTemplate, TemplateError } from "../src/workflows/template.js";
import { CLASSIFY_YAML } from "./fixtures/datasets.js";
import { rm, tempWorkspace, writeFiles } from "./helpers.js";

const v = (text: string, expectedName = "classify-tickets") => validateDefinitionText(text, "wf.yaml", { expectedName, nameMustMatch: true });
const problems = (text: string, expectedName?: string) => v(text, expectedName).diagnostics.map((d) => `${d.path}: ${d.message}`).join("\n");

// ------------------------------------------------------------------ schema

test("workflow: the reference definition is valid and resolves defaults deterministically", () => {
  const r = v(CLASSIFY_YAML);
  assert.deepEqual(r.diagnostics, []);
  assert.equal(r.definition!.input.delimiter, ",");
  assert.equal(r.definition!.synthesis.enabled, true);
  const minimal = CLASSIFY_YAML.replace(/synthesis:\n  enabled: true\n/, "").replace(/limits:[\s\S]*$/, "");
  const m = v(minimal);
  assert.deepEqual(m.diagnostics, []);
  assert.deepEqual(m.definition!.synthesis, { enabled: false });
  assert.deepEqual(m.definition!.limits, {});
});

test("workflow: schemaVersion is mandatory and unsupported versions are rejected", () => {
  assert.match(problems(CLASSIFY_YAML.replace("schemaVersion: 1\n", "")), /schemaVersion: required property is missing/);
  assert.match(problems(CLASSIFY_YAML.replace("schemaVersion: 1", "schemaVersion: 2")), /unsupported schemaVersion 2/);
  assert.match(problems(CLASSIFY_YAML.replace("schemaVersion: 1", 'schemaVersion: "1"')), /unsupported schemaVersion "1"/);
});

test("workflow: unknown properties are rejected with their path, at every level", () => {
  assert.match(problems(CLASSIFY_YAML + "hooks: []\n"), /^hooks: unknown property "hooks"/m);
  assert.match(problems(CLASSIFY_YAML.replace("  prompt: |", "  promt: x\n  prompt: |")), /request\.promt: unknown property "promt"/);
  assert.match(problems(CLASSIFY_YAML.replace("  idField: ticket_id", "  idField: ticket_id\n  command: rm -rf /")), /input\.command: unknown property/);
  assert.match(problems(CLASSIFY_YAML.replace("model:\n  default", "model:\n  temperature: 2\n  default")), /model\.temperature: unknown property/);
});

test("workflow: wrong types, enums and missing required properties are reported", () => {
  assert.match(problems(CLASSIFY_YAML.replace("type: csv", "type: xlsx")), /input\.type: must be one of "csv", "jsonl"/);
  assert.match(problems(CLASSIFY_YAML.replace("  type: json\n", "  type: yaml\n")), /output\.type: must be one of "markdown", "json"/);
  assert.match(problems(CLASSIFY_YAML.replace("  fields:\n    - title\n    - description\n", "")), /input\.fields: required property is missing/);
  assert.match(problems(CLASSIFY_YAML.replace("  maxRequests: 10", "  maxRequests: 0")), /limits\.maxRequests/);
  assert.match(problems(CLASSIFY_YAML.replace("  maxRequests: 10", "  maxRequests: 1.5")), /limits\.maxRequests: must be integer/);
  assert.match(problems(CLASSIFY_YAML.replace("name: classify-tickets", "name: Classify Tickets")), /^name: must match pattern/m);
});

test("workflow: unsafe YAML (aliases, custom tags, multiple documents, duplicate keys, __proto__) is rejected", () => {
  assert.match(problems(CLASSIFY_YAML.replace("description: Classify support tickets", "description: &d Classify\nx: *d")), /anchors and aliases are not supported/);
  assert.match(problems(CLASSIFY_YAML.replace("description: Classify support tickets", "description: !!js/function 'function(){}'")), /YAML TAG_RESOLVE_FAILED/);
  assert.match(problems(CLASSIFY_YAML + "---\nname: other\n"), /YAML MULTIPLE_DOCS/);
  assert.match(problems(CLASSIFY_YAML + "name: again\n"), /YAML DUPLICATE_KEY/);
  assert.match(problems(CLASSIFY_YAML + "__proto__: { polluted: true }\n"), /"__proto__" is not allowed/);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.match(problems("- just\n- a list\n"), /must be a YAML mapping/);
});

test("workflow: template fields must be exactly the selected fields; system prompt is literal", () => {
  assert.match(problems(CLASSIFY_YAML.replace("{{description}}", "{{body}}")), /references \{\{body\}\}, which is not listed in input\.fields/);
  assert.match(problems(CLASSIFY_YAML.replace("    - description\n", "    - description\n    - customer_email\n")), /field "customer_email" is selected but never used/);
  assert.match(problems(CLASSIFY_YAML.replace("{{title}}", "{{ title | upper }}")), /unsupported template syntax/);
  assert.match(problems(CLASSIFY_YAML.replace("  prompt: |", "  system: Use {{title}}\n  prompt: |")), /request\.system: the system prompt is literal text/);
});

test("workflow: output schema rules (json requires a compilable draft-07 object schema; markdown forbids one)", () => {
  assert.match(problems(CLASSIFY_YAML.replace(/  schema:[\s\S]*?(?=synthesis:)/, "")), /output\.schema: required when output\.type is json/);
  assert.match(problems(CLASSIFY_YAML.replace("  type: json\n", "  type: markdown\n")), /output\.schema: only allowed when output\.type is json/);
  assert.match(problems(CLASSIFY_YAML.replace("    type: object\n    additionalProperties", "    type: array\n    additionalProperties")), /output\.schema\.type must be "object"/);
  assert.match(problems(CLASSIFY_YAML.replace("category: { type: string", "category: { type: string, frobnicate: 1")), /not a usable JSON Schema: strict mode: unknown keyword: "frobnicate"/);
  assert.match(problems(CLASSIFY_YAML.replace("    type: object\n    additionalProperties", "    $ref: 'https://example.invalid/s.json'\n    type: object\n    additionalProperties")), /not a usable JSON Schema/);
  assert.match(problems(CLASSIFY_YAML.replace("rationale: { type: string }", "rationale: { type: string, format: email }")), /unknown format "email"/);
  assert.match(problems(CLASSIFY_YAML.replace("    type: object\n    additionalProperties", "    $schema: 'https://json-schema.org/draft/2020-12/schema'\n    type: object\n    additionalProperties")), /only JSON Schema draft-07 is/);
});

test("workflow: names are reserved for built-ins and must match the file name", () => {
  assert.match(problems(CLASSIFY_YAML.replace("name: classify-tickets", "name: map-files"), "map-files"), /built-in workflow name/);
  assert.match(problems(CLASSIFY_YAML, "other-name"), /does not match the file name "other-name"/);
});

// --------------------------------------------------------------- discovery

test("discovery: deterministic order, duplicates rejected, invalid files reported (never thrown), non-YAML ignored", () => {
  const root = tempWorkspace();
  try {
    writeFiles(root, {
      ".pi/batch-workflows/zeta.yml": CLASSIFY_YAML.replace("name: classify-tickets", "name: zeta"),
      ".pi/batch-workflows/classify-tickets.yaml": CLASSIFY_YAML,
      ".pi/batch-workflows/classify-tickets.yml": CLASSIFY_YAML,
      ".pi/batch-workflows/broken.yaml": "schemaVersion: 1\nname: broken\n",
      ".pi/batch-workflows/README.md": "# notes",
      ".pi/batch-workflows/sub/nested.yaml": CLASSIFY_YAML.replace("name: classify-tickets", "name: nested"),
    });
    const c1 = discoverWorkflows(root);
    const c2 = discoverWorkflows(root);
    assert.deepEqual(c1.entries.map((e) => e.file), c2.entries.map((e) => e.file));
    assert.deepEqual(c1.entries.map((e) => [e.name, e.valid]), [
      ["broken", false],
      ["classify-tickets", false],
      ["classify-tickets", false],
      ["zeta", true],
    ]);
    assert.match(c1.entries[1]!.diagnostics.map((d) => d.message).join(), /duplicate workflow name "classify-tickets": also defined by \.pi\/batch-workflows\/classify-tickets\.yml/);
    assert.throws(() => findWorkflow(root, "nested"), WorkflowNotFoundError);
    assert.throws(() => findWorkflow(root, "../../etc/passwd"), WorkflowNotFoundError);
  } finally {
    rm(root);
  }
});

test("validate --file: workspace containment, hard-deny and name mismatch as a warning", () => {
  const root = tempWorkspace();
  const outside = tempWorkspace("pi batch outside-");
  try {
    writeFiles(root, { "drafts/draft.yaml": CLASSIFY_YAML });
    writeFiles(outside, { "wf.yaml": CLASSIFY_YAML });
    const ok = validateWorkflowFile(root, "drafts/draft.yaml", DEFAULT_CONFIG);
    assert.equal(ok.valid, true);
    assert.match(ok.warnings[0]!.message, /does not match the file name "draft"/);
    const rel = path.relative(root, path.join(outside, "wf.yaml"));
    assert.match(validateWorkflowFile(root, rel, DEFAULT_CONFIG).diagnostics[0]!.message, /outside the workspace/);
    assert.match(validateWorkflowFile(root, path.join(outside, "wf.yaml"), DEFAULT_CONFIG).diagnostics[0]!.message, /outside the workspace/);
    writeFiles(root, { ".env": "schemaVersion: 1\n" });
    assert.match(validateWorkflowFile(root, ".env", DEFAULT_CONFIG).diagnostics[0]!.message, /hard-deny/);
    fs.writeFileSync(path.join(root, "bin.yaml"), Buffer.from([0xff, 0xfe, 0x00, 0x41]));
    assert.match(validateWorkflowFile(root, "bin.yaml", DEFAULT_CONFIG).diagnostics[0]!.message, /not valid UTF-8/);
  } finally {
    rm(root);
    rm(outside);
  }
});

// ---------------------------------------------------------------- template

test("template: valid references, whitespace, repeated fields, JSON braces stay text", () => {
  const t = parseTemplate('A {{a}} B {{ b }} again {{a}} json {"x": {"y": 1}}');
  assert.deepEqual(t.fields, ["a", "b"]);
  assert.equal(renderTemplate(t, { a: "1", b: "2" }), 'A 1 B 2 again 1 json {"x": {"y": 1}}');
});

test("template: missing values fail, never become empty", () => {
  const t = parseTemplate("{{a}} {{b}}");
  assert.throws(() => renderTemplate(t, { a: "x" }), /no value for template field "b"/);
  assert.equal(renderTemplate(t, { a: "", b: "" }), " "); // an empty value that IS present is data
});

test("template: braces and template-like text in values are inserted once and never re-evaluated", () => {
  const t = parseTemplate("[{{a}}] [{{b}}]");
  assert.equal(renderTemplate(t, { a: "{{b}}", b: "${HOME} $(whoami) `id` {{constructor}}" }), "[{{b}}] [${HOME} $(whoami) `id` {{constructor}}]");
});

test("template: expressions, filters, traversal, helpers, env and code are all rejected", () => {
  for (const bad of ["{{a.b}}", "{{a | upper}}", "{{#each rows}}", "{{> partial}}", "{{process.env.KEY}}", "{{ a + b }}", "{{a()}}", "{{}}", "{{ }}", "{{a", "{{{a}}}", "{{constructor.constructor('x')()}}", "${a}"].slice(0, 12)) {
    assert.throws(() => parseTemplate(bad), TemplateError, bad);
  }
  // `${a}` is not template syntax at all: it stays literal text.
  assert.deepEqual(parseTemplate("${a}").fields, []);
});
