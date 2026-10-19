import PDFDocument from "pdfkit";
import { Lexer, type Token, type Tokens } from "marked";

/**
 * Markdown -> PDF, laid out in-process by pdfkit (pure JavaScript; no browser,
 * no external program, no network). The model never produces PDF bytes: it
 * supplies text; this module decides every byte of the file.
 *
 * Supported Markdown: headings, paragraphs with bold/italic/inline code, links
 * (shown as text with the target in angle brackets; no active link annotations),
 * ordered/unordered and nested lists, code blocks, block quotes, horizontal rules
 * and tables (one line per row). Images are shown as "[image: alt]" and never
 * loaded. Raw HTML is shown as text.
 *
 * Fonts: the PDF standard fonts (Helvetica, Courier), which are not embedded and
 * cover the Windows-1252 (WinAnsi) character set. Other characters are replaced
 * by fixed ASCII equivalents (→ becomes ->) or "?", and the number replaced is
 * reported as a warning; nothing is dropped silently.
 *
 * Determinism: creation/modification dates in the PDF metadata are a fixed
 * constant, so the same Markdown gives byte-identical PDF output. The actual
 * render time is recorded in the artifact manifest instead.
 */

export const PDF_RENDERER = { name: "markdown-to-pdf", library: "pdfkit", version: "0.20.2" } as const;
const FIXED_DATE = new Date("2000-01-01T00:00:00Z");

const WINANSI_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");
const SUBSTITUTE: Record<string, string> = { "→": "->", "←": "<-", "⇒": "=>", "⇐": "<=", "↔": "<->", "≤": "<=", "≥": ">=", "≠": "!=", "✓": "[x]", "✔": "[x]", "✗": "[ ]", "✘": "[ ]", "‐": "-", "‑": "-", "−": "-", "′": "'", "″": '"', "​": "", "﻿": "" };

export interface PdfResult {
  bytes: Buffer;
  pages: number;
  warnings: string[];
}

export class PdfRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfRenderError";
  }
}

interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  mono?: boolean;
}

class Layout {
  public replaced = 0;
  private readonly left: number;
  private readonly width: number;

  constructor(private readonly doc: PDFKit.PDFDocument) {
    this.left = doc.page.margins.left;
    this.width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  }

  public safe(s: string): string {
    let out = "";
    for (const ch of s.replace(/\t/g, "    ").replace(/\r\n?/g, "\n")) {
      const cp = ch.codePointAt(0)!;
      if (ch === "\n" || (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) || WINANSI_EXTRA.has(ch)) out += ch;
      else if (ch in SUBSTITUTE) out += SUBSTITUTE[ch];
      else {
        out += "?";
        this.replaced++;
      }
    }
    return out;
  }

  private font(r: Run): string {
    if (r.mono) return "Courier";
    if (r.bold && r.italic) return "Helvetica-BoldOblique";
    if (r.bold) return "Helvetica-Bold";
    if (r.italic) return "Helvetica-Oblique";
    return "Helvetica";
  }

  private inline(tokens: Token[] | undefined, style: Omit<Run, "text"> = {}): Run[] {
    const out: Run[] = [];
    for (const t of tokens ?? []) {
      switch (t.type) {
        case "strong":
          out.push(...this.inline((t as Tokens.Strong).tokens, { ...style, bold: true }));
          break;
        case "em":
          out.push(...this.inline((t as Tokens.Em).tokens, { ...style, italic: true }));
          break;
        case "del":
          out.push(...this.inline((t as Tokens.Del).tokens, style));
          break;
        case "codespan":
          out.push({ ...style, mono: true, text: (t as Tokens.Codespan).text });
          break;
        case "br":
          out.push({ ...style, text: "\n" });
          break;
        case "link": {
          const l = t as Tokens.Link;
          const inner = this.inline(l.tokens, style);
          out.push(...inner);
          const shown = inner.map((r) => r.text).join("");
          if (l.href && l.href !== shown) out.push({ ...style, text: ` <${l.href}>` });
          break;
        }
        case "image":
          out.push({ ...style, italic: true, text: `[image: ${(t as Tokens.Image).text || "no description"}]` });
          break;
        case "text": {
          const tt = t as Tokens.Text;
          if (tt.tokens && tt.tokens.length) out.push(...this.inline(tt.tokens, style));
          else out.push({ ...style, text: decodeEntities(tt.text) });
          break;
        }
        case "escape":
          out.push({ ...style, text: (t as Tokens.Escape).text });
          break;
        default:
          out.push({ ...style, text: decodeEntities((t as { raw?: string }).raw ?? "") });
      }
    }
    return out;
  }

  private runs(runs: Run[], size: number, indent: number, color = "#000000"): void {
    const parts = runs.map((r) => ({ ...r, text: this.safe(r.text) })).filter((r) => r.text.length > 0);
    if (parts.length === 0) return;
    this.doc.fillColor(color);
    parts.forEach((r, i) => {
      this.doc.font(this.font(r)).fontSize(r.mono ? size - 1 : size);
      const opts = { width: this.width - indent, continued: i < parts.length - 1, lineGap: 2 };
      if (i === 0) this.doc.text(r.text, this.left + indent, undefined, opts);
      else this.doc.text(r.text, opts);
    });
  }

