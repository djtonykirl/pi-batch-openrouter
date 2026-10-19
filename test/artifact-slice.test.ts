import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import { sha256Hex } from "../src/fsutil.js";
import { REPORT_TEMPLATE, SYNTHESIS_TEXT, FakeOpenRouter, artifactWorkspace, artifactsFor, makeService, readyJobWithSynthesis } from "./fixtures/artifacts.js";
import { rm } from "./helpers.js";

test("vertical slice: synthesis -> template -> Markdown -> PDF -> user edit -> PDF again, with honest provenance", async () => {
  const root = artifactWorkspace();
  try {
    const fake = new FakeOpenRouter();
    const service = makeService(root, fake);
    const { job, synthesis } = await readyJobWithSynthesis(service, fake);
    const art = artifactsFor(root, service);
    const requestsBefore = fake.requests.length;

    // 3. Markdown from the synthesis through the report template.
    const md = art.execute(await art.planFromJob(job.localId, { synthesis: true, template: "report", format: "markdown", out: "reports/report.md" }));
    const mdPath = path.join(root, "reports/report.md");
    const mdText = fs.readFileSync(mdPath, "utf8");
    assert.equal(mdText, "# Architecture review\n\n" + SYNTHESIS_TEXT.trimEnd() + "\n\n---\nGenerated from validated batch results.\n");

    // 4. Hashes and provenance.
    assert.equal(md.status, "rendered");
    assert.equal(md.format, "markdown");
    assert.match(md.artifactId, /^A-\d{8}-[0-9A-Z]{4}$/);
    assert.deepEqual([md.source.type, md.source.state, md.source.jobId, md.source.synthesisJobId], ["synthesis", "batch-generated", job.localId, synthesis.localId]);
    assert.equal(md.source.sha256, sha256Hex(fs.readFileSync(path.join(root, md.source.files[0]!))));
    assert.equal(md.template!.name, "report");
    assert.equal(md.template!.sha256, sha256Hex(REPORT_TEMPLATE));
    assert.equal(md.output!.path, "reports/report.md");
    assert.equal(md.output!.sha256, sha256Hex(fs.readFileSync(mdPath)));
    assert.equal(md.intermediate!.sha256, md.output!.sha256);
    assert.equal(md.lineage.generation, 1);
    const stored = art.store.read(md.artifactId);
    assert.deepEqual(stored, md);
    assert.equal(fs.readFileSync(path.join(art.store.dir(md.artifactId), "template.yaml"), "utf8"), REPORT_TEMPLATE);
    // Containment and overwrite refusal; nothing changes on refusal.
    await assert.rejects(art.planFromJob(job.localId, { synthesis: true, template: "report", format: "markdown", out: "../outside.md" }), /outside the workspace/);
    await assert.rejects(art.planFromJob(job.localId, { synthesis: true, template: "report", format: "markdown", out: "reports/report.md" }), /already exists\. Nothing was written/);
    assert.equal(fs.readFileSync(mdPath, "utf8"), mdText);
    assert.deepEqual(fs.readdirSync(path.join(root, "reports")), ["report.md"]); // atomic: no temp files left

    // 5-6. Pi-curated route: render the generated Markdown to PDF.
    const pdf1 = art.execute(await art.planFromFile("reports/report.md", { format: "pdf", out: "reports/report.pdf" }));
    const pdfBytes = fs.readFileSync(path.join(root, "reports/report.pdf"));
    assert.equal(pdfBytes.subarray(0, 5).toString("latin1"), "%PDF-");
    assert.equal(pdf1.output!.sha256, sha256Hex(pdfBytes));
    assert.equal((await PDFDocument.load(pdfBytes)).getPageCount(), pdf1.output!.pages);
    assert.deepEqual([pdf1.source.type, pdf1.source.state, pdf1.lineage.derivedFromArtifactId, pdf1.lineage.originJobId], ["local-source-file", "unmodified-generated-output", md.artifactId, job.localId]);
    assert.equal(pdf1.source.sha256, md.output!.sha256);

    // 7-9. A user/Pi edit, rendered under a new name: provenance points at the EDITED source.
    fs.writeFileSync(mdPath, mdText.replace("Open question:", "Reviewed by a human. Open question:"));
    const pdf2 = art.execute(await art.planFromFile("reports/report.md", { format: "pdf", out: "reports/report-reviewed.pdf" }));
    assert.equal(pdf2.source.state, "modified-after-generation");
    assert.equal(pdf2.source.sha256, sha256Hex(fs.readFileSync(mdPath)));
    assert.notEqual(pdf2.source.sha256, md.output!.sha256);
    assert.equal(pdf2.lineage.originOutputSha256, md.output!.sha256);
    assert.equal(pdf2.lineage.derivedFromArtifactId, md.artifactId);
    assert.equal(pdf2.lineage.originJobId, job.localId);
    assert.notEqual(pdf2.output!.sha256, pdf1.output!.sha256);
    // No model or OpenRouter call was made by any artifact step.
    assert.equal(fake.requests.length, requestsBefore);
    assert.equal(art.list({ jobId: job.localId }).length, 3);
  } finally {
    rm(root);
  }
});
