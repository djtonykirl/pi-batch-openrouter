import * as fs from "node:fs";
import { sha256Hex } from "../fsutil.js";
import { combinedCoverage } from "../items.js";
import type { BatchService } from "../service.js";
import { isMetadataWorkflow, type JobManifest } from "../types.js";
import { approvedRowProblems, evidenceHash, identityKey, type ApprovedRow, type Confidence, type TableEvidence, type TableProposal } from "./contract.js";

/**
 * Summary, review document and approved handoff for a `databricks-metadata` job.
 * Everything here is local and deterministic: no model call, no Databricks call,
 * no SQL. Results come from combined coverage (the job plus linked retry jobs),
 * so a successful retry fills a gap, and every table of the job is always
 * accounted for — tables without a usable proposal are listed, never dropped.
 */

export interface TableOutcome {
  ordinal: number;
  table: string;
  evidence: TableEvidence;
  /** Status of the usable attempt, or of the latest attempt when none is usable. */
  status: string;
  proposal?: TableProposal;
  proposalSha256?: string;
  resultJobId?: string;
  resultCustomId?: string;
  /** Ordinal of the result item within resultJobId. */
  resultOrdinal?: number;
  error?: string;
}

export interface MetadataOutcome {
  job: JobManifest;
  contextPath: string;
  contextSha256: string;
  inputPath: string;
  inputSha256: string;
  tables: TableOutcome[];
  retryJobIds: string[];
}

export function metadataOutcome(service: BatchService, jobRef: string): MetadataOutcome {
  const registry = service.registry;
  const job = registry.read(registry.resolveId(jobRef));
  if (!isMetadataWorkflow(job.workflow)) throw new Error(`${job.localId} is not a databricks-metadata job.`);
  if (job.parentJobId) throw new Error(`${job.localId} is a retry of ${job.parentJobId}; use the original job (retries are included automatically).`);
  const stored = service.metadataEvidence(job.localId);
  const byTable = new Map(stored.tables.map((t) => [t.table, t]));
  const cov = combinedCoverage(registry, job.localId);
  const tables = cov.entries.map((e): TableOutcome => {
    const table = e.root.source.sourceId!;
    const ev = byTable.get(table)!.evidence;
    const base = { ordinal: e.root.ordinal, table, evidence: ev };
    if (e.usable) {
      const p = registry.itemArtefact(e.usable.jobId, e.usable.item.ordinal, "output");
      const bytes = fs.readFileSync(p);
      return { ...base, status: "completed", proposal: JSON.parse(bytes.toString("utf8")) as TableProposal, proposalSha256: sha256Hex(bytes), resultJobId: e.usable.jobId, resultCustomId: e.usable.item.customId, resultOrdinal: e.usable.item.ordinal };
    }
    const last = e.attempts[e.attempts.length - 1]!;
    const status = last.item.status === "planned" || last.item.status === "submitted" ? `no result (job ${last.jobId} is ${last.jobStatus})` : last.item.status;
    return { ...base, status, ...(last.item.error ? { error: `${last.item.error.code ? `[${last.item.error.code}] ` : ""}${last.item.error.message}` } : {}) };
  });
  return { job, contextPath: stored.context.path, contextSha256: stored.context.sha256, inputPath: stored.input.path, inputSha256: stored.input.sha256, tables, retryJobIds: cov.retryJobIds };
}

function confidenceTotals(o: MetadataOutcome): { table: Record<Confidence, number>; column: Record<Confidence, number> } {
  const zero = (): Record<Confidence, number> => ({ high: 0, medium: 0, low: 0, insufficient: 0 });
  const t = zero();
  const c = zero();
  for (const x of o.tables) {
    if (!x.proposal) continue;
    t[x.proposal.table_description.confidence]++;
    for (const col of x.proposal.columns) c[col.confidence]++;
  }
  return { table: t, column: c };
}

const fmtConf = (r: Record<Confidence, number>) => `high ${r.high} · medium ${r.medium} · low ${r.low} · insufficient ${r.insufficient}`;

