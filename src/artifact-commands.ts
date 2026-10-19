import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { parseArgs, tokenize } from "./args.js";
import { ArtifactError, type ArtifactPlan } from "./artifacts/service.js";
import { discoverTemplates } from "./artifacts/templates.js";
import type { ArtifactManifest } from "./artifacts/store.js";
import { TextViewerComponent } from "./dashboard.js";
import type { BatchRuntime } from "./runtime.js";
import { formatIsoShort } from "./time.js";

/**
 * `/artifact` (list, show, render, regenerate, templates) and the `/batch artifact`
 * handler. Commands only parse arguments; every check lives in ArtifactService.
 */

const HELP = `/artifact — controlled files from validated batch results

  list [--job <id>]                  artifacts, newest first
  show <artifact-id>                 provenance: source, hashes, template, renderer, destination
  render <file.md> --format html|pdf [--out <path>] [--overwrite]
                                     render a (Pi/user-edited) Markdown file; no model call
  regenerate <artifact-id> [--format markdown|html|pdf] [--out <path>] [--overwrite]
                                     re-render an artifact's stored source; no model call
  templates                          artifact templates (.pi/artifact-templates/*.yaml) and their validity

Create from a batch job:  /batch artifact <job> [--item <sel>|--synthesis] --format markdown|html|pdf|text
                          [--template <name>] [--out <path>] [--overwrite] [--allow-partial]
Files are written only inside the workspace (not .pi/), never over an existing file without --overwrite,
and never as executable or script types.`;

export function registerArtifactCommand(rt: BatchRuntime): void {
  rt.pi.registerCommand("artifact", {
    description: "Controlled artifacts from batch results: list, show, render (Pi-edited Markdown -> HTML/PDF), regenerate, templates",
    getArgumentCompletions: async (prefix: string) => {
      const subs = ["list", "show", "render", "regenerate", "templates", "help"];
      const typed = prefix.trim().toLowerCase();
      if (typed.includes(" ")) return null;
      const items = subs.filter((s) => s.startsWith(typed)).map((s) => ({ value: `${s} `, label: s, description: "" }));
      return items.length ? items : null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      try {
        await dispatchArtifact(rt, args, ctx);
      } catch (err) {
        rt.notify((err as Error).message, err instanceof ArtifactError ? "warning" : "error");
      }
    },
  });
}

async function show(rt: BatchRuntime, ctx: ExtensionCommandContext, title: string, body: string): Promise<void> {
  if (ctx.hasUI && ctx.mode === "tui") {
    await ctx.ui.custom<void>((_tui, _theme, _kb, done) => new TextViewerComponent(title, body, () => done(undefined), () => process.stdout.rows ?? 24));
    return;
  }
  rt.notify(`${title}\n\n${body}`, "info");
}

