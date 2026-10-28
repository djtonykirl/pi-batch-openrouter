import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { prepareAttachments } from "../src/attachments.js";
import { FakeOpenRouter, makeConfig, makeService } from "./fixtures/fake-openrouter.js";
import { rm, tempWorkspace } from "./helpers.js";

async function textPdf(text: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([400, 200]).drawText(text, { x: 20, y: 100, size: 12, font });
  return Buffer.from(await doc.save());
}

async function workspaceWithPdf(text: string, rel = "docs/facility-note.pdf"): Promise<string> {
  const root = tempWorkspace("pi batch wspdf-");
  fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), await textPdf(text));
  return root;
}

test("2: a workspace PDF attachment yields extracted text and no binary blocker (case-insensitive .pdf)", async () => {
  for (const rel of ["docs/facility-note.pdf", "docs/Facility-Note.PDF"]) {
    const root = await workspaceWithPdf("Boiler room inspection due in March", rel);
    try {
      const prep = await prepareAttachments({ workspaceRoot: root, config: makeConfig(), knownSecrets: [], input: { files: [rel] }, gitIgnored: () => new Set() });
      assert.deepEqual(prep.blockers, []);
      assert.ok(!prep.blockers.some((b) => /binary/.test(b)));
      assert.match(prep.inlinedText, /Boiler room inspection due in March/);
      assert.match(prep.inlinedText, new RegExp(`FILE: ${rel.replace(".", "\\.")} \\(PDF, 1 page\\(s\\)\\)`));
      assert.equal(prep.attachments.length, 1);
      assert.deepEqual({ ...prep.attachments[0]!, sha256: "", bytes: 0, characters: 0 }, {
        source: "workspace",
        kind: "pdf",
        name: path.posix.basename(rel),
        path: rel,
        mimeType: "application/pdf",
        bytes: 0,
        sha256: "",
        characters: 0,
        mode: "text",
      });
      assert.deepEqual(prep.parts, [], "never sent as a raw file part");
    } finally {
      rm(root);
    }
  }
});

test("2: a workspace PDF keeps the exclusion rules, the secret scan and the size limit", async () => {
  const root = await workspaceWithPdf("token ghp_abcdefghijklmnopqrstuvwxyz0123456789 here");
  try {
    const cfg = makeConfig();
    const scanned = await prepareAttachments({ workspaceRoot: root, config: cfg, knownSecrets: [], input: { files: ["docs/facility-note.pdf"] }, gitIgnored: () => new Set() });
    assert.ok(scanned.secretFindings.length > 0, "the extracted text is scanned");
    assert.ok(scanned.blockers.some((b) => /secret/i.test(b)));

    fs.mkdirSync(path.join(root, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(root, ".pi", "batchignore"), "docs/\n");
    const ignored = await prepareAttachments({ workspaceRoot: root, config: cfg, knownSecrets: [], input: { files: ["docs/facility-note.pdf"] }, gitIgnored: () => new Set() });
    assert.match(ignored.blockers.join("\n"), /excluded by batchignore rule/);
    assert.equal(ignored.inlinedText, "");
    fs.rmSync(path.join(root, ".pi", "batchignore"));

    fs.writeFileSync(path.join(root, "docs", "huge.pdf"), Buffer.alloc(10_000_001, 0x20));
    const huge = await prepareAttachments({ workspaceRoot: root, config: cfg, knownSecrets: [], input: { files: ["docs/huge.pdf"] }, gitIgnored: () => new Set() });
    assert.match(huge.blockers.join("\n"), /PDF "docs\/huge.pdf" is 10000001 bytes \(limit 10000000\)/);

    // A directory expanded as context still leaves binaries out (no blocker, counted as excluded).
    fs.rmSync(path.join(root, "docs", "huge.pdf"));
    fs.writeFileSync(path.join(root, "docs", "readme.md"), "# notes\n");
    const ctx = await prepareAttachments({ workspaceRoot: root, config: cfg, knownSecrets: [], input: { contexts: ["docs"] }, gitIgnored: () => new Set() });
    assert.deepEqual(ctx.blockers, []);
    assert.deepEqual(ctx.attachments.map((a) => a.path), ["docs/readme.md"]);
    assert.equal(ctx.excludedCount, 1);
  } finally {
    rm(root);
  }
});

test("2: the job studio (ask) sends a selected workspace PDF as extracted text", async () => {
  const root = await workspaceWithPdf("Facility note: generator test every Friday");
  try {
    fs.writeFileSync(path.join(root, "notes.md"), "plain notes\n");
    const service = makeService(root, new FakeOpenRouter());
    const prepared = await service.prepare({ objective: "Summarise", files: ["notes.md", "docs/facility-note.pdf"], contexts: [], format: "markdown", includeInstructions: true });
    assert.deepEqual(prepared.blockers, []);
    const user = prepared.messages.at(-1)!;
    assert.match(user.content, /plain notes/);
    assert.match(user.content, /Facility note: generator test every Friday/);
    assert.equal(prepared.uploads?.[0]?.path, "docs/facility-note.pdf");
  } finally {
    rm(root);
  }
});
