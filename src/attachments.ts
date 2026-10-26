import * as path from "node:path";
import * as zlib from "node:zlib";
import { PDFDocument } from "pdf-lib";
import type { BatchConfig } from "./config.js";
import { buildContextPackage, heading, isProbablyBinary } from "./context/package.js";
import { formatSecretFindings, scanForSecrets, type SecretFinding } from "./context/secrets.js";
import { sha256Hex } from "./fsutil.js";
import type { ChatContentPart } from "./openrouter/types.js";

/**
 * Unified attachment & file handling for Batch Chat and Batch Jobs.
 *
 * Supports four attachment capabilities:
 *   1. Workspace files & directories (via buildContextPackage: respects hard-deny,
 *      .pi/batchignore, .gitignore, size limits, and secret scanning).
 *   2. Uploaded text/code/CSV/JSON/Markdown files (UTF-8 validated & secret-scanned).
 *   3. PDF documents (local text extraction with FlateDecode stream parsing + secret
 *      scanning, OR multimodal base64 `file` content part for OpenRouter).
 *   4. Images (PNG, JPEG, WEBP, GIF validated & encoded as `image_url` content parts).
 */

export interface UploadedFileInput {
  name: string;
  mimeType?: string;
  /** Base64-encoded file bytes (used for binary files, PDFs, images, or arbitrary uploads). */
  contentBase64?: string;
  /** Direct UTF-8 text (optional convenience for text uploads). */
  text?: string;
  /** For PDFs: "text" extracts text locally (default); "multimodal" sends a base64 file part. */
  pdfMode?: "text" | "multimodal";
}

export interface AttachmentRequestInput {
  /** Workspace-relative file paths. */
  files?: string[];
  /** Workspace-relative directory (or file) context paths. */
  contexts?: string[];
  /** Browser/direct file uploads (text, code, CSV, JSON, PDF, images). */
  uploads?: UploadedFileInput[];
}

export interface ChatAttachmentMeta {
  source: "workspace" | "upload";
  kind: "text" | "pdf" | "image";
  name: string;
  /** Workspace-relative path when source === "workspace". */
  path?: string;
  mimeType?: string;
  bytes: number;
  sha256: string;
  characters?: number;
  mode?: "text" | "multimodal";
}

export interface PreparedAttachments {
  attachments: ChatAttachmentMeta[];
  /** Formatted text blocks to append to the user message for workspace/text/extracted-PDF files. */
  inlinedText: string;
  /** Multimodal parts (images and multimodal PDFs) for OpenRouter `/v1/chat/completions`. */
  parts: ChatContentPart[];
  /** Excluded files when expanding workspace context directories. */
  excludedCount: number;
  warnings: string[];
  blockers: string[];
  secretFindings: SecretFinding[];
}

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"]);
const MAX_IMAGE_BYTES = 5_000_000;
const MAX_PDF_BYTES = 10_000_000;

function sanitizeName(name: string): string {
  const base = path.basename(name.trim() || "attachment");
  return base.replace(/[\r\n\0]/g, "_").slice(0, 120) || "attachment";
}

function inferMimeType(name: string, provided?: string): string {
  const clean = (provided ?? "").split(";")[0]!.trim().toLowerCase();
  if (clean && clean !== "application/octet-stream") return clean;
  const ext = path.extname(name).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".pdf":
      return "application/pdf";
    case ".json":
      return "application/json";
    case ".csv":
      return "text/csv";
    case ".md":
    case ".markdown":
      return "text/markdown";
    default:
      return clean || "text/plain";
  }
}

export function isValidImageBuffer(buf: Buffer, mime: string): boolean {
  if (buf.length < 4) return false;
  if (mime === "image/png") {
    return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  }
  if (mime === "image/jpeg" || mime === "image/jpg") {
    return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  }
  if (mime === "image/gif") {
    const hdr = buf.subarray(0, 6).toString("ascii");
    return hdr === "GIF87a" || hdr === "GIF89a";
  }
  if (mime === "image/webp") {
    return buf.length >= 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP";
  }
  return false;
}

/**
 * Extracts readable text from a PDF buffer without external native binaries.
 * Decompresses FlateDecode streams and decodes literal `(text)` and hex `<hex>` strings
 * inside `BT ... ET` text blocks, plus document title/subject metadata via pdf-lib.
 */