  public blocks(tokens: Token[], indent = 0, color = "#000000"): void {
    for (const t of tokens) {
      switch (t.type) {
        case "heading": {
          const h = t as Tokens.Heading;
          const size = [20, 16, 13.5, 12, 11, 10.5][h.depth - 1] ?? 10.5;
          this.doc.moveDown(0.4);
          this.runs(this.inline(h.tokens, { bold: true }), size, indent, color);
          this.doc.moveDown(0.3);
          break;
        }
        case "paragraph":
          this.runs(this.inline((t as Tokens.Paragraph).tokens), 10.5, indent, color);
          this.doc.moveDown(0.5);
          break;
        case "text": {
          const tt = t as Tokens.Text;
          this.runs(tt.tokens ? this.inline(tt.tokens) : [{ text: decodeEntities(tt.text) }], 10.5, indent, color);
          break;
        }
        case "list": {
          const l = t as Tokens.List;
          l.items.forEach((item, i) => {
            const marker = l.ordered ? `${(typeof l.start === "number" ? l.start : 1) + i}. ` : "• ";
            const [first, ...rest] = item.tokens;
            const firstRuns = first && (first.type === "text" || first.type === "paragraph") ? this.inline((first as Tokens.Text).tokens ?? [{ type: "text", raw: (first as Tokens.Text).text, text: (first as Tokens.Text).text } as Tokens.Text]) : [];
            this.runs([{ text: (item.task ? (item.checked ? "[x] " : "[ ] ") : "") + marker }, ...firstRuns], 10.5, indent + 12, color);
            const remaining = first && (first.type === "text" || first.type === "paragraph") ? rest : item.tokens;
            this.blocks(remaining, indent + 24, color);
          });
          this.doc.moveDown(0.4);
          break;
        }
        case "code":
          for (const line of (t as Tokens.Code).text.split("\n")) this.runs([{ mono: true, text: line.length ? line : " " }], 10, indent + 12, "#333333");
          this.doc.moveDown(0.5);
          break;
        case "blockquote":
          this.blocks((t as Tokens.Blockquote).tokens, indent + 14, "#444444");
          break;
        case "hr": {
          const y = this.doc.y + 4;
          this.doc.moveTo(this.left + indent, y).lineTo(this.left + this.width, y).strokeColor("#999999").stroke();
          this.doc.moveDown(0.8);
          break;
        }
        case "table": {
          const tb = t as Tokens.Table;
          const row = (cells: Tokens.TableCell[], bold: boolean): Run[] => cells.flatMap((c, i) => [...(i ? [{ text: "  |  " }] : []), ...this.inline(c.tokens, { bold })]);
          this.runs(row(tb.header, true), 10, indent, color);
          for (const r of tb.rows) this.runs(row(r, false), 10, indent, color);
          this.doc.moveDown(0.5);
          break;
        }
        case "html":
          this.runs([{ mono: true, text: (t as Tokens.HTML).text }], 10, indent, "#333333");
          this.doc.moveDown(0.3);
          break;
        case "space":
        case "def":
          break;
        default:
          this.runs([{ text: (t as { raw?: string }).raw ?? "" }], 10.5, indent, color);
      }
    }
  }
}

function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39);/g, (_m, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[e]!);
}

export function renderPdf(markdown: string, opts: { title: string; producer: string }): Promise<PdfResult> {
  return new Promise<PdfResult>((resolve, reject) => {
    let doc: PDFKit.PDFDocument;
    try {
      doc = new PDFDocument({
        size: "A4",
        margins: { top: 56, bottom: 56, left: 56, right: 56 },
        compress: true,
        bufferPages: false,
        info: { Title: opts.title, Producer: opts.producer, Creator: opts.producer, CreationDate: FIXED_DATE, ModDate: FIXED_DATE },
      });
    } catch (err) {
      reject(new PdfRenderError(`PDF renderer failed to start: ${(err as Error).message}`));
      return;
    }
    const chunks: Buffer[] = [];
    let pages = 1;
    doc.on("pageAdded", () => pages++);
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("error", (err: Error) => reject(new PdfRenderError(`PDF rendering failed: ${err.message}`)));
    doc.on("end", () => {
      const warnings = layout.replaced > 0 ? [`${layout.replaced} character(s) outside the PDF standard font character set (Windows-1252) were replaced with "?"`] : [];
      resolve({ bytes: Buffer.concat(chunks), pages, warnings });
    });
    const layout = new Layout(doc);
    try {
      layout.blocks(new Lexer({ gfm: true }).lex(markdown));
      doc.end();
    } catch (err) {
      reject(new PdfRenderError(`PDF rendering failed: ${(err as Error).message}`));
    }
  });
}

/**
 * Structural check of a complete PDF (not a full parser): header, end-of-file
 * marker, a startxref offset that points at a cross-reference table or stream,
 * a trailer/xref dictionary naming /Root, and at least one page object.
 */
export function validatePdf(bytes: Buffer): { ok: true; pages: number } | { ok: false; reason: string } {
  if (bytes.length < 64) return { ok: false, reason: "output is empty or too small to be a PDF" };
  if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") return { ok: false, reason: "missing %PDF- header" };
  const tail = bytes.subarray(Math.max(0, bytes.length - 1024)).toString("latin1");
  if (!/%%EOF\s*$/.test(tail)) return { ok: false, reason: "missing %%EOF marker (incomplete file)" };
  const sx = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(tail);
  if (!sx) return { ok: false, reason: "missing startxref" };
  const offset = Number(sx[1]);
  if (!Number.isSafeInteger(offset) || offset <= 0 || offset >= bytes.length) return { ok: false, reason: "startxref offset is outside the file" };
  const at = bytes.subarray(offset, offset + 32).toString("latin1");
  if (!/^(xref|\d+\s+\d+\s+obj)/.test(at)) return { ok: false, reason: "startxref does not point at a cross-reference section" };
  const text = bytes.toString("latin1");
  if (!/\/Root\s+\d+\s+\d+\s+R/.test(text)) return { ok: false, reason: "no /Root in the trailer" };
  const pages = (text.match(/\/Type\s*\/Page(?!s)\b/g) ?? []).length;
  if (pages < 1) return { ok: false, reason: "no page objects" };
  return { ok: true, pages };
}
