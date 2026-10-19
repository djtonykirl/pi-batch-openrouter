import * as fs from "node:fs";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { parseArgs } from "./args.js";
import { ArtifactError } from "./artifacts/service.js";
import { TextViewerComponent } from "./dashboard.js";
import { writeApprovedDraft, writeMetadataReview } from "./metadata/outputs.js";
import { metadataOutcome, metadataSummary, validateApprovedText } from "./metadata/report.js";
import type { BatchRuntime } from "./runtime.js";
import { SubmissionBlockedError, type PreparedMetadataRun } from "./service.js";
import { resolveWorkspaceInput } from "./workspace-paths.js";

/**
 * `/batch metadata …` — Phase 1 Databricks metadata enrichment (table descriptions and
 * column comments only). Pi never connects to Databricks, generates SQL or applies
 * anything: it plans requests, validates proposals, and writes review and handoff files
 * on explicit commands.
 */

export const METADATA_HELP = `/batch metadata — Databricks table descriptions and column comments (proposals only)

  plan --context <context.md> --input <tables.jsonl> [--preview] [--model <slug>] [--account] [--provider]
                                     one request per table; --preview saves the plan without sending
  summary <job>                      coverage, statuses and confidence totals
  review <job> [--out <file.md>] [--overwrite]
                                     Markdown review: existing vs proposed values (an artifact)
  approved <job> --out <approved.jsonl> [--overwrite] [--allow-partial]
                                     draft handoff: existing values kept, empty ones take the proposal,
                                     insufficient evidence stays null; edit it, then validate it
  validate-approved <approved.jsonl> [--job <id>]
                                     check a handoff against the job's evidence and report edits

Submit, track and retry with /batch submit, check, items, item, retry-items. Nothing is applied to
Databricks and no SQL is produced.`;

async function show(rt: BatchRuntime, ctx: ExtensionCommandContext, title: string, body: string): Promise<void> {
  if (ctx.hasUI && ctx.mode === "tui") {
    await ctx.ui.custom<void>((_tui, _theme, _kb, done) => new TextViewerComponent(title, body, () => done(undefined), () => process.stdout.rows ?? 24));
    return;
  }
  rt.notify(`${title}\n\n${body}`, "info");
}

export async function cmdMetadata(rt: BatchRuntime, rest: string[], ctx: ExtensionCommandContext): Promise<void> {
  const sub = (rest[0] ?? "help").toLowerCase();
  const args = rest.slice(1);
  const service = rt.requireService();
  switch (sub) {
    case "plan": {
      const parsed = parseArgs(args, { values: ["context", "input", "model", "account", "provider"], booleans: ["preview"] });
      if (parsed.errors.length) throw new Error(`/batch metadata plan: ${parsed.errors.join("; ")}`);
      if (!parsed.values.context || !parsed.values.input) throw new Error("Usage: /batch metadata plan --context <context.md> --input <tables.jsonl> [--preview]");
      const prepared = await service.planMetadata({ context: parsed.values.context, input: parsed.values.input, model: parsed.values.model, account: parsed.values.account, providerPin: parsed.values.provider });
      const previewOnly = parsed.booleans.has("preview");
      const preview = formatMetadataPreview(prepared, previewOnly);
      if (prepared.blockers.length > 0) throw new SubmissionBlockedError(`${preview}\n\nPLAN BLOCKED — nothing was saved or sent:\n\n${prepared.blockers.join("\n\n")}`);
      const job = await service.createMetadataJob(prepared, { previewOnly });
      if (previewOnly) {
        rt.notify(`${preview}\n\nPlan saved as ${job.localId} (not submitted).\nSubmit: /batch submit ${job.localId}`, "info");
        return;
      }
      rt.poller.updateBadge();
      rt.notify(job.localStatus === "submitted" ? `${preview}\n\n✅ Accepted by OpenRouter (${job.providerStatus}); ${job.requestCount} request(s), job ${job.localId}. Track: /batch items ${job.localId}` : `❌ ${job.localId} ${job.localStatus}: ${job.error?.message ?? ""}`, job.localStatus === "submitted" ? "info" : "error");
      return;
    }
    case "summary": {
      const id = args.find((a) => !a.startsWith("--"));
      if (!id) throw new Error("Usage: /batch metadata summary <job>");
      const o = metadataOutcome(service, id);
      await show(rt, ctx, `Metadata ${o.job.localId}`, metadataSummary(o));
      return;
    }
    case "review": {
      const parsed = parseArgs(args, { values: ["out"], booleans: ["overwrite"] });
      if (parsed.errors.length) throw new Error(`/batch metadata review: ${parsed.errors.join("; ")}`);
      const id = parsed.positionals[0];
      if (!id) throw new Error("Usage: /batch metadata review <job> [--out <file.md>] [--overwrite]");
      const { manifest: m, gaps } = await writeMetadataReview(service, rt.requireArtifacts(), id, { out: parsed.values.out, overwrite: parsed.booleans.has("overwrite") });
      rt.notify(`✅ Review written: ${m.output!.path} (artifact ${m.artifactId})${gaps ? `\n   ⚠ ${gaps} table(s) without a usable proposal are listed in it` : ""}\n   Proposed metadata has not been applied to Databricks.\n   Edit it with Pi if needed, or render it: /artifact render ${m.output!.path} --format pdf --out <file.pdf>`, "info");
      return;
    }
    case "approved": {
      const parsed = parseArgs(args, { values: ["out"], booleans: ["overwrite", "allow-partial"] });
      if (parsed.errors.length) throw new Error(`/batch metadata approved: ${parsed.errors.join("; ")}`);
      const id = parsed.positionals[0];
      if (!id || !parsed.values.out) throw new Error("Usage: /batch metadata approved <job> --out <approved.jsonl> [--overwrite] [--allow-partial]");
      const { manifest: m, validation, outcome } = await writeApprovedDraft(service, rt.requireArtifacts(), id, { out: parsed.values.out, overwrite: parsed.booleans.has("overwrite"), allowPartial: parsed.booleans.has("allow-partial") });
      const c = validation.counts;
      rt.notify(
        `✅ Draft handoff written: ${m.output!.path} (artifact ${m.artifactId}, sha256 ${m.output!.sha256})\n` +
          `   ${outcome.tables.length} table(s); values: ${c.keptExisting} existing kept, ${c.fromProposal} from proposals, ${c.nullApproved} null (insufficient evidence or no proposal)\n` +
          `   This is a DRAFT for review: existing comments were kept, not replaced. Edit approved_* values, then: /batch metadata validate-approved ${m.output!.path}\n` +
          `   Nothing has been applied to Databricks.`,
        validation.problems.length ? "warning" : "info",
      );
      return;
    }    case "validate-approved": {
      const parsed = parseArgs(args, { values: ["job"] });
      if (parsed.errors.length) throw new Error(`/batch metadata validate-approved: ${parsed.errors.join("; ")}`);
      const file = parsed.positionals[0];
      if (!file) throw new Error("Usage: /batch metadata validate-approved <approved.jsonl> [--job <id>]");
      const r = resolveWorkspaceInput(service.workspaceRoot, file, rt.loaded.config, { what: "approved file", maxBytes: rt.loaded.config.workflows.maxDatasetBytes });
      if (!r.ok) throw new ArtifactError(r.message);
      const v = validateApprovedText(fs.readFileSync(r.absPath, "utf8"), service, parsed.values.job);
      const c = v.counts;
      const summary = `${r.relPath}: ${v.rows} table row(s)${v.jobId ? ` from job ${v.jobId}` : ""}; ${c.total} value(s): ${c.keptExisting} existing kept, ${c.fromProposal} as proposed, ${c.edited} edited by a reviewer, ${c.nullApproved} null`;
      if (v.problems.length) throw new SubmissionBlockedError(`❌ ${summary}\n\nProblems:\n- ${v.problems.join("\n- ")}`);
      rt.notify(`✅ ${summary}\n   Valid against the job's evidence. Hand it to the Databricks process for validation and application; Pi applies nothing.`, "info");
      return;
    }
    case "help":
      await show(rt, ctx, "/batch metadata help", METADATA_HELP);
      return;
    default:
      throw new Error(`Unknown /batch metadata subcommand ${JSON.stringify(sub)}. Try /batch metadata help`);
  }
}

