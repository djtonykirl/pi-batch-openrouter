import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import { PDF_RENDERER } from "../src/artifacts/render-pdf.js";
import { HTML_RENDERER } from "../src/artifacts/render-html.js";
import { sha256Hex } from "../src/fsutil.js";
import type { BatchService } from "../src/service.js";
import { FINDINGS_TEMPLATE, REPORT_TEMPLATE, FakeOpenRouter, artifactWorkspace, artifactsFor, makeService, readyJobWithSynthesis } from "./fixtures/artifacts.js";
import { CLASSIFY_YAML } from "./fixtures/datasets.js";
import { FAKE_KEY, accepted } from "./fixtures/fake-openrouter.js";
import { completed, failedItem, successItem } from "./fixtures/openrouter.js";
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

const FINDINGS_WORKFLOW = CLASSIFY_YAML.replace("name: classify-tickets", "name: review-findings")
  .replace(/output:[\s\S]*?(?=synthesis:)/, `output:\n  type: json\n  schema:\n${FINDINGS_TEMPLATE.split("schema:\n")[1]!.split("body:")[0]!.replace(/^ {4}/gm, "    ")}`)
  .replace("synthesis:\n  enabled: true\n", "synthesis:\n  enabled: true\nartifact:\n  template: findings-report\n  format: pdf\n  filename: reports/findings.pdf\n");

async function withArtifacts(fn: (root: string, service: BatchService, fake: FakeOpenRouter) => Promise<void>, files: Record<string, string> = {}): Promise<void> {
  const root = artifactWorkspace(files);
  const fake = new FakeOpenRouter();
  try {
    await fn(root, makeService(root, fake), fake);
  } finally {
    rm(root);
  }
}

/** A ready dataset JSON job whose items carry structured findings objects. */
async function readyFindingsJob(service: BatchService, fake: FakeOpenRouter, rows: unknown[] = [FINDINGS, { ...FINDINGS, title: "Second" }, { ...FINDINGS, title: "Third" }]) {
  fake.submitReplies = [accepted("batch_f")];
  const job = await service.createDatasetJob(await service.planDataset({ workflow: "review-findings", input: "data/tickets.csv" }), { previewOnly: false });
  assert.equal(job.localStatus, "submitted", job.error?.message);
  fake.getReplies = [{ status: 200, body: completed(job.customIds.map((c, i) => successItem(c, JSON.stringify(rows[i]))), { id: "batch_f" }) }];
  await service.reconcile(job.localId, { force: true });
  return service.registry.read(job.localId);
}

const datasetFiles = { ".pi/batch-workflows/review-findings.yaml": FINDINGS_WORKFLOW, "data/tickets.csv": "ticket_id,title,description\r\nT-1,a,b\r\nT-2,c,d\r\nT-3,e,f\r\n" };