export function metadataSummary(o: MetadataOutcome): string {
  const done = o.tables.filter((t) => t.proposal);
  const conf = confidenceTotals(o);
  const existingDesc = o.tables.filter((t) => t.evidence.existing_description !== null).length;
  const cols = o.tables.reduce((n, t) => n + t.evidence.columns.length, 0);
  const existingCols = o.tables.reduce((n, t) => n + t.evidence.columns.filter((c) => c.existing_comment !== null).length, 0);
  const lines = [
    `Job ${o.job.localId}: ${o.job.localStatus}   workflow databricks-metadata`,
    `Context:   ${o.contextPath}  (sha256 ${o.contextSha256})`,
    `Input:     ${o.inputPath}  (sha256 ${o.inputSha256})`,
    `Tables:    ${o.tables.length} · proposals ${done.length} · without a usable proposal ${o.tables.length - done.length}${o.retryJobIds.length ? ` (retries: ${o.retryJobIds.join(", ")})` : ""}`,
    `Existing:  ${existingDesc} table description(s), ${existingCols} of ${cols} column comment(s)`,
    `Confidence (tables):  ${fmtConf(conf.table)}`,
    `Confidence (columns): ${fmtConf(conf.column)}`,
    "",
    "TABLE                                             STATUS      DESCRIPTION   COLUMNS (proposed / insufficient / total)",
  ];
  for (const t of o.tables) {
    const p = t.proposal;
    const desc = p ? (p.table_description.comment === null ? "insufficient" : p.table_description.confidence) : "-";
    const cc = p ? `${p.columns.filter((c) => c.comment !== null).length} / ${p.columns.filter((c) => c.comment === null).length} / ${t.evidence.columns.length}` : `- / - / ${t.evidence.columns.length}`;
    lines.push(`${t.table.slice(0, 49).padEnd(49)} ${t.status.slice(0, 11).padEnd(11)} ${desc.padEnd(13)} ${cc}`);
  }
  lines.push("", "Proposals are not applied anywhere. Review: /batch metadata review " + o.job.localId + " --out <file.md>");
  return lines.join("\n");
}

const cell = (s: string | null | undefined) => (s === null || s === undefined ? "—" : s.replace(/\r?\n/g, " ").replace(/\|/g, "\\|"));
const block = (s: string | null) => (s === null ? "_none_" : s);

