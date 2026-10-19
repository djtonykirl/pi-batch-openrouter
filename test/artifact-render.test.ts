import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import { extensionProblem } from "../src/artifacts/formats.js";
import { escapeHtml, renderHtml, safeHref } from "../src/artifacts/render-html.js";
import { renderPdf, validatePdf } from "../src/artifacts/render-pdf.js";
import { applyTemplate, discoverTemplates, formatValue } from "../src/artifacts/templates.js";
import { sha256Hex } from "../src/fsutil.js";
import { TemplateError } from "../src/workflows/template.js";
import { FINDINGS_TEMPLATE, REPORT_TEMPLATE } from "./fixtures/artifact-templates.js";
import { rm, tempWorkspace, writeFiles } from "./helpers.js";

const FINDINGS = {
  title: "Payments review",
  executiveSummary: "Two material risks.\nBoth are fixable.",
  findings: ["Retries are unbounded", "No idempotency key on {{title}}"],
  risks: [
    { risk: "Double charge", severity: "high" },
    { risk: "Log noise", severity: "low" },
  ],
  openQuestions: ["Who owns the gateway?"],
};

test("templates: discovery, validation of fields against the schema, unknown directives, and hashes", () => {
  const root = tempWorkspace();
  try {
    writeFiles(root, {
      ".pi/artifact-templates/report.yaml": REPORT_TEMPLATE,
      ".pi/artifact-templates/findings-report.yaml": FINDINGS_TEMPLATE,
      ".pi/artifact-templates/bad-field.yaml": FINDINGS_TEMPLATE.replace("name: findings-report", "name: bad-field").replace("{{title}}", "{{author}}"),
      ".pi/artifact-templates/optional.yaml": FINDINGS_TEMPLATE.replace("name: findings-report", "name: optional").replace("required: [title, executiveSummary, findings, risks, openQuestions]", "required: [executiveSummary, findings, risks, openQuestions]"),
      ".pi/artifact-templates/directive.yaml": REPORT_TEMPLATE.replace("name: report", "name: directive").replace("{{content}}", "{{#each content}}"),
      ".pi/artifact-templates/text-field.yaml": REPORT_TEMPLATE.replace("name: text-field", "name: text-field").replace("name: report", "name: text-field").replace("{{content}}", "{{title}}"),
      ".pi/artifact-templates/script.yaml": "schemaVersion: 1\nname: script\ninput: {type: text}\nbody: '{{content}}'\nexec: rm -rf /\n",
      ".pi/artifact-templates/mismatch.yaml": REPORT_TEMPLATE,
    });
    const byName = Object.fromEntries(discoverTemplates(root).map((t) => [t.file.split("/").pop(), t]));
    assert.equal(byName["report.yaml"]!.valid, true);
    assert.equal(byName["report.yaml"]!.sha256, sha256Hex(REPORT_TEMPLATE));
    assert.equal(byName["findings-report.yaml"]!.valid, true);
    const msg = (f: string) => byName[f]!.diagnostics.map((d: { path: string; message: string }) => `${d.path}: ${d.message}`).join("\n");
    assert.match(msg("bad-field.yaml"), /\{\{author\}\} is not a property of input\.schema/);
    assert.match(msg("optional.yaml"), /\{\{title\}\} must be listed in input\.schema\.required/);
    assert.match(msg("directive.yaml"), /unsupported template syntax/);
    assert.match(msg("text-field.yaml"), /text templates only support \{\{content\}\}/);
    assert.match(msg("script.yaml"), /unknown property "exec"/);
    assert.match(msg("mismatch.yaml"), /does not match the file name "mismatch"/);
  } finally {
    rm(root);
  }
});

