/**
 * Minimal field templates for project workflows: `{{field}}` (optionally
 * `{{ field }}`) and nothing else. No expressions, filters, loops, functions,
 * property traversal (`a.b`), environment variables or escapes.
 *
 * Every `{{` must open a valid field reference: anything else is a validation
 * error, so a typo can never silently send literal braces or an empty value.
 * A lone `}}` is plain text (prompts may contain JSON examples such as `{"a": {"b": 1}}`).
 * Rendering is a single left-to-right pass over the TEMPLATE; substituted values
 * are inserted verbatim and never scanned again, so braces in source data stay data.
 */

/** Field names usable in templates and `input.fields` (also the CSV header / JSONL key). */
export const FIELD_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

const REFERENCE = /\{\{\s*([A-Za-z_][A-Za-z0-9_-]{0,63})\s*\}\}/y;

export interface TemplatePart {
  kind: "text" | "field";
  value: string;
}

export interface ParsedTemplate {
  parts: TemplatePart[];
  /** Referenced field names, unique, in first-use order. */
  fields: string[];
}

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

function lineColumn(text: string, index: number): string {
  const before = text.slice(0, index);
  const line = before.split("\n").length;
  const column = index - before.lastIndexOf("\n");
  return `line ${line}, column ${column}`;
}

/** Throws TemplateError on any `{{` that is not exactly a field reference. */
export function parseTemplate(template: string): ParsedTemplate {
  const parts: TemplatePart[] = [];
  const fields: string[] = [];
  let text = "";
  let i = 0;
  while (i < template.length) {
    if (template.startsWith("{{", i)) {
      REFERENCE.lastIndex = i;
      const m = REFERENCE.exec(template);
      if (!m) {
        const snippet = template.slice(i, i + 24).split("\n")[0];
        throw new TemplateError(
          `unsupported template syntax at ${lineColumn(template, i)}: ${JSON.stringify(snippet)}. ` +
            "Only {{field}} references are allowed (field names: letters, digits, _ and -; no expressions, filters or dots).",
        );
      }
      if (text) parts.push({ kind: "text", value: text });
      text = "";
      const name = m[1]!;
      parts.push({ kind: "field", value: name });
      if (!fields.includes(name)) fields.push(name);
      i += m[0].length;
      continue;
    }
    text += template[i];
    i++;
  }
  if (text) parts.push({ kind: "text", value: text });
  return { parts, fields };
}

/**
 * Substitutes values in one pass. A referenced field without a value throws:
 * missing values are never replaced with "".
 */
export function renderTemplate(parsed: ParsedTemplate, values: Readonly<Record<string, string>>): string {
  let out = "";
  for (const p of parsed.parts) {
    if (p.kind === "text") {
      out += p.value;
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(values, p.value)) throw new TemplateError(`no value for template field "${p.value}"`);
    out += values[p.value];
  }
  return out;
}