async function dispatchArtifact(rt: BatchRuntime, args: string, ctx: ExtensionCommandContext): Promise<void> {
  const tokens = tokenize(args);
  const sub = (tokens[0] ?? "list").toLowerCase();
  const rest = tokens.slice(1);
  const art = rt.requireArtifacts();
  switch (sub) {
    case "list": {
      const parsed = parseArgs(rest, { values: ["job"] });
      if (parsed.errors.length) throw new ArtifactError(`/artifact list: ${parsed.errors.join("; ")}`);
      const jobId = parsed.values.job ? rt.requireService().registry.resolveId(parsed.values.job) : undefined;
      const list = art.list(jobId ? { jobId } : {});
      if (list.length === 0) {
        rt.notify(jobId ? `No artifacts for ${jobId}.` : "No artifacts yet. Create one with /batch artifact <job> --format markdown --out reports/x.md", "info");
        return;
      }
      const lines = ["ARTIFACT          STATUS    FORMAT    SOURCE                          CREATED            OUTPUT"];
      for (const a of list) lines.push(`${a.artifactId.padEnd(17)} ${a.status.padEnd(9)} ${a.format.padEnd(9)} ${sourceCell(a).slice(0, 31).padEnd(31)} ${formatIsoShort(a.createdAt).padEnd(18)} ${a.output?.path ?? "-"}`);
      rt.notify(lines.join("\n"), "info");
      return;
    }
    case "show": {
      const raw = rest.find((t) => !t.startsWith("--"));
      if (!raw) throw new ArtifactError("Usage: /artifact show <artifact-id>");
      const m = art.store.read(art.store.resolveId(raw));
      const events = art.store.events(m.artifactId).map((e) => `   ${formatIsoShort(e.eventAt)}  ${e.eventType}`);
      await show(rt, ctx, `Artifact ${m.artifactId}`, [...describeArtifact(m), "", "  Events:", ...events].join("\n"));
      return;
    }
    case "render": {
      const parsed = parseArgs(rest, { values: ["format", "out"], booleans: ["overwrite"] });
      if (parsed.errors.length) throw new ArtifactError(`/artifact render: ${parsed.errors.join("; ")}`);
      const file = parsed.positionals[0];
      if (!file || !parsed.values.format) throw new ArtifactError("Usage: /artifact render <file.md> --format html|pdf [--out <path>] [--overwrite]");
      const plan = await art.planFromFile(file, { format: parsed.values.format.toLowerCase(), out: parsed.values.out, overwrite: parsed.booleans.has("overwrite") });
      report(rt, art.execute(plan), plan);
      return;
    }
    case "regenerate": {
      const parsed = parseArgs(rest, { values: ["format", "out"], booleans: ["overwrite"] });
      if (parsed.errors.length) throw new ArtifactError(`/artifact regenerate: ${parsed.errors.join("; ")}`);
      const id = parsed.positionals[0];
      if (!id) throw new ArtifactError("Usage: /artifact regenerate <artifact-id> [--format markdown|html|pdf] [--out <path>] [--overwrite]");
      const plan = await art.planRegenerate(id, { format: parsed.values.format?.toLowerCase(), out: parsed.values.out, overwrite: parsed.booleans.has("overwrite") });
      report(rt, art.execute(plan), plan);
      return;
    }
    case "templates": {
      const all = discoverTemplates(rt.requireService().workspaceRoot);
      const lines = all.length
        ? all.map((t) => `  ${t.name.padEnd(24)} ${t.valid ? `valid    ${t.template!.input.type} input${t.template!.description ? `  ${t.template!.description}` : ""}` : `INVALID\n${t.diagnostics.map((d) => `      ${d.path ? `[${d.path}] ` : ""}${d.message}`).join("\n")}`}`)
        : ["  none (add YAML templates to .pi/artifact-templates/)"];
      await show(rt, ctx, "Artifact templates", lines.join("\n"));
      return;
    }
    case "help":
      await show(rt, ctx, "/artifact help", HELP);
      return;
    default:
      throw new ArtifactError(`Unknown /artifact subcommand ${JSON.stringify(sub)}. Try /artifact help`);
  }
}

/** `/batch artifact <job> …` */
export async function cmdBatchArtifact(rt: BatchRuntime, rest: string[]): Promise<void> {
  const parsed = parseArgs(rest, { values: ["item", "format", "template", "out"], booleans: ["synthesis", "overwrite", "allow-partial"] });
  if (parsed.errors.length) throw new ArtifactError(`/batch artifact: ${parsed.errors.join("; ")}`);
  const job = parsed.positionals[0];
  if (!job) throw new ArtifactError("Usage: /batch artifact <job> [--item <sel>|--synthesis] --format markdown|html|pdf|text [--template <name>] [--out <path>] [--overwrite] [--allow-partial]");
  const art = rt.requireArtifacts();
  const plan = await art.planFromJob(job, {
    item: parsed.values.item,
    synthesis: parsed.booleans.has("synthesis"),
    allowPartial: parsed.booleans.has("allow-partial"),
    format: parsed.values.format?.toLowerCase(),
    template: parsed.values.template,
    out: parsed.values.out,
    overwrite: parsed.booleans.has("overwrite"),
  });
  report(rt, art.execute(plan), plan);
}