export async function extractPdfText(buf: Buffer): Promise<{ ok: true; pages: number; text: string } | { ok: false; message: string }> {
  if (buf.length < 8 || !buf.subarray(0, 1024).toString("latin1").includes("%PDF-")) {
    return { ok: false, message: "not a valid PDF file (missing %PDF- header)" };
  }
  let pageCount = 0;
  const metaParts: string[] = [];
  try {
    const doc = await PDFDocument.load(buf, { ignoreEncryption: true, updateMetadata: false });
    pageCount = doc.getPageCount();
    const title = doc.getTitle();
    const subject = doc.getSubject();
    if (title) metaParts.push(`Title: ${title}`);
    if (subject) metaParts.push(`Subject: ${subject}`);
  } catch (err) {
    return { ok: false, message: `unreadable PDF structure: ${(err as Error).message}` };
  }

  const rawLatin1 = buf.toString("latin1");
  const streamChunks: string[] = [];
  const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match: RegExpExecArray | null;
  while ((match = streamRegex.exec(rawLatin1)) !== null) {
    const bodyLatin1 = match[1]!;
    const streamBuf = Buffer.from(bodyLatin1, "latin1");
    let decoded = bodyLatin1;
    try {
      decoded = zlib.inflateSync(streamBuf).toString("latin1");
    } catch {
      try {
        decoded = zlib.inflateRawSync(streamBuf).toString("latin1");
      } catch {
        // Keep raw stream text if not Flate-compressed
      }
    }
    if (decoded.includes("BT") && decoded.includes("ET")) {
      streamChunks.push(extractTextFromPdfContentStream(decoded));
    }
  }

  const bodyText = streamChunks
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
  const combined = [...metaParts, ...(bodyText ? [bodyText] : [])].join("\n\n").trim();
  return { ok: true, pages: pageCount, text: combined };
}

function decodePdfLiteralString(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = raw[++i];
    if (next === undefined) break;
    if (next === "n") out += "\n";
    else if (next === "r") out += "\r";
    else if (next === "t") out += "\t";
    else if (next === "b") out += "\b";
    else if (next === "f") out += "\f";
    else if (next === "(" || next === ")" || next === "\\") out += next;
    else if (next >= "0" && next <= "7") {
      let oct = next;
      if (raw[i + 1] && raw[i + 1]! >= "0" && raw[i + 1]! <= "7") oct += raw[++i]!;
      if (raw[i + 1] && raw[i + 1]! >= "0" && raw[i + 1]! <= "7") oct += raw[++i]!;
      out += String.fromCharCode(parseInt(oct, 8));
    } else {
      out += next;
    }
  }
  return out;
}

function decodePdfHexString(hex: string): string {
  const clean = hex.replace(/\s+/g, "");
  if (clean.length === 0) return "";
  const padded = clean.length % 2 === 1 ? clean + "0" : clean;
  const buf = Buffer.from(padded, "hex");
  // Handle UTF-16BE BOM if present
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    let out = "";
    for (let i = 2; i + 1 < buf.length; i += 2) {
      out += String.fromCharCode((buf[i]! << 8) | buf[i + 1]!);
    }
    return out;
  }
  return buf.toString("utf8");
}

