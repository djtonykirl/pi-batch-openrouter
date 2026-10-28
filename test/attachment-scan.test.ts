import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import { prepareAttachments } from "../src/attachments.js";
import { ChatBlockedError, ChatService } from "../src/chat/service.js";
import { ThreadStore } from "../src/chat/store.js";
import { FakeOpenRouter, accepted, makeConfig, makeService } from "./fixtures/fake-openrouter.js";
import { rm, tempWorkspace } from "./helpers.js";

const TINY_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

async function blankPdfB64(): Promise<string> {
  const doc = await PDFDocument.create();
  doc.addPage();
  return Buffer.from(await doc.save()).toString("base64");
}

function setup() {
  const root = tempWorkspace();
  const fake = new FakeOpenRouter();
  fake.submitReplies = [async () => accepted("batch_1")];
  const cfg = makeConfig();
  const batch = makeService(root, fake, cfg);
  const store = new ThreadStore(join(root, ".pi/batches/threads"));
  const chat = new ChatService({ store, batch, workspaceRoot: root, getConfig: () => cfg });
  return { root, fake, cfg, batch, store, chat };
}

test("U-I5: a text-mode PDF with no extractable text is blocked, never sent raw", async () => {
  const s = setup();
  try {
    const t = s.chat.newThread();
    await assert.rejects(
      s.chat.send(t.id, "read this", { uploads: [{ name: "scan.pdf", mimeType: "application/pdf", contentBase64: await blankPdfB64(), pdfMode: "text" }] }),
      (e: unknown) => e instanceof ChatBlockedError && /no extractable text/.test((e as Error).message) && /secret/.test((e as Error).message),
    );
    assert.equal(s.store.transcript(t.id).entries.length, 0);
    assert.equal(s.fake.accepted.length, 0);
  } finally {
    rm(s.root);
  }
});

test("U-I5: images and multimodal PDFs need an explicit per-file opt-in to be sent unscanned", async () => {
  const s = setup();
  try {
    const pdf = await blankPdfB64();
    const refused = await prepareAttachments({
      workspaceRoot: s.root,
      config: s.cfg,
      knownSecrets: [],
      input: {
        uploads: [
          { name: "a.png", mimeType: "image/png", contentBase64: TINY_PNG_B64 },
          { name: "b.pdf", mimeType: "application/pdf", contentBase64: pdf, pdfMode: "multimodal" },
        ],
      },
    });
    assert.equal(refused.parts.length, 0);
    assert.ok(refused.blockers.some((b) => /a\.png/.test(b) && /cannot be scanned for secrets/.test(b)));
    assert.ok(refused.blockers.some((b) => /b\.pdf/.test(b) && /cannot be scanned for secrets/.test(b)));

    const allowed = await prepareAttachments({
      workspaceRoot: s.root,
      config: s.cfg,
      knownSecrets: [],
      input: {
        uploads: [
          { name: "a.png", mimeType: "image/png", contentBase64: TINY_PNG_B64, allowUnscanned: true },
          { name: "b.pdf", mimeType: "application/pdf", contentBase64: pdf, pdfMode: "multimodal", allowUnscanned: true },
        ],
      },
    });
    assert.deepEqual(allowed.blockers, []);
    assert.equal(allowed.parts.length, 2);
    assert.ok(allowed.warnings.some((w) => /a\.png/.test(w) && /not scanned for secrets/.test(w)));
    assert.ok(allowed.warnings.some((w) => /b\.pdf/.test(w) && /not scanned for secrets/.test(w)));
  } finally {
    rm(s.root);
  }
});

test("U-I5: attachment warnings reach the chat result and the thread", async () => {
  const s = setup();
  try {
    const t = s.chat.newThread();
    const r = await s.chat.send(t.id, "what is in this picture?", { uploads: [{ name: "a.png", mimeType: "image/png", contentBase64: TINY_PNG_B64, allowUnscanned: true }] });
    assert.equal(r.queued, false);
    assert.ok(r.warnings?.some((w) => /not scanned for secrets/.test(w)));
    const status = s.store.transcript(t.id).entries.find((e) => e.type === "status");
    assert.ok(status && status.type === "status" && /not scanned for secrets/.test(status.text));
  } finally {
    rm(s.root);
  }
});
