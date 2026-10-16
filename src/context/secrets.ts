import { sha256Hex } from "../fsutil.js";

/**
 * High-confidence secret detection. Basic protection against ACCIDENTAL
 * leakage — not a DLP or compliance control.
 *
 * Findings never contain the matched value: only its type, location and a
 * short one-way fingerprint so false positives can be diagnosed (e.g. "is this
 * the same value as last time?") without exposing it.
 */

export interface SecretFinding {
  type: string;
  source: string;
  line: number;
  column: number;
  /** First 12 hex chars of SHA-256 of the matched value. Not reversible. */
  fingerprint: string;
}

interface Detector {
  type: string;
  regex: RegExp;
  /** Capture group holding the secret value; 0 = whole match. */
  group: number;
}

const DETECTORS: Detector[] = [
  { type: "private key block", regex: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g, group: 0 },
  { type: "AWS access key ID", regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, group: 0 },
  { type: "GitHub token", regex: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g, group: 0 },
  { type: "OpenRouter API key", regex: /\bsk-or-(?:v1-)?[A-Za-z0-9]{32,}\b/g, group: 0 },
  { type: "Anthropic API key", regex: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, group: 0 },
  { type: "OpenAI-style API key", regex: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}\b/g, group: 0 },
  { type: "Slack token", regex: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, group: 0 },
  { type: "Google API key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/g, group: 0 },
  { type: "bearer token", regex: /\bBearer\s+([A-Za-z0-9._~+/-]{20,}=*)/gi, group: 1 },
  {
    type: "client secret assignment",
    regex: /\bclient[_-]?secret\b["']?\s*[:=]\s*["']([^"'\s]{8,})["']/gi,
    group: 1,
  },
  {
    type: "API key assignment",
    regex: /\b(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|secret[_-]?key)\b["']?\s*[:=]\s*["']([^"'\s]{12,})["']/gi,
    group: 1,
  },
  {
    type: "password assignment",
    regex: /\b(?:password|passwd|pwd)\b["']?\s*[:=]\s*["']([^"'\s]{6,})["']/gi,
    group: 1,
  },
  {
    // KEY=value lines in env-style files (unquoted).
    type: "secret environment assignment",
    regex: /^[ \t]*(?:export[ \t]+)?[A-Z0-9_]*(?:SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|ACCESS_TOKEN|AUTH_TOKEN|PRIVATE_KEY)[A-Z0-9_]*[ \t]*=[ \t]*([^\s#'"]{8,})/gm,
    group: 1,
  },
  {
    type: "credential-bearing connection string",
    regex: /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@'"]+:([^\s@/'"]{3,})@[^\s'"]+/gi,
    group: 1,
  },
  { type: "connection string password", regex: /\b(?:Password|Pwd)\s*=\s*([^;'"\s]{4,})\s*;/gi, group: 1 },
  { type: "Azure storage account key", regex: /\bAccountKey=([A-Za-z0-9+/=]{40,})/g, group: 1 },
];

/** Values that are obviously placeholders or indirections, not secrets. */
const PLACEHOLDER =
  /^(?:x{3,}|\*{3,}|\.{3,}|<[^>]*>|\$\{[^}]*\}|\$[A-Z_][A-Z0-9_]*|%[A-Z_]+%|\{\{[^}]*\}\}|(?:your|my|example|sample|dummy|fake|test|placeholder|changeme|redacted|replace)[\w-]*|password|secret|none|null|undefined)$/i;

function isPlaceholder(value: string): boolean {
  if (PLACEHOLDER.test(value)) return true;
  return /process\.env|os\.environ|getenv|\$\{|\{\{/.test(value);
}

function lineAndColumn(text: string, index: number): { line: number; column: number } {
  let line = 1;
  let lastNl = -1;
  for (let i = 0; i < index; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lastNl = i;
    }
  }
  return { line, column: index - lastNl };
}

export function fingerprint(value: string): string {
  return sha256Hex(value).slice(0, 12);
}

/**
 * @param knownSecrets exact values that must never be submitted (e.g. the
 *   current OPENROUTER_API_KEY). Matched literally; values < 8 chars ignored.
 */
export function scanForSecrets(text: string, source: string, knownSecrets: readonly string[] = []): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const seen = new Set<string>();
  const push = (type: string, index: number, value: string) => {
    const pos = lineAndColumn(text, index);
    const key = `${pos.line}:${fingerprint(value)}`;
    if (seen.has(key)) return; // same value already reported on this line by a more specific detector
    seen.add(key);
    findings.push({ type, source, line: pos.line, column: pos.column, fingerprint: fingerprint(value) });
  };

  for (const secret of knownSecrets) {
    if (!secret || secret.length < 8) continue;
    let idx = text.indexOf(secret);
    while (idx !== -1) {
      push("configured API key value", idx, secret);
      idx = text.indexOf(secret, idx + secret.length);
    }
  }

  for (const d of DETECTORS) {
    d.regex.lastIndex = 0;
    for (const m of text.matchAll(d.regex)) {
      const value = m[d.group];
      if (!value) continue;
      if (d.group !== 0 && isPlaceholder(value)) continue;
      const index = (m.index ?? 0) + (d.group === 0 ? 0 : m[0].indexOf(value));
      push(d.type, index, value);
    }
  }
  return findings.sort((a, b) => a.source.localeCompare(b.source) || a.line - b.line || a.column - b.column);
}

export function formatSecretFindings(findings: readonly SecretFinding[]): string {
  const lines = ["Submission blocked", "", "Potential secret detected:"];
  for (const f of findings) {
    lines.push(`  File: ${f.source}`, `  Line: ${f.line}`, `  Type: ${f.type}`, `  Fingerprint: ${f.fingerprint}`, "");
  }
  lines.push("Nothing was submitted.", "Remove/redact the value (or exclude the file via .pi/batchignore) and retry.");
  return lines.join("\n");
}