export function formatMetadataPreview(p: PreparedMetadataRun, previewOnly: boolean): string {
  const plan = p.plan;
  const lines = [p.blockers.length ? "Metadata plan (BLOCKED)" : previewOnly ? "Metadata plan (not submitted)" : "Submitting metadata plan", ""];
  lines.push(`Workflow:          databricks-metadata (built-in): table descriptions and column comments only`);
  if (p.context) lines.push(`Context:           ${p.context.relPath}  (sha256 ${plan?.contextSha256 ?? "-"})`);
  if (p.input) lines.push(`Input:             ${p.input.relPath}  (sha256 ${plan?.inputSha256 ?? "-"})`);
  if (plan) {
    lines.push(
      `Tables:            ${plan.tables}${plan.blankLines ? `  (${plan.blankLines} blank line(s) ignored)` : ""}`,
      `Requests:          ${plan.items.length}  (one per table, one batch)`,
      `Tables w/ samples: ${plan.tablesWithSamples}  (sample values are sent as given; they are not shown here)`,
      `Characters:        ${plan.totalCharacters} provider-bound (not a token count; no cost estimate)`,
      `Largest request:   ${plan.largest ? `${plan.largest.characters} characters (${plan.largest.table})` : "-"}`,
      `Model:             ${p.model}`,
      `Provider pin:      ${p.pin ? `${p.pin.only.join(",")} (no fallbacks)` : "none"}`,
      `Secrets:           ${plan.secretFindings.length ? `${plan.secretFindings.length} potential finding(s)` : "none detected"} (context and each table's evidence)`,
      `Plan SHA-256:      ${plan.planSha256}`,
      `Warnings:          ${p.warnings.length ? p.warnings.join("; ") : "none"}`,
    );
    if (plan.items.length) {
      lines.push("", "Tables:");
      for (const it of plan.items.slice(0, 30)) lines.push(`  ${String(it.ordinal).padStart(3, "0")}  ${String(it.characters).padStart(7)} chars  ${String(it.evidence.columns.length).padStart(4)} col  ${it.hasSamples ? "samples" : "       "}  ${it.evidence.table}`);
      if (plan.items.length > 30) lines.push(`  … ${plan.items.length - 30} more`);
    }
  }
  lines.push("", "Nothing is applied to Databricks; proposals are for review.");
  return lines.join("\n");
}
