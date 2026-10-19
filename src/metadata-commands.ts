import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { parseArgs } from "./args.js";
import { TextViewerComponent } from "./dashboard.js";
import type { BatchRuntime } from "./runtime.js";
import { SubmissionBlockedError, type PreparedMetadataRun } from "./service.js";

/**
 * `/batch metadata …` — Phase 1 Databricks metadata enrichment (table descriptions and
 * column comments only). Pi never connects to Databricks, generates SQL or applies
 * anything: it plans requests, validates proposals, and writes review and handoff files
 * on explicit commands.
 */

export const METADATA_HELP = `/batch metadata — Databricks table descriptions and column comments (proposals only)

  plan --context <context.md> --input <tables.jsonl> [--preview] [--model <slug>] [--account] [--provider]
                                     one request per table; --preview saves the plan without sending

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
