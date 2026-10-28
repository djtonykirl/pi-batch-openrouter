import * as fs from "node:fs";
import * as path from "node:path";
import type { BatchConfig } from "../config.js";
import { canonicalJson, isInside, sha256Hex, writeFileAtomicExclusive } from "../fsutil.js";
import { isUsable, itemText, jobItems, resolveItem, sourceLabel } from "../items.js";
import { ChatJobError, type BatchService } from "../service.js";
import { TERMINAL_STATUSES } from "../state.js";
import { nowIso } from "../time.js";
import { isChatJob, isDatasetWorkflow, type JobItem, type JobManifest } from "../types.js";
import type { WorkflowDefinition } from "../workflows/definition.js";
import { TemplateError } from "../workflows/template.js";
import { resolveWorkspaceInput, resolveWorkspaceOutput } from "../workspace-paths.js";
import { DEFAULT_EXTENSION, extensionProblem, isArtifactFormat, type ArtifactFormat } from "./formats.js";
import { HTML_RENDERER, markdownTitle, renderHtml } from "./render-html.js";
import { PDF_RENDERER, renderPdf, validatePdf } from "./render-pdf.js";
import { ArtifactStore, type ArtifactManifest, type ArtifactSource } from "./store.js";
import { applyTemplate, findTemplate } from "./templates.js";

/**
 * Controlled artifact generation.
 *
 *   UNTRUSTED: model output (validated text, or schema-validated JSON)
 *   ------------------------------- trust boundary -------------------------------
 *   TRUSTED:   template (local data), renderer (this process), destination (the
 *              user's command, trusted workflow configuration, or a fixed internal
 *              default), format and extension allowlist
 *
 * Model output can only ever become the CONTENT of a file. It never selects a
 * path, a renderer, a command, a URL or code. Nothing here calls OpenRouter or a
 * model: every artifact (and every regeneration) is rendered from stored results
 * or a local file. Retrieving a batch never creates an artifact; only an explicit
 * artifact command does.
 *
 * planX() resolves and checks everything and renders in memory WITHOUT writing;
 * execute() allocates the artifact, writes source.md and the destination
 * atomically (never replacing an existing file without `overwrite`), and records
 * provenance.
 */

export class ArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactError";
  }
}

export interface Renderers {
  html(markdown: string, title: string): string;
  pdf(markdown: string, title: string): Promise<{ bytes: Buffer; pages: number; warnings: string[] }>;
}

const VERSION = "pi-batch-openrouter";

const defaultRenderers: Renderers = {
  html: (md, title) => renderHtml(md, { title, generator: `${VERSION} (${HTML_RENDERER.library} ${HTML_RENDERER.version})` }),
  pdf: (md, title) => renderPdf(md, { title, producer: `${VERSION} (${PDF_RENDERER.library} ${PDF_RENDERER.version})` }),
};

export interface JobArtifactOptions {
  item?: string;
  synthesis?: boolean;
  allowPartial?: boolean;
  format?: string;
  template?: string;
  out?: string;
  overwrite?: boolean;
}

export interface RenderFileOptions {
  format: string;
  out?: string;
  overwrite?: boolean;
}

export interface ArtifactPlan {
  format: ArtifactFormat;
  source: ArtifactSource;
  template?: NonNullable<ArtifactManifest["template"]> & { bytes: Buffer };
  /** Markdown that is rendered (markdown/html/pdf); absent for text artifacts. */
  intermediate?: string;
  /** The final file bytes, already rendered and (for PDF) validated. */
  bytes: Buffer;
  pages?: number;
  /** Destination: a validated workspace path, or the artifact's internal folder. */
  destination: { kind: "out"; relPath: string; absPath: string; exists: boolean } | { kind: "internal" };
  overwrite: boolean;
  renderer: ArtifactManifest["renderer"];
  lineage: Omit<ArtifactManifest["lineage"], "generation" | "previousArtifactId">;
  warnings: string[];
  /** Where the destination came from (user, workflow default, internal default). */
  destinationOrigin: "command" | "workflow" | "internal";
}

export interface ArtifactDeps {
  batch: BatchService;
  workspaceRoot: string;
  getConfig(): BatchConfig;
  store: ArtifactStore;
  renderers?: Renderers;
}

export class ArtifactService {
  private readonly renderers: Renderers;

  constructor(private readonly deps: ArtifactDeps) {
    this.renderers = deps.renderers ?? defaultRenderers;
  }