test(
  "PDF: renderer failure and invalid renderer output leave no file and no partial output",
  () =>
    withArtifacts(async (root, service, fake) => {
      const { job } = await readyJobWithSynthesis(service, fake);
      const failing = artifactsFor(root, service, undefined, { html: () => "", pdf: async () => Promise.reject(new Error("boom")) });
      await assert.rejects(failing.planFromJob(job.localId, { synthesis: true, format: "pdf", out: "reports/x.pdf" }), /PDF rendering failed; nothing was written: boom/);
      const garbage = artifactsFor(root, service, undefined, { html: () => "", pdf: async () => ({ bytes: Buffer.from("%PDF-1.4\n" + "x".repeat(200)), pages: 1, warnings: [] }) });
      await assert.rejects(garbage.planFromJob(job.localId, { synthesis: true, format: "pdf", out: "reports/x.pdf" }), /produced an invalid PDF \(missing %%EOF/);
      assert.ok(!fs.existsSync(path.join(root, "reports")));
      assert.equal(failing.list().length, 0); // nothing allocated when rendering fails
    }),
);

// ------------------------------------------------------------- end to end

test(
  "structured dataset item -> template -> Markdown/HTML/PDF; invalid structured data is refused; workflow default is used only on request",
  () =>
    withArtifacts(async (root, service, fake) => {
      const job = await readyFindingsJob(service, fake);
      assert.equal(job.localStatus, "ready", job.error?.message);
      const art = artifactsFor(root, service);
      const md = art.execute(await art.planFromJob(job.localId, { item: "T-1", template: "findings-report", format: "markdown", out: "reports/t1.md" }));
      assert.deepEqual([md.source.type, md.source.kind, md.source.sourceId, md.source.itemOrdinal], ["batch-item", "json", "T-1", 1]);
      assert.equal(md.source.sha256, sha256Hex(fs.readFileSync(service.registry.itemArtefact(job.localId, 1, "output"))));
      assert.match(fs.readFileSync(path.join(root, "reports/t1.md"), "utf8"), /^# Payments review\n[\s\S]*- No idempotency key on \{\{title\}\}/);
      const html = art.execute(await art.planFromJob(job.localId, { item: "2", template: "findings-report", format: "html", out: "reports/t2.html" }));
      assert.equal(html.renderer.library, HTML_RENDERER.library);
      assert.match(fs.readFileSync(path.join(root, "reports/t2.html"), "utf8"), /<h1>Second<\/h1>/);
      // No --format/--template/--out: the workflow's declared default (stored with the job) applies.
      const def = art.execute(await art.planFromJob(job.localId, { item: "T-3" }));
      assert.equal(def.format, "pdf");
      assert.equal(def.output!.path, "reports/findings.pdf");
      assert.equal(def.renderer.library, PDF_RENDERER.library);
      assert.equal((await PDFDocument.load(fs.readFileSync(path.join(root, "reports/findings.pdf")))).getPageCount() >= 1, true);
      // JSON without a template is refused for documents; as text it must go to .json.
      await assert.rejects(art.planFromJob(job.localId, { item: "1", format: "markdown", out: "reports/raw.md" }), /structured JSON: choose a template/);
      await assert.rejects(art.planFromJob(job.localId, { item: "1", format: "text", out: "reports/raw.txt" }), /only to a \.json file/);
      const asJson = art.execute(await art.planFromJob(job.localId, { item: "1", format: "text", out: "reports/raw.json" }));
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "reports/raw.json"), "utf8")), FINDINGS);
      assert.equal(asJson.renderer.name, "text-copy");
      // Whole-job structured source: {items:[…]} must satisfy the template, which expects one report.
      await assert.rejects(art.planFromJob(job.localId, { template: "findings-report", format: "markdown", out: "reports/all.md" }), /does not satisfy template findings-report's input schema/);
    }, datasetFiles),
);

test(
  "sources: unready and corrupt jobs refused; partial needs --allow-partial and records the gap; Release 1 single-request jobs work",
  () =>
    withArtifacts(async (root, service, fake) => {
      const art = artifactsFor(root, service);
      fake.submitReplies = [accepted("batch_p")];
      const job = await service.createWorkflowJob(await service.planMapFiles({ objective: "Review", files: ["src/a.ts", "src/b.ts"], contexts: [], format: "markdown", includeInstructions: true }), { previewOnly: false });
      await assert.rejects(art.planFromJob(job.localId, { format: "markdown" }), /is submitted; artifacts are only made from validated results/);
      fake.getReplies = [{ status: 200, body: completed([successItem(job.customIds[0]!, "A ok"), failedItem(job.customIds[1]!)], { id: "batch_p" }) }];
      await service.reconcile(job.localId, { force: true });
      await assert.rejects(art.planFromJob(job.localId, { format: "markdown" }), /1 of 2 item\(s\) have no usable result\. Pass --allow-partial/);
      await assert.rejects(art.planFromJob(job.localId, { item: "2", format: "markdown" }), /item 2 .* is failed; only a completed, validated item/);
      const partial = art.execute(await art.planFromJob(job.localId, { format: "markdown", allowPartial: true }));
      assert.deepEqual(partial.source.items, { included: 1, excluded: 1 });
      assert.match(partial.warnings.join(), /partial source: 1 item/);
      assert.equal(partial.output!.internal, true);
      assert.match(partial.output!.path, /^\.pi\/batches\/artifacts\/A-.+\/rendered\.md$/);
      await assert.rejects(art.planFromJob(job.localId, { synthesis: true, format: "markdown" }), /No synthesis exists/);
      // A Release 1 style single-request goal.
      fake.submitReplies = [accepted("batch_g")];
      const goal = await service.createJob(await service.prepare({ objective: "Goal", files: ["src/a.ts"], contexts: [], format: "markdown", includeInstructions: true }), { previewOnly: false });
      fake.getReplies = [{ status: 200, body: completed([successItem(goal.customIds[0]!, "Goal answer")], { id: "batch_g" }) }];
      await service.reconcile(goal.localId, { force: true });
      const g = art.execute(await art.planFromJob(goal.localId, { format: "html", out: "out/goal.html" }));
      assert.equal(g.source.type, "batch-result");
      assert.match(fs.readFileSync(path.join(root, "out/goal.html"), "utf8"), /Goal answer/);
    }),
);