/** The review document (Markdown). Deterministic for a given job state. */
export function metadataReviewMarkdown(o: MetadataOutcome): string {
  const done = o.tables.filter((t) => t.proposal);
  const conf = confidenceTotals(o);
  const out: string[] = [
    "# Metadata proposal",
    "",
    "> **Proposed metadata has not been applied to Databricks.** These are model-generated proposals for review. Existing descriptions and comments are shown alongside; a proposal does not replace them unless a reviewer approves it.",
    "",
    "## Coverage",
    "",
    `- Job: ${o.job.localId} (${o.job.localStatus}, model ${o.job.model})${o.retryJobIds.length ? `; retries: ${o.retryJobIds.join(", ")}` : ""}`,
    `- Context: ${o.contextPath} (sha256 \`${o.contextSha256}\`)`,
    `- Input: ${o.inputPath} (sha256 \`${o.inputSha256}\`)`,
    `- Tables: ${o.tables.length}`,
    `- Completed: ${done.length}`,
    `- Failed/corrupt/missing: ${o.tables.length - done.length}`,
    `- Table description confidence: ${fmtConf(conf.table)}`,
    `- Column comment confidence: ${fmtConf(conf.column)}`,
  ];
  const gaps = o.tables.filter((t) => !t.proposal);
  if (gaps.length) {
    out.push("", "### Tables without a usable proposal", "", ...gaps.map((t) => `- ${t.table}: ${t.status}${t.error ? ` — ${cell(t.error)}` : ""}`));
  }
  for (const t of o.tables) {
    out.push("", `## ${t.table}`, "");
    // Contract v2 only: v1 documents are unchanged.
    const facts = [t.evidence.layer && `**Layer:** ${t.evidence.layer}`, t.evidence.object_type && `**Object:** ${t.evidence.object_type}`].filter(Boolean);
    if (facts.length) out.push(facts.join(" · "), "");
    out.push("**Existing description:**", "", block(t.evidence.existing_description), "");
    if (!t.proposal) {
      out.push(`_No usable proposal (${t.status})._ Retry it with \`/batch retry-items ${o.job.localId} --failed\`.`);
      continue;
    }
    const d = t.proposal.table_description;
    out.push("**Proposed description:**", "", block(d.comment), "", `**Confidence:** ${d.confidence}`, "", `**Reason:** ${d.reason}`, "");
    if (t.evidence.existing_description !== null && d.comment !== null && d.comment !== t.evidence.existing_description) out.push("_An existing description is present: the proposal replaces it only if a reviewer approves the change._", "");
    const tiers = t.evidence.columns.some((c) => c.profile);
    out.push("### Columns", "", tiers ? "| Column | Type | Tier | Existing | Proposed | Confidence |" : "| Column | Type | Existing | Proposed | Confidence |", tiers ? "|---|---|---|---|---|---|" : "|---|---|---|---|---|");
    const byName = new Map(t.proposal.columns.map((c) => [c.name, c]));
    for (const c of t.evidence.columns) {
      const p = byName.get(c.name)!;
      const tier = tiers ? ` ${c.profile ? String(c.profile.disclosure_tier) : "—"} |` : "";
      out.push(`| ${cell(c.name)} | ${cell(c.data_type)} |${tier} ${cell(c.existing_comment)} | ${cell(p.comment)} | ${p.confidence} |`);
    }
    const insufficient = t.proposal.columns.filter((c) => c.comment === null);
    if (d.comment === null || insufficient.length) {
      out.push("", "### Insufficient evidence", "");
      if (d.comment === null) out.push(`- (table): ${cell(d.reason)}`);
      for (const c of insufficient) out.push(`- ${c.name}: ${cell(c.reason)}`);
    }
    out.push("", `<sub>Evidence sha256 \`${evidenceHash(t.evidence)}\` · proposal sha256 \`${t.proposalSha256}\` · result ${t.resultJobId} ${t.resultCustomId}</sub>`);
  }
  out.push("");
  return out.join("\n");
}

/**
 * The approved handoff as a reviewable draft: existing values are kept where present
 * (a generated replacement is never approved automatically); empty values take the
 * proposal; insufficient evidence stays null. Every table of the job is included, in
 * input order, with fixed key order. The reviewer edits approved_* values, then runs
 * validate-approved.
 */
export function approvedDraftRows(o: MetadataOutcome): ApprovedRow[] {
  return o.tables.map((t) => {
    const byName = new Map((t.proposal?.columns ?? []).map((c) => [c.name, c]));
    return {
      table: t.table,
      existing_description: t.evidence.existing_description,
      approved_description: t.evidence.existing_description ?? t.proposal?.table_description.comment ?? null,
      columns: t.evidence.columns.map((c) => ({ name: c.name, existing_comment: c.existing_comment, approved_comment: c.existing_comment ?? byName.get(c.name)?.comment ?? null })),
      provenance: {
        job_id: o.job.localId,
        result_job_id: t.resultJobId ?? null,
        result_custom_id: t.resultCustomId ?? null,
        input_sha256: evidenceHash(t.evidence),
        context_sha256: o.contextSha256,
        proposal_sha256: t.proposalSha256 ?? null,
      },
    };
  });
}