  public get store(): ArtifactStore {
    return this.deps.store;
  }

  private rel(abs: string): string {
    return path.relative(fs.realpathSync.native(this.deps.workspaceRoot), abs).split(path.sep).join("/");
  }

  // ---------------------------------------------------------------- planning

  /** `/batch artifact <job>`: from the whole result, one item, or the newest ready synthesis. */
  public async planFromJob(jobRef: string, opts: JobArtifactOptions): Promise<ArtifactPlan> {
    const registry = this.deps.batch.registry;
    const jobId = registry.resolveId(jobRef);
    const job = registry.read(jobId);
    if (isChatJob(job)) throw new ChatJobError(`${job.localId} is a batch chat job; use /batch chat instead.`);
    if (opts.item && opts.synthesis) throw new ArtifactError("Use either --item or --synthesis, not both.");

    // Trusted workflow default (stored with the job, never the current file) when nothing explicit is given.
    const wfDefault = this.workflowDefault(job);
    const useDefault = !opts.format && !opts.template && !opts.out && wfDefault !== undefined;
    const formatName = opts.format ?? (useDefault ? wfDefault!.format : undefined);
    if (!formatName) throw new ArtifactError("Choose a format: --format markdown|html|pdf|text" + (wfDefault ? "" : " (this job's workflow declares no default artifact)"));
    if (!isArtifactFormat(formatName)) throw new ArtifactError(`Unknown format ${JSON.stringify(formatName)}; use markdown, html, pdf or text.`);
    const templateName = opts.template ?? (useDefault ? wfDefault!.template : undefined);
    const out = opts.out ?? (useDefault ? wfDefault!.filename : undefined);

    const src = this.resolveJobSource(job, opts);
    return this.plan({
      format: formatName,
      source: src.source,
      content: src.content,
      templateName,
      out,
      overwrite: opts.overwrite ?? false,
      title: `Batch ${job.localId}`,
      lineage: {},
      destinationOrigin: opts.out ? "command" : useDefault ? "workflow" : "internal",
    });
  }

  /** `/artifact render <file>`: a (possibly Pi/user-edited) local Markdown file. */
  public async planFromFile(file: string, opts: RenderFileOptions): Promise<ArtifactPlan> {
    const config = this.deps.getConfig();
    if (!isArtifactFormat(opts.format) || (opts.format !== "html" && opts.format !== "pdf")) {
      throw new ArtifactError("A local Markdown source renders to --format html or --format pdf.");
    }
    const r = resolveWorkspaceInput(this.deps.workspaceRoot, file, config, { what: "artifact source", maxBytes: config.context.maxFileBytes });
    if (!r.ok) throw new ArtifactError(r.message);
    if (!/\.(md|markdown)$/i.test(r.relPath)) throw new ArtifactError(`${r.relPath}: /artifact render takes a Markdown source (.md or .markdown).`);
    const bytes = fs.readFileSync(r.absPath);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new ArtifactError(`${r.relPath} is not valid UTF-8 text.`);
    }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const sha = sha256Hex(bytes);

