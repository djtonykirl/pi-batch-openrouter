import { sha256Hex } from "../fsutil.js";

export interface BundleManifest {
  run_id: string;
  domain_prefix: string;
  contract_version: string;
  files: Array<{ path: string; sha256: string; bytes: number }>;
  table_count: number;
  created_ts: string;
}

export type BundleCheck =
  | { ok: true; manifest: BundleManifest; dest: string; writes: Array<{ relPath: string; bytes: Buffer }> }
  | { ok: false; problems: string[] };

const RUN_ID = /^[A-Za-z0-9._-]{1,100}$/;
const PREFIX = /^[A-Z0-9]{4}$/;

/** A run ID is a safe path segment: the allowed characters, 1-100 long, and not only dots ("." / ".."). */
function validRunId(v: unknown): v is string {
  return typeof v === "string" && RUN_ID.test(v) && !/^.+$/.test(v);
}

function validDomainPrefix(v: unknown): v is string {
  return typeof v === "string" && PREFIX.test(v);
}
const DATA_FILES = ["tables.jsonl", "context.md"] as const;
const MANIFEST = "manifest.json";

function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
}

/** Messages name files and fields only, never file contents. */
export function checkBundle(
  files: Array<{ name: string; bytes: Buffer }>,
  opts: { maxBytes: number },
): BundleCheck {
  const problems: string[] = [];
  const byName = new Map<string, Buffer>();
  for (const f of files) {
    const n = baseName(f.name);
    if (byName.has(n)) problems.push(`Duplicate file: ${n}`);
    byName.set(n, f.bytes);
    if (n !== MANIFEST && !(DATA_FILES as readonly string[]).includes(n)) problems.push(`Unexpected file: ${n}`);
    if (f.bytes.length > opts.maxBytes) problems.push(`${n} is larger than the ${opts.maxBytes} byte limit`);
  }
  for (const n of [MANIFEST, ...DATA_FILES]) if (!byName.has(n)) problems.push(`Missing file: ${n}`);
  const manifestBytes = byName.get(MANIFEST);
  if (!manifestBytes) return { ok: false, problems };

  let raw: unknown;
  try {
    raw = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    problems.push("manifest.json is not valid JSON");
    return { ok: false, problems };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    problems.push("manifest.json must be a JSON object");
    return { ok: false, problems };
  }
  const m = raw as Record<string, unknown>;
  if (typeof m.run_id !== "string" || !RUN_ID.test(m.run_id) || /^\.+$/.test(m.run_id)) problems.push("manifest run_id is missing or invalid");
  if (!validDomainPrefix(m.domain_prefix)) problems.push("manifest domain_prefix is missing or invalid");
  if (typeof m.contract_version !== "string") problems.push("manifest contract_version is missing");
  if (!isCount(m.table_count)) problems.push("manifest table_count is missing");
  if (typeof m.created_ts !== "string") problems.push("manifest created_ts is missing");
  const entries = Array.isArray(m.files) ? (m.files as unknown[]) : null;
  if (!entries) problems.push("manifest files is missing");

  const listed = new Map<string, { path: string; sha256: string; bytes: number }>();
  for (const e of entries ?? []) {
    const o = e as Record<string, unknown> | null;
    if (!o || typeof o.path !== "string" || typeof o.sha256 !== "string" || !isCount(o.bytes)) {
      problems.push("manifest files has a malformed entry");
      continue;
    }
    const n = baseName(o.path);
    if (listed.has(n)) problems.push(`manifest lists ${n} twice`);
    listed.set(n, { path: o.path, sha256: o.sha256, bytes: o.bytes });
  }
  for (const n of listed.keys()) {
    if (!(DATA_FILES as readonly string[]).includes(n)) problems.push(`manifest lists unexpected file: ${n}`);
  }
  for (const n of DATA_FILES) {
    const entry = listed.get(n);
    if (!entry) {
      if (entries) problems.push(`manifest does not list ${n}`);
      continue;
    }
    const data = byName.get(n);
    if (!data) continue;
    if (data.length !== entry.bytes) problems.push(`${n} size does not match the manifest`);
    if (sha256Hex(data).toLowerCase() !== entry.sha256.toLowerCase()) problems.push(`${n} sha256 does not match the manifest`);
  }
  if (problems.length > 0) return { ok: false, problems };

  const manifest: BundleManifest = {
    run_id: m.run_id as string,
    domain_prefix: m.domain_prefix as string,
    contract_version: m.contract_version as string,
    files: [...listed.values()],
    table_count: m.table_count as number,
    created_ts: m.created_ts as string,
  };
  const dest = `metadata/${manifest.domain_prefix.toLowerCase()}/${manifest.run_id}`;
  return {
    ok: true,
    manifest,
    dest,
    writes: [
      { relPath: `${dest}/tables.jsonl`, bytes: byName.get("tables.jsonl")! },
      { relPath: `${dest}/context.md`, bytes: byName.get("context.md")! },
      { relPath: `${dest}/manifest.json`, bytes: manifestBytes },
    ],
  };
}

/**
 * The IDs of a manifest.json already on disk (the one next to an imported context.md), or null when it is not
 * valid JSON or its run_id / domain_prefix / contract_version / table_count are missing or malformed.
 */
export function manifestIds(text: string): Pick<BundleManifest, "run_id" | "domain_prefix" | "contract_version" | "table_count"> | null {
  let m: unknown;
  try {
    m = JSON.parse(text);
  } catch {
    return null;
  }
  if (!m || typeof m !== "object" || Array.isArray(m)) return null;
  const o = m as Record<string, unknown>;
  if (typeof o.run_id !== "string" || !RUN_ID.test(o.run_id) || /^\.+$/.test(o.run_id)) return null;
  if (typeof o.domain_prefix !== "string" || !PREFIX.test(o.domain_prefix)) return null;
  if (typeof o.contract_version !== "string" || !isCount(o.table_count)) return null;
  return { run_id: o.run_id, domain_prefix: o.domain_prefix, contract_version: o.contract_version, table_count: o.table_count };
}

export function inboxPath(manifest: Pick<BundleManifest, "run_id" | "domain_prefix">, catalog: string): string {
  return `/Volumes/${catalog}/lighthouse_governance/metadata/inbox/${manifest.domain_prefix}/${manifest.run_id}/approved.jsonl`;
}