function report(rt: BatchRuntime, m: ArtifactManifest, plan: ArtifactPlan): void {
  const lines = [
    `✅ Artifact ${m.artifactId}: ${m.format} written to ${m.output!.path}${m.output!.internal ? " (internal; use --out for a workspace file)" : ""}`,
    `   source ${sourceCell(m)} · state ${m.source.state}${m.template ? ` · template ${m.template.name}` : ""} · ${m.output!.bytes} bytes${m.output!.pages ? `, ${m.output!.pages} page(s)` : ""}`,
    `   sha256 ${m.output!.sha256}`,
    ...(m.replaced ? [`   replaced an existing file (sha256 ${m.replaced.sha256}) because --overwrite was given`] : []),
    ...(plan.destinationOrigin === "workflow" ? ["   destination and format from the job's workflow artifact default"] : []),
    ...m.warnings.map((w) => `   ⚠ ${w}`),
    m.format === "markdown" && !m.output!.internal ? `   Edit it with Pi if needed, then: /artifact render ${m.output!.path} --format pdf --out <file.pdf>` : `   Provenance: /artifact show ${m.artifactId}`,
  ];
  rt.notify(lines.join("\n"), "info");
}

function sourceCell(m: ArtifactManifest): string {
  const s = m.source;
  if (s.type === "synthesis") return `synthesis ${s.synthesisJobId} of ${s.jobId}`;
  if (s.type === "batch-item") return `${s.jobId} item ${s.itemOrdinal}${s.sourceId ? ` (${s.sourceId})` : ""}`;
  if (s.type === "batch-result") return `${s.jobId} result`;
  if (s.type === "batch-report") return `${s.jobId} report`;
  return `file ${s.path}`;
}

/** Shown by `/artifact show`. Only recorded facts; nothing is inferred. */
export function describeArtifact(m: ArtifactManifest): string[] {
  const s = m.source;
  const STATE: Record<ArtifactManifest["source"]["state"], string> = {
    "batch-generated": "batch-generated (read directly from validated batch results)",
    "unmodified-generated-output": "local file, byte-identical to the output of an earlier artifact",
    "modified-after-generation": "local file EDITED after it was generated (this artifact reflects the edited text, not the original batch output)",
    "unlinked-local-file": "local file with no known artifact lineage",
  };
  const rows: Array<[string, string | number | undefined]> = [
    ["Artifact", m.artifactId],
    ["Status", m.status],
    ["Format", m.format],
    ["Created", formatIsoShort(m.createdAt)],
    ["Source type", s.type],
    ["Source state", STATE[s.state]],
    ["Source job", s.jobId],
    ["Synthesis job", s.synthesisJobId],
    ["Item", s.itemOrdinal !== undefined ? `${s.itemOrdinal} (${s.customId}${s.sourceId ? `, source ID ${s.sourceId}` : ""})` : undefined],
    ["Source file", s.path],
    ["Source read from", s.files.join(", ")],
    ["Source SHA-256", s.sha256],
    ["Source items", s.items ? `${s.items.included} included, ${s.items.excluded} without a usable result` : undefined],
    ["Derived from", m.lineage.derivedFromArtifactId ? `${m.lineage.derivedFromArtifactId} (its output sha256 ${m.lineage.originOutputSha256})` : undefined],
    ["Origin job", s.jobId ? undefined : m.lineage.originJobId],
    ["Regenerated from", m.lineage.regeneratedFromArtifactId],
    ["Generation", `${m.lineage.generation}${m.lineage.previousArtifactId ? ` (previous at this path: ${m.lineage.previousArtifactId})` : ""}`],
    ["Template", m.template ? `${m.template.name} (${m.template.file}, sha256 ${m.template.sha256})` : undefined],
    ["Template input", m.template ? `sha256 ${m.template.inputSha256}` : undefined],
    ["Rendered source", m.intermediate ? `source.md, sha256 ${m.intermediate.sha256}, ${m.intermediate.characters} characters` : undefined],
    ["Renderer", `${m.renderer.name}${m.renderer.library ? ` (${m.renderer.library} ${m.renderer.version})` : ""}`],
    ["Destination", m.output ? `${m.output.path}${m.output.internal ? " (internal)" : ""}` : undefined],
    ["Output SHA-256", m.output?.sha256],
    ["Output size", m.output ? `${m.output.bytes} bytes${m.output.pages ? `, ${m.output.pages} page(s)` : ""}` : undefined],
    ["Replaced", m.replaced ? `an existing file with sha256 ${m.replaced.sha256} (--overwrite)` : undefined],
    ["Error", m.error],
  ];
  const lines = rows.filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `  ${k.padEnd(18)} ${v}`);
  for (const w of m.warnings) lines.push(`  ${"Warning".padEnd(18)} ${w}`);
  lines.push("", "  Hashes prove byte identity of the recorded files, not that their content is correct.");
  return lines;
}