    // Lineage: was this file written by an earlier artifact? Then say whether it changed since.
    const origin = this.store
      .list()
      .artifacts.find((a) => a.status === "rendered" && a.output && !a.output.internal && a.output.path === r.relPath && (a.format === "markdown" || a.format === "text"));
    const state: ArtifactSource["state"] = !origin ? "unlinked-local-file" : origin.output!.sha256 === sha ? "unmodified-generated-output" : "modified-after-generation";
    const lineage = origin
      ? { derivedFromArtifactId: origin.artifactId, originJobId: origin.source.jobId ?? origin.lineage.originJobId, originOutputSha256: origin.output!.sha256 }
      : {};
    return this.plan({
      format: opts.format,
      source: { type: "local-source-file", kind: "text", state, path: r.relPath, files: [r.relPath], sha256: sha },
      content: { kind: "text", text },
      out: opts.out,
      overwrite: opts.overwrite ?? false,
      title: path.basename(r.relPath),
      lineage,
      destinationOrigin: opts.out ? "command" : "internal",
      // A local file is rendered as written: no template.
    });
  }

  /** `/artifact regenerate <id>`: re-render the stored source.md of an earlier artifact. No model call. */
  public async planRegenerate(artifactRef: string, opts: { format?: string; out?: string; overwrite?: boolean }): Promise<ArtifactPlan> {
    const id = this.store.resolveId(artifactRef);
    const prev = this.store.read(id);
    if (!prev.intermediate) throw new ArtifactError(`${id} has no stored Markdown source (${prev.format} artifacts are written directly); render it again from its job instead.`);
    const srcPath = path.join(this.store.dir(id), "source.md");
    const md = fs.existsSync(srcPath) ? fs.readFileSync(srcPath, "utf8") : undefined;
    if (md === undefined || sha256Hex(md) !== prev.intermediate.sha256) throw new ArtifactError(`${id}: stored source.md is missing or no longer matches its recorded hash; refusing to regenerate.`);
    const format = opts.format ?? prev.format;
    if (!isArtifactFormat(format) || format === "text") throw new ArtifactError("Regenerate to --format markdown, html or pdf.");
    const plan = await this.plan({
      format,
      source: prev.source,
      content: { kind: "text", text: md },
      out: opts.out,
      overwrite: opts.overwrite ?? false,
      title: markdownTitle(md) ?? `Artifact ${id}`,
      lineage: { ...prev.lineage, regeneratedFromArtifactId: id },
      destinationOrigin: opts.out ? "command" : "internal",
    });
    if (prev.template) plan.template = { ...prev.template, bytes: fs.existsSync(path.join(this.store.dir(id), "template.yaml")) ? fs.readFileSync(path.join(this.store.dir(id), "template.yaml")) : Buffer.alloc(0) };
    return plan;
  }

  /**
   * A document generated locally from a job's validated results (no template, no model):
   * written through the same destination, overwrite, atomic-write and provenance rules.
   */
  public async planFromReport(p: { jobId: string; label: string; content: string; format: "markdown" | "text"; out?: string; overwrite?: boolean; files: string[]; warnings?: string[] }): Promise<ArtifactPlan> {
    const plan = await this.plan({
      format: p.format,
      source: { type: "batch-report", kind: "text", state: "batch-generated", jobId: p.jobId, files: p.files, sha256: sha256Hex(p.content) },
      content: { kind: "text", text: p.content },
      out: p.out,
      overwrite: p.overwrite ?? false,
      title: p.label,
      lineage: {},
      destinationOrigin: p.out ? "command" : "internal",
    });
    plan.renderer = { name: p.label };
    plan.warnings.push(...(p.warnings ?? []));
    return plan;
  }

  private workflowDefault(job: JobManifest): WorkflowDefinition["artifact"] | undefined {
    if (!isDatasetWorkflow(job.workflow)) return undefined;
    try {
      const stored = JSON.parse(fs.readFileSync(this.deps.batch.registry.artefact(job.localId, "workflowResolved"), "utf8")) as { definition: WorkflowDefinition };
      return stored.definition.artifact;
    } catch {
      return undefined;
    }
  }

  /** The artifact a finished job's workflow declares, for "available" hints. Never generated automatically. */
  public availableDefault(job: JobManifest): WorkflowDefinition["artifact"] | undefined {
    return job.localStatus === "ready" || job.localStatus === "partial" ? this.workflowDefault(job) : undefined;
  }

  private resolveJobSource(job: JobManifest, opts: JobArtifactOptions): { source: ArtifactSource; content: { kind: "text"; text: string } | { kind: "json"; data: unknown } } {
    const registry = this.deps.batch.registry;
    const rel = (p: string) => this.rel(p);
    if (opts.synthesis) {
      const syn = this.deps.batch.synthesisJobs(job.localId).find((j) => j.localStatus === "ready");
      if (!syn) {
        const any = this.deps.batch.synthesisJobs(job.localId)[0];
        throw new ArtifactError(any ? `The newest synthesis of ${job.localId} (${any.localId}) is ${any.localStatus}; only a ready synthesis can become an artifact.` : `No synthesis exists for ${job.localId}.`);
      }
      const it = jobItems(registry, syn)[0]!;
      const text = itemText(registry, syn, it);
      if (text === undefined) throw new ArtifactError(`${syn.localId} has no stored result text.`);
      const file = fs.existsSync(registry.itemArtefact(syn.localId, it.ordinal, "resultMd")) ? registry.itemArtefact(syn.localId, it.ordinal, "resultMd") : registry.artefact(syn.localId, "resultMd");
      return { source: { type: "synthesis", kind: "text", state: "batch-generated", jobId: job.localId, synthesisJobId: syn.localId, files: [rel(file)], sha256: sha256Hex(fs.readFileSync(file)) }, content: { kind: "text", text } };
    }
    const trusted = job.localStatus === "ready" || job.localStatus === "partial";
    if (!trusted) {
      throw new ArtifactError(`${job.localId} is ${job.localStatus}; artifacts are only made from validated results of ready (or partial) jobs.${TERMINAL_STATUSES.has(job.localStatus) ? "" : " Wait until it has finished."}`);
    }
    const items = jobItems(registry, job);
    if (opts.item) {
      const it = resolveItem(items, opts.item);
      if (!isUsable(it)) throw new ArtifactError(`${job.localId} item ${it.ordinal} (${sourceLabel(it)}) is ${it.status}; only a completed, validated item can become an artifact.`);
      return this.itemSource(job, it, "batch-item");
    }
    if (items.length === 1) return this.itemSource(job, items[0]!, "batch-result");
    const usable = items.filter(isUsable);
    if (usable.length < items.length && !opts.allowPartial) {
      throw new ArtifactError(`${job.localId} is ${job.localStatus}: ${items.length - usable.length} of ${items.length} item(s) have no usable result. Pass --allow-partial to make an artifact from the ${usable.length} usable item(s) (the gap is recorded), choose one with --item, or retry the failed items first.`);
    }
    if (job.format === "json") {
      const rows = usable.map((it) => {
        const p = registry.itemArtefact(job.localId, it.ordinal, "output");
        if (!fs.existsSync(p)) throw new ArtifactError(`${job.localId} item ${it.ordinal} has no stored parsed output (output.json).`);
        const obj = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
        return { source_id: it.source.sourceId ?? sourceLabel(it), ...obj };
      });
      const data = { items: rows };
      return {
        source: { type: "batch-result", kind: "json", state: "batch-generated", jobId: job.localId, files: usable.map((it) => rel(registry.itemArtefact(job.localId, it.ordinal, "output"))), sha256: sha256Hex(canonicalJson(data)), items: { included: usable.length, excluded: items.length - usable.length } },
        content: { kind: "json", data },
      };
    }
    // Text: the job's combined Markdown, or only the usable items' texts for an allowed partial.
    const parts = usable.map((it) => `## ${sourceLabel(it)}\n\n${itemText(registry, job, it)!.trimEnd()}\n`);
    const text = parts.join("\n");
    return {
      source: { type: "batch-result", kind: "text", state: "batch-generated", jobId: job.localId, files: usable.map((it) => rel(registry.itemArtefact(job.localId, it.ordinal, "resultMd"))), sha256: sha256Hex(text), items: { included: usable.length, excluded: items.length - usable.length } },
      content: { kind: "text", text },
    };
  }

  private itemSource(job: JobManifest, it: JobItem, type: "batch-item" | "batch-result"): { source: ArtifactSource; content: { kind: "text"; text: string } | { kind: "json"; data: unknown } } {
    const registry = this.deps.batch.registry;
    const base = { type, state: "batch-generated" as const, jobId: job.localId, itemOrdinal: it.ordinal, customId: it.customId, ...(it.source.sourceId ? { sourceId: it.source.sourceId } : {}) };
    const out = registry.itemArtefact(job.localId, it.ordinal, "output");
    if (job.format === "json" && fs.existsSync(out)) {
      const bytes = fs.readFileSync(out);
      return { source: { ...base, kind: "json", files: [this.rel(out)], sha256: sha256Hex(bytes) }, content: { kind: "json", data: JSON.parse(bytes.toString("utf8")) } };
    }
    const text = itemText(registry, job, it);
    if (text === undefined) throw new ArtifactError(`${job.localId} item ${it.ordinal} has no stored result text.`);
    const file = fs.existsSync(registry.itemArtefact(job.localId, it.ordinal, "resultMd")) ? registry.itemArtefact(job.localId, it.ordinal, "resultMd") : registry.artefact(job.localId, "resultMd");
    return { source: { ...base, kind: "text", files: [this.rel(file)], sha256: sha256Hex(fs.readFileSync(file)) }, content: { kind: "text", text } };
  }

  private resolveOut(format: ArtifactFormat, out: string | undefined, overwrite: boolean): ArtifactPlan["destination"] {
    if (out === undefined) return { kind: "internal" };
    const r = resolveWorkspaceOutput(this.deps.workspaceRoot, out);
    if (!r.ok) throw new ArtifactError(`Refused: ${r.message}. Nothing was written.`);
    if (r.relPath === ".pi" || r.relPath.startsWith(".pi/")) throw new ArtifactError(`Refused: ${r.relPath} is inside .pi/ (extension state and configuration). Choose a workspace path such as reports/…`);
    const ext = extensionProblem(format, r.relPath);
    if (ext) throw new ArtifactError(`Refused: ${ext}.`);
    if (r.exists && !overwrite) throw new ArtifactError(`Refused: ${r.relPath} already exists. Nothing was written (use --overwrite to replace it; the replaced file's hash is recorded).`);
    return { kind: "out", relPath: r.relPath, absPath: r.absPath, exists: r.exists };
  }

  private async plan(p: {
    format: ArtifactFormat;
    source: ArtifactSource;
    content: { kind: "text"; text: string } | { kind: "json"; data: unknown };
    templateName?: string;
    out?: string;
    overwrite: boolean;
    title: string;
    lineage: ArtifactPlan["lineage"];
    destinationOrigin: ArtifactPlan["destinationOrigin"];
  }): Promise<ArtifactPlan> {
    const destination = this.resolveOut(p.format, p.out, p.overwrite);
    const warnings: string[] = [];
    if (p.source.items && p.source.items.excluded > 0) warnings.push(`partial source: ${p.source.items.excluded} item(s) without a usable result are not included`);

    // ---- text: the content itself, unchanged (no template, no renderer)
    if (p.format === "text") {
      if (p.templateName) throw new ArtifactError("--format text writes the source content unchanged; templates apply to markdown, html and pdf.");
      const relOrDefault = destination.kind === "out" ? destination.relPath : p.content.kind === "json" ? "x.json" : "x.txt";
      let body: string;
      if (p.content.kind === "json") {
        if (!/\.json$/i.test(relOrDefault)) throw new ArtifactError("Structured (JSON) content is written as text only to a .json file.");
        body = JSON.stringify(p.content.data, null, 2) + "\n";
      } else {
        body = p.content.text.endsWith("\n") ? p.content.text : p.content.text + "\n";
        if (/\.json$/i.test(relOrDefault)) {
          try {
            JSON.parse(body);
          } catch {
            throw new ArtifactError("The source text is not valid JSON, so it cannot be written as a .json file.");
          }
        }
      }
      return { format: "text", source: p.source, bytes: Buffer.from(body, "utf8"), destination, overwrite: p.overwrite, renderer: { name: "text-copy" }, lineage: p.lineage, warnings, destinationOrigin: p.destinationOrigin };
    }

    // ---- markdown / html / pdf: Markdown first (template, or the source text as is)
    let markdown: string;
    let template: ArtifactPlan["template"];
    if (p.templateName) {
      const entry = findTemplate(this.deps.workspaceRoot, p.templateName);
      if (!entry.valid || !entry.template) throw new ArtifactError(`Artifact template ${entry.name} is invalid:\n${entry.diagnostics.map((d) => `  ${d.file}${d.path ? ` [${d.path}]` : ""}: ${d.message}`).join("\n")}`);
      let rendered;
      try {
        rendered = applyTemplate(entry.template, p.content);
      } catch (err) {
        if (err instanceof TemplateError) throw new ArtifactError(`Template ${entry.name}: ${err.message}`);
        throw err;
      }
      markdown = rendered.markdown;
      const bytes = fs.readFileSync(path.join(this.deps.workspaceRoot, ...entry.file.split("/")));
      template = { name: entry.name, file: entry.file, sha256: sha256Hex(bytes), inputSha256: rendered.inputSha256, bytes };
    } else {
      if (p.content.kind === "json") throw new ArtifactError("This source is structured JSON: choose a template (--template <name>) that lays it out, or use --format text with a .json destination.");
      markdown = p.content.text.endsWith("\n") ? p.content.text : p.content.text + "\n";
    }
    const title = markdownTitle(markdown) ?? p.title;

    if (p.format === "markdown") {
      return { format: "markdown", source: p.source, template, intermediate: markdown, bytes: Buffer.from(markdown, "utf8"), destination, overwrite: p.overwrite, renderer: { name: p.templateName ? "template-to-markdown" : "markdown-copy" }, lineage: p.lineage, warnings, destinationOrigin: p.destinationOrigin };
    }
    if (p.format === "html") {
      const html = this.renderers.html(markdown, title);
      return { format: "html", source: p.source, template, intermediate: markdown, bytes: Buffer.from(html, "utf8"), destination, overwrite: p.overwrite, renderer: { ...HTML_RENDERER }, lineage: p.lineage, warnings, destinationOrigin: p.destinationOrigin };
    }
    let pdf: { bytes: Buffer; pages: number; warnings: string[] };
    try {
      pdf = await this.renderers.pdf(markdown, title);
    } catch (err) {
      throw new ArtifactError(`PDF rendering failed; nothing was written: ${(err as Error).message}`);
    }
    const check = validatePdf(pdf.bytes);
    if (!check.ok) throw new ArtifactError(`The renderer produced an invalid PDF (${check.reason}); nothing was written.`);
    warnings.push(...pdf.warnings);
    return { format: "pdf", source: p.source, template, intermediate: markdown, bytes: pdf.bytes, pages: check.pages, destination, overwrite: p.overwrite, renderer: { ...PDF_RENDERER }, lineage: p.lineage, warnings, destinationOrigin: p.destinationOrigin };
  }

  // ---------------------------------------------------------------- execution

  public execute(plan: ArtifactPlan): ArtifactManifest {
    const store = this.store;
    const id = store.allocate();
    const ext = plan.destination.kind === "out" ? path.extname(plan.destination.relPath) : plan.format === "text" ? (plan.source.kind === "json" ? ".json" : ".txt") : DEFAULT_EXTENSION[plan.format];
    const absPath = plan.destination.kind === "out" ? plan.destination.absPath : path.join(store.dir(id), `rendered${ext}`);
    const relPath = this.rel(absPath);
    const previous = store.list().artifacts.find((a) => a.status === "rendered" && a.output?.path === relPath);
    const manifest: ArtifactManifest = {
      schemaVersion: 1,
      artifactId: id,
      status: "failed",
      format: plan.format,
      createdAt: nowIso(),
      source: plan.source,
      lineage: { generation: previous ? previous.lineage.generation + 1 : 1, ...(previous ? { previousArtifactId: previous.artifactId } : {}), ...plan.lineage },
      ...(plan.template ? { template: { name: plan.template.name, file: plan.template.file, sha256: plan.template.sha256, inputSha256: plan.template.inputSha256 } } : {}),
      renderer: plan.renderer,
      warnings: [...plan.warnings],
    };
    try {
      if (plan.intermediate !== undefined) {
        store.writeFile(id, "source.md", plan.intermediate);
        manifest.intermediate = { file: "source.md", sha256: sha256Hex(plan.intermediate), characters: plan.intermediate.length };
      }
      if (plan.template && plan.template.bytes.length > 0) store.writeFile(id, "template.yaml", plan.template.bytes);
      let replaced: string | undefined;
      if (fs.existsSync(absPath)) {
        if (!plan.overwrite) throw new ArtifactError(`${relPath} already exists; nothing was written (use --overwrite).`);
        replaced = sha256Hex(fs.readFileSync(absPath));
      }
      // Re-check containment at write time (the parent may have been replaced by a link since planning).
      if (plan.destination.kind === "out") {
        const again = resolveWorkspaceOutput(this.deps.workspaceRoot, plan.destination.relPath);
        if (!again.ok || !isInside(fs.realpathSync.native(this.deps.workspaceRoot), again.absPath)) throw new ArtifactError(`Refused at write time: ${again.ok ? relPath : again.message}`);
      }
      writeFileAtomicExclusive(absPath, plan.bytes, plan.overwrite);
      manifest.status = "rendered";
      manifest.output = { path: relPath, sha256: sha256Hex(plan.bytes), bytes: plan.bytes.length, ...(plan.pages ? { pages: plan.pages } : {}), internal: plan.destination.kind === "internal" };
      if (replaced) manifest.replaced = { sha256: replaced };
      store.save(manifest, "rendered", { output: relPath, sha256: manifest.output.sha256, overwrote: replaced !== undefined });
      return manifest;
    } catch (err) {
      manifest.error = (err as Error).message;
      store.save(manifest, "failed", { error: manifest.error });
      throw err instanceof ArtifactError ? err : new ArtifactError(`Writing the artifact failed: ${(err as Error).message}`);
    }
  }

  public list(filter: { jobId?: string } = {}): ArtifactManifest[] {
    return this.store.list().artifacts.filter((a) => !filter.jobId || a.source.jobId === filter.jobId || a.lineage.originJobId === filter.jobId);
  }
}
