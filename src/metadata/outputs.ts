import * as fs from "node:fs";
import * as path from "node:path";
import type { ArtifactService } from "../artifacts/service.js";
import type { ArtifactManifest } from "../artifacts/store.js";
import type { BatchService } from "../service.js";
import { SubmissionBlockedError } from "../service.js";
import { TERMINAL_STATUSES } from "../state.js";
import { approvedDraftRows, metadataOutcome, metadataReviewMarkdown, toApprovedJsonl, validateApprovedText, type ApprovedValidation, type MetadataOutcome } from "./report.js";

/**
 * The two files a metadata job produces on explicit request, both written through
 * the artifact system (workspace containment, no silent overwrite, atomic writes,
 * provenance): the Markdown review and the approved-handoff draft.
 */

function finished(o: MetadataOutcome): void {
  if (!TERMINAL_STATUSES.has(o.job.localStatus)) throw new Error(`${o.job.localId} is ${o.job.localStatus}; wait until it has finished.`);
}

function rel(service: BatchService, abs: string): string {
  return path.relative(fs.realpathSync.native(service.workspaceRoot), abs).split(path.sep).join("/");
}

export async function writeMetadataReview(service: BatchService, art: ArtifactService, jobRef: string, opts: { out?: string; overwrite?: boolean }): Promise<{ manifest: ArtifactManifest; outcome: MetadataOutcome; gaps: number }> {
  const o = metadataOutcome(service, jobRef);
  finished(o);
  const gaps = o.tables.filter((t) => !t.proposal).length;
  const plan = await art.planFromReport({
    jobId: o.job.localId,
    label: "metadata-review",
    content: metadataReviewMarkdown(o),
    format: "markdown",
    out: opts.out,
    overwrite: opts.overwrite,
    files: [rel(service, service.registry.artefact(o.job.localId, "metadataPlan"))],
    warnings: gaps ? [`${gaps} of ${o.tables.length} table(s) have no usable proposal (listed in the review)`] : [],
  });
  return { manifest: art.execute(plan), outcome: o, gaps };
}

/** The approved-handoff refusal when tables have no usable proposal (CLI wording; the web page rewords its hint). */
export function approvedGapsMessage(gapTables: readonly string[], total: number, jobId: string): string {
  return (
    `${gapTables.length} of ${total} table(s) have no usable proposal: ${gapTables.join(", ")}.\n` +
    `Retry them (/batch retry-items ${jobId} --failed), or pass --allow-partial to include them with their existing values unchanged.`
  );
}

export async function writeApprovedDraft(
  service: BatchService,
  art: ArtifactService,
  jobRef: string,
  opts: { out: string; overwrite?: boolean; allowPartial?: boolean },
): Promise<{ manifest: ArtifactManifest; validation: ApprovedValidation; outcome: MetadataOutcome }> {
  if (!/\.jsonl$/i.test(opts.out)) throw new SubmissionBlockedError("The approved handoff is JSON Lines: use a .jsonl destination.");
  const o = metadataOutcome(service, jobRef);
  finished(o);
  const gaps = o.tables.filter((t) => !t.proposal);
  if (gaps.length && !opts.allowPartial) {
    throw new SubmissionBlockedError(approvedGapsMessage(gaps.map((g) => g.table), o.tables.length, o.job.localId));
  }
  const content = toApprovedJsonl(approvedDraftRows(o));
  const pre = validateApprovedText(content, service, o.job.localId);
  if (pre.problems.length) throw new Error(`Internal check of the generated handoff failed; nothing was written:\n- ${pre.problems.join("\n- ")}`);
  const manifest = art.execute(
    await art.planFromReport({
      jobId: o.job.localId,
      label: "metadata-approved-draft",
      content,
      format: "text",
      out: opts.out,
      overwrite: opts.overwrite,
      files: o.tables.filter((t) => t.resultJobId).map((t) => rel(service, service.registry.itemArtefact(t.resultJobId!, t.resultOrdinal!, "output"))),
      warnings: gaps.length ? [`${gaps.length} table(s) without a usable proposal keep their existing values`] : [],
    }),
  );
  // Validate what was actually written, not what was meant to be written.
  const written = fs.readFileSync(path.join(service.workspaceRoot, ...manifest.output!.path.split("/")), "utf8");
  return { manifest, validation: validateApprovedText(written, service, o.job.localId), outcome: o };
}