test("templates: structured values become deterministic Markdown; template-like source text stays literal; nothing is evaluated", () => {
  const t = discoverTemplates(artifactWorkspaceForTemplates()).find((x) => x.name === "findings-report")!.template!;
  const r1 = applyTemplate(t, { kind: "json", data: FINDINGS });
  const r2 = applyTemplate(t, { kind: "json", data: JSON.parse(JSON.stringify(FINDINGS)) });
  assert.equal(r1.markdown, r2.markdown);
  assert.equal(r1.inputSha256, r2.inputSha256);
  assert.match(r1.markdown, /^# Payments review\n/);
  assert.match(r1.markdown, /- Retries are unbounded\n- No idempotency key on \{\{title\}\}\n/);
  assert.match(r1.markdown, /- \*\*risk:\*\* Double charge; \*\*severity:\*\* high/);
  assert.equal(formatValue({ a: "x\ny" }, "o"), "- **a:** x\n  y");
  assert.throws(() => formatValue([["nested"]], "f"), /f\[0\] is a nested list/);
  assert.throws(() => formatValue({ a: null }, "f"), /f\.a is null/);
  // Invalid structured data fails clearly and renders nothing.
  assert.throws(() => applyTemplate(t, { kind: "json", data: { ...FINDINGS, risks: [{ risk: "x", severity: "catastrophic" }] } }), (e: Error) => e instanceof TemplateError && /does not satisfy .* input schema; nothing was rendered/.test(e.message) && /\/risks\/0\/severity/.test(e.message));
  const { title: _t, ...missing } = FINDINGS;
  assert.throws(() => applyTemplate(t, { kind: "json", data: missing }), /must have required property 'title'/);
  assert.throws(() => applyTemplate(t, { kind: "text", text: "x" }), /expects json input/);
  const text = discoverTemplates(artifactWorkspaceForTemplates()).find((x) => x.name === "report")!.template!;
  assert.match(applyTemplate(text, { kind: "text", text: "${HOME} $(whoami) {{content}} <script>" }).markdown, /\$\{HOME\} \$\(whoami\) \{\{content\}\} <script>/);
});

let templatesRoot: string | undefined;
function artifactWorkspaceForTemplates(): string {
  if (!templatesRoot) {
    templatesRoot = tempWorkspace("pi batch tpl-");
    writeFiles(templatesRoot, { ".pi/artifact-templates/report.yaml": REPORT_TEMPLATE, ".pi/artifact-templates/findings-report.yaml": FINDINGS_TEMPLATE });
  }
  return templatesRoot;
}
test.after(() => {
  if (templatesRoot) rm(templatesRoot);
});

test("HTML: raw HTML escaped, no scripts or handlers, images not loaded, unsafe links neutralised, CSP present", () => {
  const md = [
    "# Title <b>x</b>",
    "",
    "Text <script>alert(1)</script> and <img src=x onerror=alert(2)>.",
    "",
    "<div onclick=\"steal()\">block html</div>",
    "",
    "![logo](https://tracker.invalid/p.png) [ok](https://example.invalid/a) [bad](javascript:alert(3)) [data](data:text/html,x) [rel](docs/a.md) [enc](&#106;avascript&#58;x) [proto](//evil.invalid/x)",
    "",
    "```html\n<script>code sample</script>\n```",
  ].join("\n");
  const html = renderHtml(md, { title: "T <x>", generator: "test" });
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<img/i);
  assert.doesNotMatch(html, /<div onclick/i);
  assert.doesNotMatch(html, /<[a-z][^>]*\son\w+=/i); // no real tag carries an event handler (escaped text may mention one)
  assert.match(html, /<a href="&amp;#106;avascript&amp;#58;x"/); // entity-encoded scheme stays literal text, never decoded
  assert.doesNotMatch(html, /href="(javascript|data|\/\/)/i);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /\[image: logo\]/);
  assert.match(html, /<a href="https:\/\/example\.invalid\/a" rel="noopener noreferrer">ok<\/a>/);
  assert.match(html, /<a href="docs\/a\.md" rel="noopener noreferrer">rel<\/a>/);
  assert.match(html, /Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'/);
  assert.match(html, /<title>T &lt;x&gt;<\/title>/);
  assert.doesNotMatch(html, /https?:\/\/[^"\s]*\.(js|css)/); // nothing remote to load
  assert.equal(renderHtml(md, { title: "T", generator: "g" }), renderHtml(md, { title: "T", generator: "g" }));
  assert.equal(safeHref("JAVASCRIPT:x"), undefined);
  assert.equal(safeHref("mailto:a@b.invalid"), "mailto:a@b.invalid");
  assert.equal(escapeHtml(`"'<>&`), "&quot;&#39;&lt;&gt;&amp;");
});

test("PDF: valid structure, independent parse, deterministic bytes, character replacement reported", async () => {
  const md = "# Report\n\nParagraph with **bold**, *italic*, `code` and [a link](https://example.invalid).\n\n- one\n  - nested\n1. first\n\n> quote\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```\nline 1\nline 2\n```\n\n---\n\n" + "Long paragraph. ".repeat(600) + "\n\nArrows → ✓ 日本 “quotes” – € …\n";
  const a = await renderPdf(md, { title: "Report", producer: "test" });
  const b = await renderPdf(md, { title: "Report", producer: "test" });
  assert.equal(sha256Hex(a.bytes), sha256Hex(b.bytes));
  const v = validatePdf(a.bytes);
  assert.ok(v.ok);
  assert.ok(a.pages >= 2);
  const doc = await PDFDocument.load(a.bytes);
  assert.equal(doc.getPageCount(), a.pages);
  assert.equal(doc.getTitle(), "Report");
  assert.match(a.warnings.join(), /2 character\(s\) outside the PDF standard font character set/);
  assert.equal(validatePdf(Buffer.from("not a pdf at all, definitely longer than sixty four bytes of text......")).ok, false);
  assert.match(String((validatePdf(a.bytes.subarray(0, a.bytes.length - 200)) as { reason: string }).reason), /EOF|startxref|cross-reference/);
  assert.match(String((validatePdf(Buffer.concat([Buffer.from("%PDF-1.3\n"), Buffer.alloc(100, 32), Buffer.from("\nstartxref\n5\n%%EOF\n")])) as { reason: string }).reason), /cross-reference/);
});

test("formats: extension allowlist", () => {
  assert.equal(extensionProblem("text", "a/b.sql"), undefined);
  assert.equal(extensionProblem("text", "a/b.yaml"), undefined);
  for (const bad of ["x.ps1", "x.bat", "x.cmd", "x.exe", "x.dll", "x.com", "x.msi", "x.js", "x.py", "x.docm"]) assert.match(String(extensionProblem("text", bad)), /executable/, bad);
  assert.match(String(extensionProblem("text", "x.html")), /not allowed for text/);
  assert.match(String(extensionProblem("pdf", "x.md")), /not allowed for pdf/);
});