export function toApprovedJsonl(rows: readonly ApprovedRow[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

export interface ApprovedValidation {
  problems: string[];
  rows: number;
  jobId?: string;
  /** Per value (table descriptions and column comments). */
  counts: { keptExisting: number; fromProposal: number; edited: number; nullApproved: number; total: number };
}

/** Checks an approved JSONL file against the job it names: no invented, missing or altered tables/columns. */
export function validateApprovedText(text: string, service: BatchService, jobOverride?: string): ApprovedValidation {
  const res: ApprovedValidation = { problems: [], rows: 0, counts: { keptExisting: 0, fromProposal: 0, edited: 0, nullApproved: 0, total: 0 } };
  const rows: Array<{ line: number; row: ApprovedRow }> = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    if (!raw.trim()) return;
    let v: unknown;
    try {
      v = JSON.parse(raw);
    } catch {
      res.problems.push(`line ${i + 1}: not valid JSON`);
      return;
    }
    const p = approvedRowProblems(v);
    if (p.length) res.problems.push(...p.map((m) => `line ${i + 1}: ${m}`));
    else rows.push({ line: i + 1, row: v as ApprovedRow });
  });
  res.rows = rows.length;
  if (res.problems.length || rows.length === 0) {
    if (rows.length === 0 && !res.problems.length) res.problems.push("the file contains no rows");
    return res;
  }
  const jobIds = new Set(rows.map((r) => r.row.provenance.job_id));
  if (jobIds.size > 1 && !jobOverride) {
    res.problems.push(`rows name more than one source job (${[...jobIds].join(", ")})`);
    return res;
  }
  const jobId = jobOverride ? service.registry.resolveId(jobOverride) : [...jobIds][0]!;
  res.jobId = jobId;
  let o: MetadataOutcome;
  try {
    o = metadataOutcome(service, jobId);
  } catch (err) {
    res.problems.push((err as Error).message);
    return res;
  }
  const byTable = new Map(o.tables.map((t) => [t.table, t]));
  const seen = new Set<string>();
  for (const { line, row } of rows) {
    const t = byTable.get(row.table);
    if (!t) {
      res.problems.push(`line ${line}: table ${JSON.stringify(row.table)} is not in job ${jobId}`);
      continue;
    }
    if (seen.has(identityKey(row.table))) res.problems.push(`line ${line}: table ${JSON.stringify(row.table)} appears more than once`);
    seen.add(identityKey(row.table));
    if (row.provenance.job_id !== jobId) res.problems.push(`line ${line}: provenance.job_id is not ${jobId}`);
    if (row.provenance.input_sha256 !== evidenceHash(t.evidence)) res.problems.push(`line ${line}: provenance.input_sha256 does not match the evidence of ${row.table} in ${jobId}`);
    if (row.provenance.context_sha256 !== o.contextSha256) res.problems.push(`line ${line}: provenance.context_sha256 does not match the job's context`);
    if (row.existing_description !== t.evidence.existing_description) res.problems.push(`line ${line}: existing_description differs from the evidence (it must be reproduced exactly)`);
    const evCols = new Map(t.evidence.columns.map((c) => [c.name, c]));
    const seenCols = new Set<string>();
    for (const c of row.columns) {
      const e = evCols.get(c.name);
      if (!e) {
        res.problems.push(`line ${line}: column ${JSON.stringify(c.name)} is not a column of ${row.table} (invented)`);
        continue;
      }
      if (seenCols.has(c.name)) res.problems.push(`line ${line}: column ${JSON.stringify(c.name)} appears more than once`);
      seenCols.add(c.name);
      if (c.existing_comment !== e.existing_comment) res.problems.push(`line ${line}: existing_comment of ${JSON.stringify(c.name)} differs from the evidence`);
    }
    for (const c of t.evidence.columns) if (!seenCols.has(c.name)) res.problems.push(`line ${line}: column ${JSON.stringify(c.name)} of ${row.table} is missing`);
    const proposed = new Map((t.proposal?.columns ?? []).map((c) => [c.name, c.comment]));
    const classify = (approved: string | null, existing: string | null, proposal: string | null | undefined) => {
      res.counts.total++;
      if (approved === null) res.counts.nullApproved++;
      else if (approved === existing) res.counts.keptExisting++;
      else if (proposal !== undefined && approved === proposal) res.counts.fromProposal++;
      else res.counts.edited++;
    };
    classify(row.approved_description, row.existing_description, t.proposal?.table_description.comment);
    for (const c of row.columns) if (evCols.has(c.name)) classify(c.approved_comment, c.existing_comment, proposed.get(c.name));
  }
  for (const t of o.tables) if (!seen.has(identityKey(t.table))) res.problems.push(`table ${JSON.stringify(t.table)} of job ${jobId} is missing (every table must be present; keep existing values to leave it unchanged)`);
  return res;
}