function extractTextFromPdfContentStream(content: string): string {
  const lines: string[] = [];
  const btEtRegex = /BT\b([\s\S]*?)\bET/g;
  let blockMatch: RegExpExecArray | null;
  while ((blockMatch = btEtRegex.exec(content)) !== null) {
    const block = blockMatch[1]!;
    const tokens: string[] = [];
    // Match TJ arrays `[...] TJ`, literal strings `(...) Tj`, or hex strings `<...> Tj`
    const opRegex = /\[((?:[^[\]]|\((?:\\.|[^\\()])*\))*)\]\s*TJ|\(((?:\\.|[^\\()])*)\)\s*(?:Tj|'|")|<([0-9A-Fa-f\s]+)>\s*(?:Tj|'|")|\b(T\*|TD|Td)\b/g;
    let op: RegExpExecArray | null;
    while ((op = opRegex.exec(block)) !== null) {
      if (op[1] !== undefined) {
        const arr = op[1];
        const itemRegex = /\(((?:\\.|[^\\()])*)\)|<([0-9A-Fa-f\s]+)>/g;
        let item: RegExpExecArray | null;
        let run = "";
        while ((item = itemRegex.exec(arr)) !== null) {
          if (item[1] !== undefined) run += decodePdfLiteralString(item[1]);
          else if (item[2] !== undefined) run += decodePdfHexString(item[2]);
        }
        if (run) tokens.push(run);
      } else if (op[2] !== undefined) {
        tokens.push(decodePdfLiteralString(op[2]));
      } else if (op[3] !== undefined) {
        tokens.push(decodePdfHexString(op[3]));
      } else if (op[4] !== undefined) {
        tokens.push("\n");
      }
    }
    const text = tokens.join("").replace(/[ \t]+\n/g, "\n").trim();
    if (text) lines.push(text);
  }
  return lines.join("\n");
}

export function formatAttachedFileBlock(label: string, content: string): string {
  const clean = content.replace(/\r\n/g, "\n");
  const body = clean.endsWith("\n") ? clean.slice(0, -1) : clean;
  return [heading(`FILE: ${label}`), "", body, "", "END FILE"].join("\n");
}

export async function prepareAttachments(opts: {
  workspaceRoot: string;
  config: BatchConfig;
  knownSecrets: string[];
  input?: AttachmentRequestInput;
  gitIgnored?: (root: string, relPaths: string[]) => Set<string> | null;
}): Promise<PreparedAttachments> {
  const { workspaceRoot, config, knownSecrets, input } = opts;
  const files = input?.files ?? [];
  const contexts = input?.contexts ?? [];
  const uploads = input?.uploads ?? [];

  const attachments: ChatAttachmentMeta[] = [];
  const textBlocks: string[] = [];
  const parts: ChatContentPart[] = [];
  const warnings: string[] = [];
  const blockers: string[] = [];
  const secretFindings: SecretFinding[] = [];
  let excludedCount = 0;

  // 1. Workspace files & directories via buildContextPackage
  if (files.length > 0 || contexts.length > 0) {
    const pkg = buildContextPackage({
      workspaceRoot,
      objective: "attachment-check",
      files,
      contexts,
      includeInstructions: false,
      format: "markdown",
      config,
      knownSecrets,
      gitIgnored: opts.gitIgnored,
      renderPackage: false,
    });
    excludedCount += pkg.excluded.length;
    warnings.push(...pkg.warnings);
    for (const p of pkg.problems) blockers.push(p.message);
    secretFindings.push(...pkg.secretFindings);
    for (const f of pkg.files) {
      attachments.push({
        source: "workspace",
        kind: "text",
        name: path.posix.basename(f.relPath),
        path: f.relPath,
        bytes: f.bytes,
        sha256: f.sha256,
        characters: f.characters,
      });
      textBlocks.push(formatAttachedFileBlock(f.relPath, f.content));
    }
  }

  // 2. Browser / direct uploads (text/code/CSV/JSON, PDF, images)
  for (const up of uploads) {
    const name = sanitizeName(up.name);
    const mime = inferMimeType(name, up.mimeType);
    let buf: Buffer;
    try {
      if (up.contentBase64 !== undefined) {
        const cleanB64 = up.contentBase64.replace(/^data:[^;]+;base64,/, "");
        buf = Buffer.from(cleanB64, "base64");
      } else if (up.text !== undefined) {
        buf = Buffer.from(up.text, "utf8");
      } else {
        blockers.push(`Upload "${name}" is missing content`);
        continue;
      }
    } catch (err) {
      blockers.push(`Upload "${name}" could not be decoded: ${(err as Error).message}`);
      continue;
    }

    if (buf.length === 0) {
      blockers.push(`Upload "${name}" is empty (0 bytes)`);
      continue;
    }

    const sha256 = sha256Hex(buf);

    // 2a. Image attachment
    if (IMAGE_MIMES.has(mime)) {
      const normalizedMime = mime === "image/jpg" ? "image/jpeg" : mime;
      if (buf.length > MAX_IMAGE_BYTES) {
        blockers.push(`Image "${name}" is ${buf.length} bytes (limit ${MAX_IMAGE_BYTES})`);
        continue;
      }
      if (!isValidImageBuffer(buf, normalizedMime)) {
        blockers.push(`Image "${name}" does not match ${normalizedMime} header bytes`);
        continue;
      }
      const dataUrl = `data:${normalizedMime};base64,${buf.toString("base64")}`;
      attachments.push({
        source: "upload",
        kind: "image",
        name,
        mimeType: normalizedMime,
        bytes: buf.length,
        sha256,
        mode: "multimodal",
      });
      parts.push({ type: "image_url", image_url: { url: dataUrl } });
      continue;
    }

    // 2b. PDF attachment
    if (mime === "application/pdf" || name.toLowerCase().endsWith(".pdf")) {
      if (buf.length > MAX_PDF_BYTES) {
        blockers.push(`PDF "${name}" is ${buf.length} bytes (limit ${MAX_PDF_BYTES})`);
        continue;
      }
      const mode = up.pdfMode ?? "text";
      if (mode === "multimodal") {
        if (buf.length < 8 || !buf.subarray(0, 1024).toString("latin1").includes("%PDF-")) {
          blockers.push(`PDF "${name}" is not a valid PDF file (missing %PDF- header)`);
          continue;
        }
        const dataUrl = `data:application/pdf;base64,${buf.toString("base64")}`;
        attachments.push({
          source: "upload",
          kind: "pdf",
          name,
          mimeType: "application/pdf",
          bytes: buf.length,
          sha256,
          mode: "multimodal",
        });
        parts.push({ type: "file", file: { filename: name, file_data: dataUrl } });
        continue;
      }

      // Default mode === "text": extract text locally, scan for secrets, and inline
      const extracted = await extractPdfText(buf);
      if (!extracted.ok) {
        blockers.push(`PDF "${name}": ${extracted.message}`);
        continue;
      }
      if (!extracted.text) {
        // Fallback to multimodal file part if the PDF has no extractable text layer (e.g. scanned PDF)
        warnings.push(`PDF "${name}" had no extractable text layer; attached as a multimodal PDF file part`);
        const dataUrl = `data:application/pdf;base64,${buf.toString("base64")}`;
        attachments.push({
          source: "upload",
          kind: "pdf",
          name,
          mimeType: "application/pdf",
          bytes: buf.length,
          sha256,
          mode: "multimodal",
        });
        parts.push({ type: "file", file: { filename: name, file_data: dataUrl } });
        continue;
      }
      if (config.security.scanSecrets) {
        secretFindings.push(...scanForSecrets(extracted.text, name, knownSecrets));
      }
      attachments.push({
        source: "upload",
        kind: "pdf",
        name,
        mimeType: "application/pdf",
        bytes: buf.length,
        sha256,
        characters: extracted.text.length,
        mode: "text",
      });
      textBlocks.push(formatAttachedFileBlock(`${name} (PDF, ${extracted.pages} page(s))`, extracted.text));
      continue;
    }

    // 2c. Text / Code / CSV / JSON / Markdown upload
    if (buf.length > config.context.maxFileBytes) {
      blockers.push(`File "${name}" is ${buf.length} bytes (limit ${config.context.maxFileBytes})`);
      continue;
    }
    if (isProbablyBinary(buf)) {
      blockers.push(`File "${name}" is binary or not valid UTF-8; only text files, PDFs, and images (PNG/JPEG/WEBP/GIF) are supported`);
      continue;
    }
    let text = buf.toString("utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    text = text.replace(/\r\n/g, "\n");
    if (config.security.scanSecrets) {
      secretFindings.push(...scanForSecrets(text, name, knownSecrets));
    }
    attachments.push({
      source: "upload",
      kind: "text",
      name,
      mimeType: mime,
      bytes: buf.length,
      sha256,
      characters: text.length,
    });
    textBlocks.push(formatAttachedFileBlock(name, text));
  }

  if (secretFindings.length > 0 && config.security.blockOnSecret) {
    blockers.push(formatSecretFindings(secretFindings));
  }

  const inlinedText = textBlocks.join("\n\n");
  const totalChars = attachments.reduce((sum, a) => sum + (a.characters ?? 0), 0);
  if (totalChars > config.context.maxContextCharacters) {
    blockers.push(`Attached files total ${totalChars} characters (limit ${config.context.maxContextCharacters})`);
  }

  return {
    attachments,
    inlinedText,
    parts,
    excludedCount,
    warnings,
    blockers,
    secretFindings,
  };
}

export interface ExtractedResponseFile {
  index: number;
  kind: "code" | "image";
  language: string;
  suggestedPath: string;
  content: string;
  lines: number;
  bytes: number;
  mimeType?: string;
}

const LANG_EXTENSION_MAP: Record<string, string> = {
  ts: "ts",
  typescript: "ts",
  tsx: "tsx",
  js: "js",
  javascript: "js",
  jsx: "jsx",
  py: "py",
  python: "py",
  json: "json",
  jsonl: "jsonl",
  csv: "csv",
  html: "html",
  css: "css",
  md: "md",
  markdown: "md",
  yaml: "yaml",
  yml: " yaml",
  sql: "sql",
  sh: "sh",
  bash: "sh",
  ps1: "ps1",
  powershell: "ps1",
  rs: "rs",
  rust: "rs",
  go: "go",
  java: "java",
  c: "c",
  cpp: "cpp",
  xml: "xml",
  svg: "svg",
  toml: "toml",
};

function sanitizeSuggestedPath(raw: string): string | null {
  let cleaned = raw.trim().replace(/^['"`]+|['"`]+$/g, "").replace(/\\/g, "/");
  cleaned = cleaned.replace(/^(?:file|path|filename)\s*:\s*/i, "").trim();
  cleaned = cleaned.replace(/^\/+/, "");
  if (!cleaned || cleaned.includes("..") || /[\0<>:"|?*]/.test(cleaned)) return null;
  if (!/[./a-zA-Z0-9_-]/.test(cleaned)) return null;
  // Require either a file extension or a slash to look like a real filename/path
  if (!/\.[a-zA-Z0-9]{1,8}$/.test(cleaned)) return null;
  return cleaned;
}

/**
 * Parses fenced code/file blocks and embedded data-URI images from an LLM response
 * so users can copy, download, or save generated files directly to the workspace.
 */
export function extractResponseFiles(markdownText: string): ExtractedResponseFile[] {
  const results: ExtractedResponseFile[] = [];
  if (!markdownText) return results;

  const fenceRegex = /(?:^|\n)(?:(?:#{1,4}|\*\*|\/\/|<!--)\s*(?:FILE:\s*)?`?([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]{1,8})`?(?:\*\*|-->)?\s*\n)?```([^\n`]*)\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  let idx = 1;

  while ((match = fenceRegex.exec(markdownText)) !== null) {
    const precedingHint = match[1]?.trim() ?? "";
    const infoString = match[2]?.trim() ?? "";
    const body = match[3] ?? "";

    // Parse infoString: e.g. "ts:src/foo.ts", "python title=\"scripts/run.py\"", "json src/data.json"
    let language = "text";
    let suggested: string | null = null;

    if (infoString) {
      const tokens = infoString.split(/\s+/);
      const first = tokens[0] ?? "";
      if (first.includes(":")) {
        const [langPart, pathPart] = first.split(":", 2);
        if (langPart) language = langPart.toLowerCase();
        if (pathPart) suggested = sanitizeSuggestedPath(pathPart);
      } else {
        const asPath = sanitizeSuggestedPath(first);
        if (asPath && first.includes("/")) {
          suggested = asPath;
          const ext = path.extname(asPath).slice(1).toLowerCase();
          if (ext) language = ext;
        } else if (first) {
          language = first.toLowerCase();
        }
      }
      for (const tok of tokens.slice(1)) {
        const kv = /^(?:file|path|title)=(.+)$/i.exec(tok);
        const cand = sanitizeSuggestedPath(kv ? kv[1]! : tok);
        if (cand) {
          suggested = cand;
          break;
        }
      }
    }

    if (!suggested && precedingHint) {
      suggested = sanitizeSuggestedPath(precedingHint);
    }

    // Check first line of code block for a comment like `// FILE: src/app.ts` or `# src/script.py`
    if (!suggested) {
      const firstLine = body.split("\n", 1)[0]?.trim() ?? "";
      const commentMatch = /^(?:\/\/|#|--|<!--)\s*(?:file:\s*|path:\s*)?([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]{1,8})(?:\s*-->)?$/i.exec(firstLine);
      if (commentMatch?.[1]) {
        suggested = sanitizeSuggestedPath(commentMatch[1]);
      }
    }

    const ext = (LANG_EXTENSION_MAP[language] ?? "txt").trim();
    const finalPath = suggested ?? `output-${idx}.${ext}`;
    const lineCount = body ? body.replace(/\n$/, "").split("\n").length : 0;

    results.push({
      index: idx++,
      kind: "code",
      language,
      suggestedPath: finalPath,
      content: body,
      lines: lineCount,
      bytes: Buffer.byteLength(body, "utf8"),
    });
  }

  // Also detect embedded base64 data-URI images (`data:image/(png|jpeg|webp|gif);base64,...`)
  const imgRegex = /data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)/g;
  while ((match = imgRegex.exec(markdownText)) !== null) {
    const mimeType = match[1]!;
    const b64 = match[2]!;
    const ext = mimeType.split("/")[1] === "jpeg" ? "jpg" : mimeType.split("/")[1]!;
    results.push({
      index: idx++,
      kind: "image",
      language: ext,
      suggestedPath: `image-${idx - 1}.${ext}`,
      content: `data:${mimeType};base64,${b64}`,
      lines: 1,
      bytes: Math.floor((b64.length * 3) / 4),
      mimeType,
    });
  }

  return results;
}