// -------------------------------------------------------------------- paths

test(
  "paths: traversal, absolute, .pi/, executable and wrong extensions, symlink escape; overwrite records the replaced hash and generation",
  () =>
    withArtifacts(async (root, service, fake) => {
      const { job } = await readyJobWithSynthesis(service, fake);
      const art = artifactsFor(root, service);
      const plan = (out: string, extra: Record<string, unknown> = {}) => art.planFromJob(job.localId, { synthesis: true, format: "markdown", out, ...extra });
      for (const [out, why] of [
        ["../x.md", /outside the workspace/],
        [path.join(path.dirname(root), "abs.md"), /outside the workspace/],
        ["reports/../../x.md", /outside the workspace/],
        [".pi/batches/x.md", /inside \.pi\//],
        [".env.md", /hard-deny/],
        ["reports/run.ps1", /executable or scriptable/],
        ["reports/run.sh", /executable or scriptable/],
        ["reports/x.html", /\.html is not allowed for markdown/],
        ["reports/noext", /needs a file extension/],
      ] as const) {
        await assert.rejects(plan(out), why, out);
      }
      const outside = tempWorkspace("pi batch out-");
      try {
        let linked = true;
        try {
          fs.symlinkSync(outside, path.join(root, "link"), "junction");
        } catch {
          linked = false;
        }
        if (linked) {
          await assert.rejects(plan("link/x.md"), /resolves outside the workspace/);
          assert.deepEqual(fs.readdirSync(outside), []);
        }
      } finally {
        rm(outside);
      }
      const first = art.execute(await plan("reports/r.md"));
      const firstBytes = fs.readFileSync(path.join(root, "reports/r.md"));
      await assert.rejects(plan("reports/r.md"), /already exists/);
      fs.appendFileSync(path.join(root, "reports/r.md"), "\nhand edit\n");
      const edited = sha256Hex(fs.readFileSync(path.join(root, "reports/r.md")));
      const second = art.execute(await plan("reports/r.md", { overwrite: true }));
      assert.equal(second.replaced!.sha256, edited);
      assert.deepEqual([second.lineage.generation, second.lineage.previousArtifactId], [2, first.artifactId]);
      assert.deepEqual(fs.readFileSync(path.join(root, "reports/r.md")), firstBytes);
      assert.equal(art.store.read(first.artifactId).output!.sha256, sha256Hex(firstBytes)); // earlier provenance untouched
      assert.ok(art.store.events(second.artifactId).some((e) => e.eventType === "rendered"));
    }),
);

// ------------------------------------------------------- regeneration etc.

test(
  "regeneration: no OpenRouter call, same stored source gives byte-identical output; template edits do not change history",
  () =>
    withArtifacts(async (root, service, fake) => {
      const { job } = await readyJobWithSynthesis(service, fake);
      const art = artifactsFor(root, service);
      const before = fake.requests.length;
      const pdf = art.execute(await art.planFromJob(job.localId, { synthesis: true, template: "report", format: "pdf", out: "reports/a.pdf" }));
      fs.writeFileSync(path.join(root, ".pi/artifact-templates/report.yaml"), REPORT_TEMPLATE.replace("Architecture review", "Changed title"));
      const again = art.execute(await art.planRegenerate(pdf.artifactId, { out: "reports/b.pdf" }));
      assert.equal(again.output!.sha256, pdf.output!.sha256);
      assert.equal(again.lineage.regeneratedFromArtifactId, pdf.artifactId);
      assert.deepEqual(again.template, pdf.template); // the template that produced the stored source, not the edited file
      assert.deepEqual(again.source, pdf.source);
      const html = art.execute(await art.planRegenerate(pdf.artifactId, { format: "html", out: "reports/a.html" }));
      assert.match(fs.readFileSync(path.join(root, "reports/a.html"), "utf8"), /Architecture review/);
      assert.equal(html.format, "html");
      // A fresh render from the job now uses the edited template; the earlier artifact's record is unchanged.
      const fresh = art.execute(await art.planFromJob(job.localId, { synthesis: true, template: "report", format: "markdown", out: "reports/c.md" }));
      assert.notEqual(fresh.template!.sha256, pdf.template!.sha256);
      assert.equal(art.store.read(pdf.artifactId).template!.sha256, sha256Hex(REPORT_TEMPLATE));
      // Tampered stored source is refused.
      fs.appendFileSync(path.join(art.store.dir(pdf.artifactId), "source.md"), "tamper");
      await assert.rejects(art.planRegenerate(pdf.artifactId, {}), /no longer matches its recorded hash/);
      assert.equal(fake.requests.length, before);
    }),
);

test(
  "security: no API key in artifacts or manifests; local sources must be workspace Markdown and are checked like any input",
  () =>
    withArtifacts(async (root, service, fake) => {
      const { job } = await readyJobWithSynthesis(service, fake);
      const art = artifactsFor(root, service);
      art.execute(await art.planFromJob(job.localId, { synthesis: true, template: "report", format: "html", out: "reports/r.html" }));
      writeFiles(root, { "notes.txt": "x", ".env": "SECRET=abcdefgh123" });
      await assert.rejects(art.planFromFile("notes.txt", { format: "pdf" }), /takes a Markdown source/);
      await assert.rejects(art.planFromFile(".env", { format: "pdf" }), /hard-deny/);
      await assert.rejects(art.planFromFile("reports/r.html", { format: "markdown" }), /renders to --format html or --format pdf/);
      await assert.rejects(art.planFromFile("../x.md", { format: "pdf" }), /not found|outside/);
      for (const e of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
        if (e.isFile()) assert.ok(!fs.readFileSync(path.join(e.parentPath, e.name)).includes(FAKE_KEY), e.name);
      }
    }),
);

test("workflow artifact default: optional, validated, never changes the hash of workflows without it", async () => {
  const { validateDefinitionText, resolvedHash } = await import("../src/workflows/definition.js");
  const v = (text: string) => validateDefinitionText(text, "wf.yaml", { expectedName: "classify-tickets", nameMustMatch: true });
  const plain = v(CLASSIFY_YAML).definition!;
  assert.equal("artifact" in plain, false);
  assert.equal(resolvedHash(plain), "1107eb30b850bd3adf25b8932eee3f3c805c7c78821be49153111fc920ba6ca0"); // Release 3 value, unchanged
  const withArt = (a: string) => v(CLASSIFY_YAML + `artifact:\n${a}`);
  assert.deepEqual(withArt("  format: pdf\n  filename: reports/x.pdf\n").definition!.artifact, { format: "pdf", filename: "reports/x.pdf" });
  for (const bad of ["  format: pdf\n  filename: ../x.pdf\n", "  format: pdf\n  filename: C:/x.pdf\n", "  format: pdf\n  filename: /etc/x.pdf\n", "  format: docm\n  filename: x.docm\n", "  format: pdf\n  filename: x.pdf\n  command: open\n"]) {
    assert.ok(withArt(bad).diagnostics.length > 0, bad);
  }
});
