import assert from "node:assert/strict";
import test from "node:test";
import * as zlib from "node:zlib";
import { PDFDocument, PDFName } from "pdf-lib";
import { extractPdfText, extractTextFromPdfContentStream, pdfStreamBodies } from "../src/attachments.js";

test("U-I3: a pathological TJ array finishes quickly (no catastrophic backtracking)", () => {
  const started = Date.now();
  const out = extractTextFromPdfContentStream("BT [" + "(a)".repeat(40) + " ET");
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
  assert.equal(typeof out, "string");
  // Well-formed arrays still extract.
  assert.equal(extractTextFromPdfContentStream("BT [(Hel) -20 (lo)] TJ ET"), "Hello");
});

test("U-I3: unterminated stream and BT markers do not make extraction quadratic", () => {
  let started = Date.now();
  // Many "stream" keywords with no endstream after them.
  assert.deepEqual([...pdfStreamBodies("x stream\nA\nendstream " + "stream\n".repeat(200_000))], ["A"]);
  assert.ok(Date.now() - started < 1000, `stream scan took ${Date.now() - started} ms`);
  // An ET, then many BTs with no ET after them.
  started = Date.now();
  assert.equal(extractTextFromPdfContentStream("ET " + "BT ".repeat(200_000)), "");
  assert.ok(Date.now() - started < 1000, `BT/ET scan took ${Date.now() - started} ms`);
  // Normal blocks still work.
  assert.equal(extractTextFromPdfContentStream("BT (One) Tj ET BT (Two) Tj ET"), "One\nTwo");
});

test("U-I3: a PDF whose structure takes too long to parse is refused as could-not-extract", async () => {
  const doc = await PDFDocument.create();
  doc.addPage();
  const valid = Buffer.from(await doc.save({ useObjectStreams: false }));
  const slow = Buffer.concat([valid, Buffer.from("stream\n".repeat(100_000), "latin1")]);
  const started = Date.now();
  const r = await extractPdfText(slow, { structureTimeoutMs: 200 });
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.message, /could not extract/i);
});

test("U-I3: an oversized inflate (decompression bomb) is refused as could-not-extract", async () => {
  const doc = await PDFDocument.create();
  doc.addPage();
  const bomb = zlib.deflateSync(Buffer.alloc(64 * 1024 * 1024, 0x20));
  const stream = doc.context.stream(bomb, { Filter: PDFName.of("FlateDecode"), Length: bomb.length });
  doc.context.register(stream);
  const bytes = Buffer.from(await doc.save({ useObjectStreams: false }));
  const r = await extractPdfText(bytes);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.message, /could not extract/i);
});
