import * as fs from "node:fs";
import * as path from "node:path";
import type { BatchConfig } from "./config.js";
import { buildContextPackage, SYSTEM_PROMPT, type ContextPackage, type PackageInput } from "./context/package.js";
import { formatSecretFindings, scanForSecrets } from "./context/secrets.js";
import { atomicWriteFile, atomicWriteJson, canonicalJson, sha256Hex, writeOnce, writeOnceUnlessIdentical } from "./fsutil.js";
import { customIdFor, customIdProblems } from "./ids.js";
import { combinedCoverage, isUsable, itemText, jobItems, resolveItem, sourceLabel, type Coverage } from "./items.js";
import { nullLogger, type Logger } from "./logger.js";
import { normalizeBatchModelSlug } from "./models.js";
import { OpenRouterBatchClient, OpenRouterError, type RawExchange } from "./openrouter/client.js";
import { normaliseBatchResult, type NormalisedBatchResult } from "./openrouter/normalise-result.js";
import { buildSubmitBody, submitBodyProblems, type BatchRequestItem, type ChatMessage, type ProviderPin, type SubmitBody } from "./openrouter/types.js";
import { compileOutputSchema, type OutputValidator } from "./workflows/structured.js";
import { findWorkflow, formatDiagnostics, type WorkflowDefinition, type WorkflowEntry } from "./workflows/definition.js";
import { planDatasetRun, type DatasetPlan, type EffectiveLimits } from "./workflows/dataset-run.js";
import { resolveWorkspaceInput, resolveWorkspaceOutput } from "./workspace-paths.js";
import { decodeDatasetBytes } from "./datasets/dataset.js";
import { proposalProblems, type TableEvidence } from "./metadata/contract.js";
import { METADATA_WORKFLOW, planMetadataRun, type MetadataPlan } from "./metadata/plan.js";
import { buildExportRows, toCsv, toJsonl, writeExport } from "./export.js";
import { inventoryLegacyJobs, type LegacyInventory } from "./legacy.js";
import { ARTEFACTS, JobRegistry, JobUpdate } from "./registry.js";
import { ACTIVE_STATUSES, POLLABLE_STATUSES, TERMINAL_STATUSES, type LocalStatus } from "./state.js";
import { formatIsoShort, isoToEpochMs, nowIso, parseProviderTimestamp } from "./time.js";
import {
  CHAT_MANIFEST_SCHEMA_VERSION,
  DATASET_MANIFEST_SCHEMA_VERSION,
  MANIFEST_SCHEMA_VERSION,
  isChatJob,
  isDatasetWorkflow,
  isMetadataWorkflow,
  type ChatLinkage,
  type DatasetSelection,
  type DatasetWorkflowInfo,
  type ExportRecord,
  type ItemSource,
  type JobItem,
  type JobKind,
  type JobManifest,
  type MapFilesWorkflowInfo,
  type MetadataWorkflowInfo,
  type SynthesisLinkage,
  type WorkflowInfo,
} from "./types.js";
import { MAP_FILES, groupFiles, renderMapFilesPrompt } from "./workflows/map-files.js";
import { coverageFacts, renderCoverage, renderSynthesisPrompt, synthesisMessages, type CoverageFacts, type SynthesisInputItem, type SynthesisUnusable } from "./workflows/synthesis.js";

export interface AskOptions {
  objective: string;
  files: string[];
  contexts: string[];
  model?: string;
  account?: string;
  /** Upstream provider slug to pin via `provider.only` (with allow_fallbacks: false). */
  providerPin?: string;
  format: "markdown" | "json";
  includeInstructions: boolean;
}

export interface PreparedAsk {
  options: AskOptions;
  model: string;
  account: string;
  pin?: ProviderPin;
  pkg: ContextPackage;
  messages: ChatMessage[];
  contentSha256: string;
  /** Reasons the request must not be submitted (empty = OK). */
  blockers: string[];
}

export interface MapFilesOptions {
  objective: string;
  files: string[];
  contexts: string[];
  /** 1 (default) = one request per file. */
  groupSize?: number;
  model?: string;
  account?: string;
  providerPin?: string;
  format: "markdown" | "json";
  includeInstructions: boolean;
}

export interface PlannedItem {
  ordinal: number;
  source: ItemSource;
  prompt: string;
  characters: number;
  messages: ChatMessage[];
}

export interface PreparedPlan {
  workflow: MapFilesWorkflowInfo;
  options: MapFilesOptions;
  model: string;
  account: string;
  pin?: ProviderPin;
  pkg: ContextPackage;
  items: PlannedItem[];
  totalCharacters: number;
  largest?: { characters: number; label: string };
  contentSha256: string;
  blockers: string[];
}

export interface SynthesisOptions {
  allowPartial: boolean;
  model?: string;
  account?: string;
  providerPin?: string;
}

export interface PreparedSynthesis {
  sourceJobId: string;
  model: string;
  account: string;
  pin?: ProviderPin;
  coverage: CoverageFacts;
  linkage: SynthesisLinkage;
  prompt: string;
  characters: number;
  contentSha256: string;
  blockers: string[];
}

export interface DatasetRunOptions {
  /** Project workflow name (.pi/batch-workflows/<name>.yaml). */
  workflow: string;
  /** Workspace-relative dataset path. */
  input: string;
  ids?: string[];
  fromRow?: number;
  toRow?: number;
  model?: string;
  account?: string;
  /** Upstream provider pin; overrides the workflow's model.provider. */
  providerPin?: string;
}

export interface PreparedDatasetRun {
  options: DatasetRunOptions;
  /** The catalog entry, valid or not (diagnostics are blockers). */
  entry?: WorkflowEntry;
  definition?: WorkflowDefinition;
  model: string;
  account: string;
  pin?: ProviderPin;
  maxTokens: number;
  limits: EffectiveLimits;
  plan?: DatasetPlan;
  objective: string;
  contentSha256: string;
  blockers: string[];
  warnings: string[];
}

export interface MetadataRunOptions {
  context: string;
  input: string;
  model?: string;
  account?: string;
  providerPin?: string;
}

export interface PreparedMetadataRun {
  options: MetadataRunOptions;
  model: string;
  account: string;
  pin?: ProviderPin;
  maxTokens: number;
  plan?: MetadataPlan;
  context?: { relPath: string; bytes: number; text: string };
  input?: { relPath: string; bytes: number };
  objective: string;
  contentSha256: string;
  blockers: string[];
  warnings: string[];
}

export interface StoredMetadataPlan {
  workflow: typeof METADATA_WORKFLOW;
  context: MetadataWorkflowInfo["context"];
  input: MetadataWorkflowInfo["input"];
  planSha256: string;
  tables: Array<{ ordinal: number; customId: string; table: string; line: number; inputSha256: string; requestSha256: string; hasSamples: boolean; evidence: TableEvidence }>;
  createdAt: string;
}

export class SubmissionBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubmissionBlockedError";
  }
}

export class ChatJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatJobError";
  }
}

export class DuplicateActiveRequestError extends Error {
  constructor(public readonly existingId: string) {
    super(`An identical active request already exists:\n  ${existingId}\n\nUse /batch show ${existingId}\n(Use /batch retry ${existingId} to deliberately run it again.)`);
    this.name = "DuplicateActiveRequestError";
  }
}

export type ReadMode = "default" | "full" | "raw";
export type InjectMode = "default" | "summary" | "full";

export interface ServiceDeps {
  registry: JobRegistry;
  workspaceRoot: string;
  getConfig(): BatchConfig;
  resolveApiKey(account: string): Promise<string>;
  createClient?: (apiKey: string, timeoutMs: number) => OpenRouterBatchClient;
  logger?: Logger;
  /** Called after any reconcile that moved a job into a terminal (or ready/partial) state. */
  onSettled?: (job: JobManifest) => void;
  /** For packaging tests only. */
  gitIgnored?: PackageInput["gitIgnored"];
}

export interface ReconcileOutcome {
  localId: string;
  status: LocalStatus;
  polled: boolean;
  skipped?: "not_due" | "locked" | "not_pollable";
  error?: string;
}

/** Everything needed to persist one job; every creation path (ask, workflow, retry, synthesis) goes through it. */
interface JobDraft {
  kind: JobKind;
  objective: string;
  model: string;
  account: string;
  pin?: ProviderPin;
  format: "markdown" | "json";
  items: Array<{
    source: ItemSource;
    body: BatchRequestItem["body"];
    characters: number;
    prompt: string;
    replaces?: JobItem["replaces"];
    inputSha256?: string;
    /** Extra fields for request/items/NNN/metadata.json (e.g. the selected dataset values). */
    metadata?: Record<string, unknown>;
  }>;
  /** Defaults to MANIFEST_SCHEMA_VERSION; dataset jobs (and their retries) use DATASET_MANIFEST_SCHEMA_VERSION. */
  schemaVersion?: JobManifest["schemaVersion"];
  context: JobManifest["context"];
  warnings: string[];
  parentJobId?: string;
  retryCount: number;
  retryMode?: JobManifest["retryMode"];
  workflow?: WorkflowInfo;
  synthesis?: SynthesisLinkage;
  chat?: ChatLinkage;
  /** Extra request artefacts (objective, context, manifests, plan, linkage). */
  writeArtefacts(localId: string, customIds: string[], itemShas: string[]): void;
  previewDetails: Record<string, unknown>;
}

/** Statuses a reconcile pass visits: pollable ones plus crash-recovery states. */
const RECONCILE_STATUSES: ReadonlySet<LocalStatus> = new Set<LocalStatus>([...POLLABLE_STATUSES, "draft", "submitting", "retrieving"]);
/** A job stuck in draft/submitting this long with no lock holder was interrupted by a crash. */
const INTERRUPTED_AFTER_MS = 30_000;
/** Poll interval while an explicit user check waits for another check's lock. */
const LOCK_RETRY_MS = 250;
/** How long `/batch check <id>` waits for an in-flight check before reporting "busy". */
export const CHECK_LOCK_WAIT_MS = 10_000;

export class BatchService {
  private readonly logger: Logger;

  constructor(private readonly deps: ServiceDeps) {
    this.logger = deps.logger ?? nullLogger;
  }

  public get registry(): JobRegistry {
    return this.deps.registry;
  }

  public get workspaceRoot(): string {
    return this.deps.workspaceRoot;
  }

  private client(apiKey: string): OpenRouterBatchClient {
    const timeoutMs = this.deps.getConfig().polling.requestTimeoutSeconds * 1000;
    return this.deps.createClient ? this.deps.createClient(apiKey, timeoutMs) : new OpenRouterBatchClient({ apiKey, timeoutMs });
  }

  public async knownSecrets(account: string): Promise<string[]> {
    const out = new Set<string>();
    const env = process.env.OPENROUTER_API_KEY;
    if (env) out.add(env);
    try {
      const key = await this.deps.resolveApiKey(account);
      if (key) out.add(key);
    } catch {
      // no key resolvable; nothing extra to protect
    }
    return [...out];
  }

  private assertNotChat(job: Pick<JobManifest, "kind" | "localId">): void {
    if (isChatJob(job)) throw new ChatJobError(`${job.localId} is a batch chat job; use /batch chat instead.`);
  }

  private requestBody(messages: ChatMessage[]): BatchRequestItem["body"] {
    return { messages, max_tokens: this.deps.getConfig().request.maxTokens };
  }

  // ------------------------------------------------------------------ ask

  public async prepare(options: AskOptions): Promise<PreparedAsk> {
    const config = this.deps.getConfig();
    const objective = options.objective.trim();
    const model = normalizeBatchModelSlug(options.model ?? config.defaultModel);
    const account = options.account ?? config.defaultAccount;
    const pin: ProviderPin | undefined = options.providerPin ? { only: [options.providerPin], allow_fallbacks: false } : undefined;
    const pkg = buildContextPackage({
      workspaceRoot: this.deps.workspaceRoot,
      objective,
      files: options.files,
      contexts: options.contexts,
      includeInstructions: options.includeInstructions,
      format: options.format,
      config,
      knownSecrets: await this.knownSecrets(account),
      gitIgnored: this.deps.gitIgnored,
    });
    const messages = withSystemPrompt(options.includeInstructions, pkg.contextText);

    const blockers: string[] = [];
    if (!objective) blockers.push("objective is empty");
    for (const p of pkg.problems) blockers.push(p.message);
    if (pkg.secretFindings.length > 0 && config.security.blockOnSecret) blockers.push(formatSecretFindings(pkg.secretFindings));

    const contentSha256 = contentHash(buildSubmitBody({ model, provider: pin, requests: [{ custom_id: "{custom_id}", body: this.requestBody(messages) }] }));
    return { options, model, account, pin, pkg, messages, contentSha256, blockers };
  }

  public findActiveDuplicate(contentSha256: string, excludeId?: string): JobManifest | undefined {
    return this.registry
      .list()
      .jobs.find((j) => j.localId !== excludeId && j.contentSha256 === contentSha256 && ACTIVE_STATUSES.has(j.localStatus));
  }

  /**
   * Persist the prepared request as a job (draft -> previewed) and, unless
   * `previewOnly`, submit it. Nothing is persisted if the package is blocked.
   */
  public async createJob(prepared: PreparedAsk, opts: { previewOnly: boolean }): Promise<JobManifest> {
    if (prepared.blockers.length > 0) throw new SubmissionBlockedError(prepared.blockers.join("\n\n"));
    this.assertNoActiveDuplicate(prepared.contentSha256, opts.previewOnly);
    const config = this.deps.getConfig();
    const { pkg } = prepared;
    const objective = prepared.options.objective.trim();
    const job = this.persistJob({
      kind: "goal",
      objective,
      model: prepared.model,
      account: prepared.account,
      pin: prepared.pin,
      format: prepared.options.format,
      items: [
        {
          source: { kind: "goal", ...(pkg.files.length ? { paths: pkg.files.map((f) => f.relPath) } : {}) },
          body: this.requestBody(prepared.messages),
          characters: pkg.characters,
          prompt: pkg.contextText,
        },
      ],
      context: { fileCount: pkg.files.length, characters: pkg.characters, excludedCount: pkg.excluded.length },
      warnings: [...pkg.warnings],
      retryCount: 0,
      writeArtefacts: (localId) => {
        atomicWriteFile(this.registry.artefact(localId, "objective"), objective + "\n");
        atomicWriteFile(this.registry.artefact(localId, "context"), pkg.contextText);
        atomicWriteJson(this.registry.artefact(localId, "contextManifest"), this.contextManifest(pkg, config, prepared.options.includeInstructions, prepared.options.format));
      },
      previewDetails: { files: pkg.files.length, characters: pkg.characters },
    });
    if (opts.previewOnly) return job;
    return this.submit(job.localId, { skipDuplicateCheck: true });
  }

  private assertNoActiveDuplicate(contentSha256: string, previewOnly: boolean): void {
    if (previewOnly) return;
    const dup = this.findActiveDuplicate(contentSha256);
    if (dup) throw new DuplicateActiveRequestError(dup.localId);
  }

  private contextManifest(pkg: ContextPackage, config: BatchConfig, includeInstructions: boolean, format: "markdown" | "json"): Record<string, unknown> {
    return {
      workspaceRoot: this.deps.workspaceRoot,
      files: pkg.files.map(({ content: _c, ...rest }) => rest),
      excluded: pkg.excluded,
      warnings: pkg.warnings,
      characters: pkg.characters,
      secretScan: { enabled: config.security.scanSecrets, findings: pkg.secretFindings.length },
      includeInstructions,
      format,
    };
  }

  /**
   * The single persistence path: allocates the local ID, derives provider-safe
   * custom_ids, validates the exact payload, writes the request artefacts
   * (whole-batch and per-item), then the manifest (draft -> previewed).
   * Throws before anything is written if the payload is invalid.
   */
  private persistJob(draft: JobDraft): JobManifest {
    const job = this.registry.create((localId) => {
      const customIds = draft.items.map((_, i) => customIdFor(localId, i));
      const body = buildSubmitBody({
        model: draft.model,
        provider: draft.pin,
        requests: draft.items.map((it, i) => ({ custom_id: customIds[i]!, body: it.body })),
      });
      const problems = [...customIdProblems(customIds), ...submitBodyProblems(body)];
      if (problems.length > 0) {
        fs.rmSync(this.registry.jobDir(localId), { recursive: true, force: true });
        throw new SubmissionBlockedError(`Request validation failed:\n- ${problems.join("\n- ")}`);
      }
      const bodyText = JSON.stringify(body, null, 2);
      const requestSha256 = sha256Hex(bodyText);
      const itemShas = draft.items.map((it) => sha256Hex(canonicalJson(it.body)));
      atomicWriteFile(this.registry.artefact(localId, "submittedRequest"), bodyText);
      atomicWriteFile(this.registry.artefact(localId, "requestSha"), `${requestSha256}  submitted-request.json\n`);
      draft.items.forEach((it, i) => {
        const ordinal = i + 1;
        const requestText = JSON.stringify(body.requests[i], null, 2) + "\n";
        atomicWriteFile(this.registry.itemArtefact(localId, ordinal, "request"), requestText);
        atomicWriteFile(this.registry.itemArtefact(localId, ordinal, "requestSha"), `${itemShas[i]}  request body (canonical JSON, custom_id excluded)\n`);
        atomicWriteFile(this.registry.itemArtefact(localId, ordinal, "prompt"), it.prompt.endsWith("\n") ? it.prompt : it.prompt + "\n");
        atomicWriteJson(this.registry.itemArtefact(localId, ordinal, "metadata"), {
          ordinal,
          customId: customIds[i],
          source: it.source,
          characters: it.characters,
          requestSha256: itemShas[i],
          ...(it.inputSha256 ? { inputSha256: it.inputSha256 } : {}),
          ...(it.replaces ? { replaces: it.replaces } : {}),
          ...(it.metadata ?? {}),
        });
      });
      draft.writeArtefacts(localId, customIds, itemShas);
      return {
        schemaVersion: draft.schemaVersion ?? MANIFEST_SCHEMA_VERSION,
        localId,
        kind: draft.kind,
        ...(draft.parentJobId ? { parentJobId: draft.parentJobId } : {}),
        retryCount: draft.retryCount,
        ...(draft.retryMode ? { retryMode: draft.retryMode } : {}),
        objective: draft.objective,
        model: draft.model,
        provider: "openrouter",
        account: draft.account,
        ...(draft.pin ? { providerPin: draft.pin } : {}),
        endpoint: "/v1/chat/completions",
        format: draft.format,
        localStatus: "draft",
        requestCount: customIds.length,
        customIds,
        items: draft.items.map((it, i) => ({
          customId: customIds[i]!,
          ordinal: i + 1,
          source: it.source,
          requestSha256: itemShas[i],
          characters: it.characters,
          ...(it.inputSha256 ? { inputSha256: it.inputSha256 } : {}),
          status: "planned" as const,
          ...(it.replaces ? { replaces: it.replaces } : {}),
        })),
        ...(draft.workflow ? { workflow: draft.workflow } : {}),
        ...(draft.synthesis ? { synthesis: draft.synthesis } : {}),
        ...(draft.chat ? { chat: draft.chat } : {}),
        createdAt: nowIso(),
        pollAttempts: 0,
        consecutivePollFailures: 0,
        requestSha256,
        contentSha256: contentHash(body),
        context: draft.context,
        injectionCount: 0,
        warnings: draft.warnings,
      };
    });
    const previewed = this.registry.update(job.localId, (u) => {
      u.transition("previewed", draft.previewDetails);
      return u.manifest;
    });
    this.logger.log("info", "job_created", { localId: job.localId, kind: draft.kind, requests: job.requestCount, ...draft.previewDetails });
    return previewed;
  }

  // ------------------------------------------------------------ map-files

  /** Builds and checks a map-files plan. Nothing is persisted; `blockers` must be empty to create a job. */
  public async planMapFiles(options: MapFilesOptions): Promise<PreparedPlan> {
    const config = this.deps.getConfig();
    const limits = config.workflows;
    const objective = options.objective.trim();
    const model = normalizeBatchModelSlug(options.model ?? config.defaultModel);
    const account = options.account ?? config.defaultAccount;
    const pin: ProviderPin | undefined = options.providerPin ? { only: [options.providerPin], allow_fallbacks: false } : undefined;
    const groupSize = options.groupSize ?? 1;
    const workflow: MapFilesWorkflowInfo = { name: MAP_FILES.name, version: MAP_FILES.version, options: { groupSize, format: options.format, includeInstructions: options.includeInstructions } };

    const pkg = buildContextPackage({
      workspaceRoot: this.deps.workspaceRoot,
      objective,
      files: options.files,
      contexts: options.contexts,
      includeInstructions: options.includeInstructions,
      format: options.format,
      config,
      knownSecrets: await this.knownSecrets(account),
      gitIgnored: this.deps.gitIgnored,
      renderPackage: false,
    });

    const blockers: string[] = [];
    if (!objective) blockers.push("objective is empty");
    if (!Number.isInteger(groupSize) || groupSize < 1) blockers.push(`--group-size must be a positive integer (got ${options.groupSize})`);
    for (const p of pkg.problems) blockers.push(p.message);
    if (pkg.secretFindings.length > 0 && config.security.blockOnSecret) blockers.push(formatSecretFindings(pkg.secretFindings));
    if (pkg.files.length === 0 && pkg.problems.length === 0) blockers.push("no files selected (use --file <path> or --context <dir>)");

    const items: PlannedItem[] = [];
    if (Number.isInteger(groupSize) && groupSize >= 1) {
      for (const [i, group] of groupFiles(pkg.files, groupSize).entries()) {
        const prompt = renderMapFilesPrompt(objective, group, { format: options.format, includeInstructions: options.includeInstructions });
        const source: ItemSource = group.length === 1 ? { kind: "file", path: group[0]!.relPath } : { kind: "group", paths: group.map((f) => f.relPath) };
        items.push({ ordinal: i + 1, source, prompt, characters: prompt.length, messages: withSystemPrompt(options.includeInstructions, prompt) });
      }
    }
    const totalCharacters = items.reduce((n, it) => n + it.characters, 0);
    const largestItem = items.reduce<PlannedItem | undefined>((a, b) => (!a || b.characters > a.characters ? b : a), undefined);
    if (items.length > limits.maxRequestsPerBatch) {
      blockers.push(`plan has ${items.length} requests; workflows.maxRequestsPerBatch is ${limits.maxRequestsPerBatch} (local policy)`);
    }
    for (const it of items) {
      if (it.characters > limits.maxCharactersPerItem) {
        blockers.push(`item ${it.ordinal} (${sourceLabel(it)}) is ${it.characters} characters; workflows.maxCharactersPerItem is ${limits.maxCharactersPerItem} (local policy)`);
      }
    }
    if (totalCharacters > limits.maxTotalCharacters) {
      blockers.push(`plan totals ${totalCharacters} characters; workflows.maxTotalCharacters is ${limits.maxTotalCharacters} (local policy)`);
    }

    const contentSha256 = contentHash(
      buildSubmitBody({ model, provider: pin, requests: items.map((it) => ({ custom_id: "{custom_id}", body: this.requestBody(it.messages) })) }),
    );
    return {
      workflow,
      options,
      model,
      account,
      pin,
      pkg,
      items,
      totalCharacters,
      ...(largestItem ? { largest: { characters: largestItem.characters, label: sourceLabel(largestItem) } } : {}),
      contentSha256,
      blockers,
    };
  }

  public async createWorkflowJob(plan: PreparedPlan, opts: { previewOnly: boolean }): Promise<JobManifest> {
    if (plan.blockers.length > 0) throw new SubmissionBlockedError(plan.blockers.join("\n\n"));
    this.assertNoActiveDuplicate(plan.contentSha256, opts.previewOnly);
    const config = this.deps.getConfig();
    const objective = plan.options.objective.trim();
    const job = this.persistJob({
      kind: "workflow",
      objective,
      model: plan.model,
      account: plan.account,
      pin: plan.pin,
      format: plan.options.format,
      items: plan.items.map((it) => ({ source: it.source, body: this.requestBody(it.messages), characters: it.characters, prompt: it.prompt })),
      context: { fileCount: plan.pkg.files.length, characters: plan.totalCharacters, excludedCount: plan.pkg.excluded.length },
      warnings: [...plan.pkg.warnings],
      retryCount: 0,
      workflow: plan.workflow,
      writeArtefacts: (localId, customIds, itemShas) => {
        atomicWriteFile(this.registry.artefact(localId, "objective"), objective + "\n");
        atomicWriteJson(this.registry.artefact(localId, "contextManifest"), {
          ...this.contextManifest(plan.pkg, config, plan.options.includeInstructions, plan.options.format),
          characters: plan.totalCharacters,
        });
        atomicWriteJson(this.registry.artefact(localId, "plan"), {
          workflow: plan.workflow,
          objective,
          model: plan.model,
          account: plan.account,
          providerPin: plan.pin ?? null,
          format: plan.options.format,
          includeInstructions: plan.options.includeInstructions,
          totals: {
            requests: plan.items.length,
            selectedFiles: plan.pkg.files.length,
            characters: plan.totalCharacters,
            largestItem: plan.largest ?? null,
            excludedFiles: plan.pkg.excluded.length,
            blockedFiles: 0,
          },
          limits: config.workflows,
          items: plan.items.map((it, i) => ({ ordinal: it.ordinal, customId: customIds[i], source: it.source, characters: it.characters, requestSha256: itemShas[i] })),
          excluded: plan.pkg.excluded,
          createdAt: nowIso(),
        });
      },
      previewDetails: { workflow: plan.workflow.name, requests: plan.items.length, files: plan.pkg.files.length, characters: plan.totalCharacters },
    });
    if (opts.previewOnly) return job;
    return this.submit(job.localId, { skipDuplicateCheck: true });
  }

  // ------------------------------------------------------ dataset workflows

  /**
   * Plans a project workflow over a CSV/JSONL dataset. Nothing is persisted;
   * `blockers` must be empty to create a job. Workflow diagnostics, unsafe input
   * paths, identity/field problems, limits and secret findings are all blockers.
   */
  public async planDataset(options: DatasetRunOptions): Promise<PreparedDatasetRun> {
    const config = this.deps.getConfig();
    const blockers: string[] = [];
    const warnings: string[] = [];
    const account = options.account ?? config.defaultAccount;
    const base = {
      options,
      account,
      model: normalizeBatchModelSlug(options.model ?? config.defaultModel),
      maxTokens: config.request.maxTokens,
      limits: {
        maxRequests: config.workflows.maxRequestsPerBatch,
        maxRows: config.workflows.maxRowsPerRun,
        maxCharactersPerItem: config.workflows.maxCharactersPerItem,
        maxTotalCharacters: config.workflows.maxTotalCharacters,
      },
      objective: `Workflow ${options.workflow} over ${options.input}`,
      contentSha256: "",
      blockers,
      warnings,
    };

    const entry = findWorkflow(this.deps.workspaceRoot, options.workflow); // throws WorkflowNotFoundError
    if (!entry.valid || !entry.definition) {
      blockers.push(`workflow ${JSON.stringify(entry.name)} is invalid:\n${formatDiagnostics(entry.diagnostics)}`);
      return { ...base, entry };
    }
    const def = entry.definition;
    const model = normalizeBatchModelSlug(options.model ?? def.model.default ?? config.defaultModel);
    const pinSlug = options.providerPin ?? def.model.provider;
    const pin: ProviderPin | undefined = pinSlug ? { only: [pinSlug], allow_fallbacks: false } : undefined;
    const maxTokens = def.request.maxTokens ?? config.request.maxTokens;
    // Workflow limits can only tighten the local configuration, never loosen it.
    const min = (a: number, b?: number) => (b === undefined ? a : Math.min(a, b));
    const limits: EffectiveLimits = {
      maxRequests: min(config.workflows.maxRequestsPerBatch, def.limits.maxRequests),
      maxRows: min(config.workflows.maxRowsPerRun, def.limits.maxRows),
      maxCharactersPerItem: min(config.workflows.maxCharactersPerItem, def.limits.maxCharactersPerItem),
      maxTotalCharacters: min(config.workflows.maxTotalCharacters, def.limits.maxTotalCharacters),
    };
    const ready = { ...base, entry, definition: def, model, pin, maxTokens, limits };

    const input = resolveWorkspaceInput(this.deps.workspaceRoot, options.input, config, { what: "dataset", maxBytes: config.workflows.maxDatasetBytes });
    if (!input.ok) {
      blockers.push(input.message);
      return ready;
    }
    const ext = input.relPath.toLowerCase().split(".").pop();
    const expected = def.input.type === "csv" ? ["csv", "tsv", "txt"] : ["jsonl", "ndjson", "txt"];
    if (ext && !expected.includes(ext)) warnings.push(`dataset ${input.relPath} does not have a .${def.input.type} extension; parsed as ${def.input.type} because the workflow says so`);

    const selection: DatasetSelection = {
      ...(options.ids && options.ids.length ? { ids: [...options.ids] } : {}),
      ...(options.fromRow !== undefined ? { fromRow: options.fromRow } : {}),
      ...(options.toRow !== undefined ? { toRow: options.toRow } : {}),
    };
    const plan = planDatasetRun({
      definition: def,
      resolvedSha256: entry.resolvedSha256!,
      dataset: { relPath: input.relPath, bytes: fs.readFileSync(input.absPath) },
      selection,
      model,
      pin,
      maxTokens,
      limits,
      security: { scanSecrets: config.security.scanSecrets, blockOnSecret: config.security.blockOnSecret, knownSecrets: await this.knownSecrets(account) },
    });
    blockers.push(...plan.blockers);
    warnings.push(...entry.warnings.map((w) => `${w.path}: ${w.message}`), ...plan.warnings);
    const contentSha256 = contentHash(buildSubmitBody({ model, provider: pin, requests: plan.items.map((it) => ({ custom_id: "{custom_id}", body: it.body })) }));
    const objective = `Workflow ${def.name} over ${input.relPath}${def.description ? ` — ${def.description}` : ""}`;
    return { ...ready, plan, objective, contentSha256 };
  }

  public async createDatasetJob(prepared: PreparedDatasetRun, opts: { previewOnly: boolean }): Promise<JobManifest> {
    const { plan, entry, definition: def } = prepared;
    if (prepared.blockers.length > 0 || !plan || !entry || !def) throw new SubmissionBlockedError(prepared.blockers.join("\n\n") || "the dataset plan is incomplete");
    this.assertNoActiveDuplicate(prepared.contentSha256, opts.previewOnly);
    const info: DatasetWorkflowInfo = {
      name: def.name,
      version: def.schemaVersion,
      origin: "project",
      definitionFile: entry.file,
      definitionSha256: entry.definitionSha256!,
      resolvedSha256: entry.resolvedSha256!,
      output: def.output.type,
      synthesisEnabled: def.synthesis.enabled,
      dataset: plan.dataset,
      selection: plan.selection,
      planSha256: plan.planSha256,
    };
    const job = this.persistJob({
      kind: "workflow",
      schemaVersion: DATASET_MANIFEST_SCHEMA_VERSION,
      objective: prepared.objective,
      model: prepared.model,
      account: prepared.account,
      pin: prepared.pin,
      format: def.output.type,
      items: plan.items.map((it) => ({
        source: it.source,
        body: it.body,
        characters: it.characters,
        prompt: it.prompt,
        inputSha256: it.inputSha256,
        metadata: { selectedFields: it.values },
      })),
      context: { fileCount: 1, characters: plan.totalCharacters, excludedCount: 0 },
      warnings: [...prepared.warnings],
      retryCount: 0,
      workflow: info,
      writeArtefacts: (localId, customIds, itemShas) => {
        atomicWriteFile(this.registry.artefact(localId, "objective"), prepared.objective + "\n");
        // Exact definition bytes: the job stays understandable after the file changes.
        atomicWriteFile(this.registry.artefact(localId, "workflowSource"), entry.bytes!);
        atomicWriteJson(this.registry.artefact(localId, "workflowResolved"), {
          name: def.name,
          origin: "project",
          definitionFile: entry.file,
          definitionSha256: entry.definitionSha256,
          resolvedSha256: entry.resolvedSha256,
          definition: def,
          effective: { model: prepared.model, providerPin: prepared.pin ?? null, maxTokens: prepared.maxTokens, limits: prepared.limits },
        });
        atomicWriteJson(this.registry.artefact(localId, "dataset"), {
          dataset: plan.dataset,
          selection: plan.selection,
          counts: plan.counts,
          planSha256: plan.planSha256,
          // Source mapping: logical source ID <-> provider custom_id, never the same value.
          items: plan.items.map((it, i) => ({
            ordinal: it.ordinal,
            customId: customIds[i],
            sourceId: it.source.sourceId,
            ...(it.source.row !== undefined ? { row: it.source.row } : {}),
            ...(it.source.line !== undefined ? { line: it.source.line } : {}),
            inputSha256: it.inputSha256,
            requestSha256: itemShas[i],
            characters: it.characters,
          })),
          createdAt: nowIso(),
        });
        atomicWriteJson(this.registry.artefact(localId, "plan"), {
          workflow: { name: def.name, origin: "project", definitionSha256: entry.definitionSha256, resolvedSha256: entry.resolvedSha256 },
          objective: prepared.objective,
          model: prepared.model,
          account: prepared.account,
          providerPin: prepared.pin ?? null,
          format: def.output.type,
          totals: { requests: plan.items.length, ...plan.counts, characters: plan.totalCharacters, largestItem: plan.largest ?? null },
          limits: prepared.limits,
          items: plan.items.map((it, i) => ({ ordinal: it.ordinal, customId: customIds[i], source: it.source, characters: it.characters, requestSha256: itemShas[i] })),
          createdAt: nowIso(),
        });
      },
      previewDetails: { workflow: def.name, requests: plan.items.length, rows: plan.counts.selectedRows, characters: plan.totalCharacters, planSha256: plan.planSha256 },
    });
    if (opts.previewOnly) return job;
    return this.submit(job.localId, { skipDuplicateCheck: true });
  }

  /**
   * For a previewed dataset job: a note when the workflow file differs from the one
   * the preview was built from. The stored request is still what gets submitted.
   */
  public workflowDrift(localId: string): string | undefined {
    const job = this.registry.read(localId);
    const w = job.workflow;
    if (!isDatasetWorkflow(w)) return undefined;
    const abs = path.join(this.deps.workspaceRoot, ...w.definitionFile.split("/"));
    const current = fs.existsSync(abs) ? sha256Hex(fs.readFileSync(abs)) : undefined;
    if (current === w.definitionSha256) return undefined;
    return current === undefined
      ? `The workflow file ${w.definitionFile} no longer exists. ${localId} submits the request stored at preview time.`
      : `The workflow file ${w.definitionFile} has changed since ${localId} was previewed. The request stored at preview time is submitted unchanged; create a new preview to use the new definition.`;
  }

  // ------------------------------------------------- Databricks metadata (Phase 1)

  /** Plans `databricks-metadata`: one request per table in tables.jsonl, sharing context.md. Nothing is persisted. */
  public async planMetadata(options: MetadataRunOptions): Promise<PreparedMetadataRun> {
    const config = this.deps.getConfig();
    const blockers: string[] = [];
    const account = options.account ?? config.defaultAccount;
    const model = normalizeBatchModelSlug(options.model ?? config.defaultModel);
    const pin: ProviderPin | undefined = options.providerPin ? { only: [options.providerPin], allow_fallbacks: false } : undefined;
    const base: PreparedMetadataRun = { options, model, account, pin, maxTokens: config.request.maxTokens, objective: "", contentSha256: "", blockers, warnings: [] };
    const read = (raw: string, what: string, maxBytes: number) => {
      const r = resolveWorkspaceInput(this.deps.workspaceRoot, raw, config, { what, maxBytes });
      if (!r.ok) {
        blockers.push(r.message);
        return undefined;
      }
      const bytes = fs.readFileSync(r.absPath);
      const text = decodeDatasetBytes(bytes);
      if (text === undefined) {
        blockers.push(`${what} ${r.relPath} is not valid UTF-8 text`);
        return undefined;
      }
      return { relPath: r.relPath, bytes, text };
    };
    const context = read(options.context, "context", config.context.maxFileBytes);
    const input = read(options.input, "tables input", config.workflows.maxDatasetBytes);
    if (!context || !input) return base;
    const plan = planMetadataRun({
      context,
      input,
      model,
      pin,
      maxTokens: config.request.maxTokens,
      limits: { maxRequests: config.workflows.maxRequestsPerBatch, maxRows: config.workflows.maxRowsPerRun, maxCharactersPerItem: config.workflows.maxCharactersPerItem, maxTotalCharacters: config.workflows.maxTotalCharacters },
      security: { scanSecrets: config.security.scanSecrets, blockOnSecret: config.security.blockOnSecret, knownSecrets: await this.knownSecrets(account) },
    });
    blockers.push(...plan.blockers);
    const contentSha256 = contentHash(buildSubmitBody({ model, provider: pin, requests: plan.items.map((it) => ({ custom_id: "{custom_id}", body: it.body })) }));
    return { ...base, plan, context: { relPath: context.relPath, bytes: context.bytes.length, text: context.text }, input: { relPath: input.relPath, bytes: input.bytes.length }, objective: `Databricks metadata proposals for ${plan.tables} table(s) from ${input.relPath}`, contentSha256, warnings: plan.warnings };
  }

  public async createMetadataJob(prepared: PreparedMetadataRun, opts: { previewOnly: boolean }): Promise<JobManifest> {
    const { plan, context, input } = prepared;
    if (prepared.blockers.length > 0 || !plan || !context || !input) throw new SubmissionBlockedError(prepared.blockers.join("\n\n") || "the metadata plan is incomplete");
    this.assertNoActiveDuplicate(prepared.contentSha256, opts.previewOnly);
    const info: MetadataWorkflowInfo = {
      name: METADATA_WORKFLOW.name,
      version: METADATA_WORKFLOW.version,
      origin: "builtin",
      context: { path: context.relPath, sha256: plan.contextSha256, bytes: context.bytes },
      input: { path: input.relPath, sha256: plan.inputSha256, bytes: input.bytes, tables: plan.tables, tablesWithSamples: plan.tablesWithSamples },
      planSha256: plan.planSha256,
    };
    const job = this.persistJob({
      kind: "workflow",
      schemaVersion: DATASET_MANIFEST_SCHEMA_VERSION,
      objective: prepared.objective,
      model: prepared.model,
      account: prepared.account,
      pin: prepared.pin,
      format: "json",
      items: plan.items.map((it) => ({ source: it.source, body: it.body, characters: it.characters, prompt: it.prompt, inputSha256: it.inputSha256, metadata: { table: it.evidence.table, hasSamples: it.hasSamples } })),
      context: { fileCount: 2, characters: plan.totalCharacters, excludedCount: 0 },
      warnings: [...prepared.warnings],
      retryCount: 0,
      workflow: info,
      writeArtefacts: (localId, customIds, itemShas) => {
        atomicWriteFile(this.registry.artefact(localId, "objective"), prepared.objective + "\n");
        // Exact copy of the shared context sent with every request.
        atomicWriteFile(this.registry.artefact(localId, "context"), context.text);
        atomicWriteJson(this.registry.artefact(localId, "metadataPlan"), {
          workflow: METADATA_WORKFLOW,
          context: info.context,
          input: info.input,
          planSha256: plan.planSha256,
          tables: plan.items.map((it, i) => ({ ordinal: it.ordinal, customId: customIds[i], table: it.evidence.table, line: it.source.line, inputSha256: it.inputSha256, requestSha256: itemShas[i], hasSamples: it.hasSamples, evidence: it.evidence })),
          createdAt: nowIso(),
        });
      },
      previewDetails: { workflow: METADATA_WORKFLOW.name, requests: plan.items.length, characters: plan.totalCharacters, planSha256: plan.planSha256 },
    });
    if (opts.previewOnly) return job;
    return this.submit(job.localId, { skipDuplicateCheck: true });
  }

  /** Stored evidence of a metadata job (or a retry of one), keyed by table name. */
  public metadataEvidence(localId: string): StoredMetadataPlan {
    return JSON.parse(fs.readFileSync(this.registry.artefact(localId, "metadataPlan"), "utf8")) as StoredMetadataPlan;
  }

  /** The output validator of a JSON dataset job, from the definition stored WITH the job (never the current file). */
  private outputValidator(job: JobManifest): OutputValidator | undefined {
    if (isMetadataWorkflow(job.workflow)) {
      // Each item is checked against the evidence of ITS table (by the item's source, never the model's claim).
      try {
        const byTable = new Map(this.metadataEvidence(job.localId).tables.map((t) => [t.table, t.evidence]));
        const items = job.items ?? [];
        return (value, customId) => {
          const it = items.find((i) => i.customId === customId);
          const ev = it?.source.sourceId !== undefined ? byTable.get(it.source.sourceId) : undefined;
          return ev ? proposalProblems(value, ev) : ["no stored evidence for this item; its output cannot be validated"];
        };
      } catch {
        return () => ["the job's stored metadata evidence (request/metadata.json) is missing or unusable; output cannot be validated"];
      }
    }
    if (!isDatasetWorkflow(job.workflow) || job.workflow.output !== "json") return undefined;
    try {
      const stored = JSON.parse(fs.readFileSync(this.registry.artefact(job.localId, "workflowResolved"), "utf8")) as { definition: WorkflowDefinition };
      const out = stored.definition.output;
      const compiled = out.type === "json" ? compileOutputSchema(out.schema) : undefined;
      if (compiled?.ok) return compiled.validate;
    } catch {
      // fall through: never treat output as valid without its schema
    }
    return () => ["the job's stored output schema (request/workflow.json) is missing or unusable; output cannot be validated"];
  }

  // --------------------------------------------------------------- submit

  /** previewed -> submitting -> submitted | failed. Persists `submitting` BEFORE the HTTP call. */
  public async submit(localId: string, opts: { skipDuplicateCheck?: boolean } = {}): Promise<JobManifest> {
    const lock = this.registry.lock(localId);
    try {
      const job = this.registry.read(localId);
      if (job.localStatus !== "previewed") {
        throw new Error(`Job ${localId} is ${job.localStatus}; only previewed jobs can be submitted.`);
      }
      if (!opts.skipDuplicateCheck && job.contentSha256) {
        const dup = this.findActiveDuplicate(job.contentSha256, localId);
        if (dup) throw new DuplicateActiveRequestError(dup.localId);
      }
      const bodyText = fs.readFileSync(this.registry.artefact(localId, "submittedRequest"), "utf8");
      if (sha256Hex(bodyText) !== job.requestSha256) {
        throw new Error(`Job ${localId}: submitted-request.json no longer matches request.sha256; refusing to submit.`);
      }
      const body = JSON.parse(bodyText) as SubmitBody;
      // Re-validated at submit time too: previews made by earlier versions may predate a rule.
      const problems = [...customIdProblems(body.requests.map((r) => r.custom_id)), ...submitBodyProblems(body)];
      if (problems.length > 0) {
        throw new SubmissionBlockedError(
          `Job ${localId} cannot be submitted as stored:\n- ${problems.join("\n- ")}\nCancel it (/batch cancel ${localId}) and create it again; it stays previewed.`,
        );
      }
      const apiKey = await this.deps.resolveApiKey(job.account);
      if (!apiKey) {
        throw new Error(`Missing API key for account "${job.account}". Configure it in Pi (auth.json) or set OPENROUTER_API_KEY. Job ${localId} stays previewed.`);
      }
      const drift = this.workflowDrift(localId);
      this.registry.update(localId, (u) => {
        if (drift) {
          u.note("workflow_changed_since_preview", { definitionFile: isDatasetWorkflow(job.workflow) ? job.workflow.definitionFile : undefined });
          if (!u.manifest.warnings.includes(drift)) u.manifest.warnings.push(drift);
        }
        u.transition("submitting");
      });
      this.logger.log("info", "submit_start", { localId, model: job.model, requests: body.requests.length });

      try {
        const { raw, batch } = await this.client(apiKey).submit(body, bodyText);
        writeOnce(this.registry.artefact(localId, "submissionResponse"), raw.bodyText);
        const config = this.deps.getConfig();
        return this.registry.update(localId, (u) => {
          const m = u.manifest;
          m.providerBatchId = batch.id;
          m.providerStatus = batch.status;
          m.submittedAt = nowIso();
          for (const it of m.items ?? []) if (it.status === "planned") it.status = "submitted";
          this.applyProviderTimestamps(u, batch.createdAt, batch.finalizedAt);
          m.nextPollAt = new Date(Date.now() + config.polling.intervalSeconds * 1000).toISOString();
          u.transition("submitted", { providerBatchId: batch.id, providerStatus: batch.status, httpStatus: raw.status });
          this.logger.log("info", "submit_accepted", { localId, providerBatchId: batch.id, providerStatus: batch.status, httpStatus: raw.status });
          return m;
        });
      } catch (err) {
        return this.recordSubmitFailure(localId, err);
      }
    } finally {
      lock.release();
    }
  }

  private recordSubmitFailure(localId: string, err: unknown): JobManifest {
    let code = "internal_error";
    let message = err instanceof Error ? err.message : String(err);
    const details: Record<string, unknown> = {};
    if (err instanceof OpenRouterError) {
      details.category = err.category;
      details.httpStatus = err.httpStatus;
      if (err.category === "network" || err.category === "timeout") {
        code = "submission_unknown";
        message =
          `No response from OpenRouter (${err.category}). The batch MAY have been accepted. ` +
          `Check your OpenRouter activity before using /batch retry, to avoid paying twice. Detail: ${err.detail}`;
      } else {
        code = `submission_rejected_${err.category}`;
        message = err.detail;
        if (err.rawBody) writeOnce(this.registry.artefact(localId, "submissionResponse"), err.rawBody);
      }
    }
    this.logger.log("error", "submit_failed", { localId, code, ...details });
    return this.registry.update(localId, (u) => {
      u.manifest.error = { code, message };
      u.transition("failed", { code, ...details });
      return u.manifest;
    });
  }

  private applyProviderTimestamps(u: JobUpdate, createdAt: unknown, finalizedAt: unknown): void {
    const m = u.manifest;
    const c = parseProviderTimestamp(createdAt);
    if (c.ok) m.providerCreatedAt = c.iso;
    else if (c.reason !== "missing") this.rejectTimestamp(u, "created_at", createdAt, c.reason);
    const f = parseProviderTimestamp(finalizedAt);
    if (f.ok) m.finalizedAt = f.iso;
    else if (f.reason !== "missing") this.rejectTimestamp(u, "finalized_at", finalizedAt, f.reason);
  }

  private rejectTimestamp(u: JobUpdate, field: string, value: unknown, reason: string): void {
    const warning = `provider ${field} rejected (${reason}): ${JSON.stringify(value)}`;
    if (!u.manifest.warnings.includes(warning)) {
      u.manifest.warnings.push(warning);
      u.note("timestamp_rejected", { field, value, reason });
    }
  }

  // ------------------------------------------------------------ reconcile

  public jobsNeedingReconcile(): JobManifest[] {
    return this.registry.list().jobs.filter((j) => RECONCILE_STATUSES.has(j.localStatus));
  }

  /**
   * One reconciliation step for one job: poll provider status, retrieve and
   * normalise results when complete, recover from interrupted local states.
   * Never overlaps for the same job (file lock, across processes).
   * A network failure here never marks the batch failed.
   */
  public async reconcile(localId: string, opts: { force?: boolean; waitForLockMs?: number } = {}): Promise<ReconcileOutcome> {
    // The background poller skips a busy job; a user's explicit check waits briefly for
    // the in-flight check to finish so it can report fresh state instead of "busy".
    let lock = this.registry.tryLock(localId);
    const deadline = Date.now() + (opts.waitForLockMs ?? 0);
    while (!lock && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
      lock = this.registry.tryLock(localId);
    }
    if (!lock) return { localId, status: this.registry.read(localId).localStatus, polled: false, skipped: "locked" };
    try {
      return await this.reconcileLocked(localId, opts);
    } finally {
      lock.release();
    }
  }

  private async reconcileLocked(localId: string, opts: { force?: boolean }): Promise<ReconcileOutcome> {
    let job = this.registry.read(localId);
    const ageMs = Date.now() - isoToEpochMs(job.createdAt);

    // Crash recovery: we hold the lock, so no live process is mid-operation.
    if ((job.localStatus === "draft" || job.localStatus === "submitting") && ageMs > INTERRUPTED_AFTER_MS) {
      const wasSubmitting = job.localStatus === "submitting";
      job = this.registry.update(localId, (u) => {
        u.manifest.error = wasSubmitting
          ? {
              code: "submission_unknown",
              message:
                "Pi stopped while this job was being submitted; OpenRouter may or may not have accepted it. " +
                "Check your OpenRouter activity before using /batch retry.",
            }
          : { code: "creation_interrupted", message: "Pi stopped while this job was being created; nothing was submitted." };
        u.transition("failed", { recovered: true });
        return u.manifest;
      });
      this.logger.log("warn", "recovered_interrupted", { localId, from: wasSubmitting ? "submitting" : "draft" });
      this.deps.onSettled?.(job);
      return { localId, status: job.localStatus, polled: false };
    }
    if (job.localStatus === "retrieving") {
      // Interrupted mid-retrieval. If the raw final response was already saved, finish
      // from that local evidence (no network, deterministic); otherwise retrieve again.
      const saved = job.finalResponseFile ? path.join(this.registry.jobDir(localId), ...job.finalResponseFile.split("/")) : undefined;
      if (saved && fs.existsSync(saved)) {
        this.logger.log("warn", "retrieval_resumed", { localId, from: job.finalResponseFile });
        job = this.finishRetrieval(localId, fs.readFileSync(saved, "utf8"), saved, { resumed: true });
        if (TERMINAL_STATUSES.has(job.localStatus)) this.deps.onSettled?.(job);
        return { localId, status: job.localStatus, polled: false };
      }
      job = this.registry.update(localId, (u) => {
        u.transition("provider_completed", { recovered: true });
        return u.manifest;
      });
    }
    if (!POLLABLE_STATUSES.has(job.localStatus) || !job.providerBatchId) {
      return { localId, status: job.localStatus, polled: false, skipped: "not_pollable" };
    }
    if (!opts.force && job.nextPollAt && isoToEpochMs(job.nextPollAt) > Date.now()) {
      return { localId, status: job.localStatus, polled: false, skipped: "not_due" };
    }

    const config = this.deps.getConfig();
    let fetched: { raw: RawExchange; status: string; createdAt: unknown; finalizedAt: unknown; counts?: { total: number; completed: number; failed: number }; hasResults: boolean; paymentRequired?: boolean; errorMessage?: string };
    try {
      const apiKey = await this.deps.resolveApiKey(job.account);
      if (!apiKey) throw new OpenRouterError("auth", undefined, `no API key available for account "${job.account}"`, "get");
      const res = await this.client(apiKey).get(job.providerBatchId);
      fetched = {
        raw: res.raw,
        status: res.batch.status,
        createdAt: res.batch.createdAt,
        finalizedAt: res.batch.finalizedAt,
        counts: res.batch.requestCounts,
        hasResults: res.batch.hasResults,
        paymentRequired: res.paymentRequired,
        errorMessage: res.batch.errorMessage,
      };
    } catch (err) {
      return this.recordPollError(job, err);
    }

    atomicWriteFile(this.registry.artefact(localId, "latestStatus"), fetched.raw.bodyText);

    job = this.registry.update(localId, (u) => {
      const m = u.manifest;
      const providerChanged = m.providerStatus !== fetched.status;
      m.providerStatus = fetched.status;
      m.lastPollAt = nowIso();
      m.pollAttempts += 1;
      m.consecutivePollFailures = 0;
      delete m.lastPollError;
      if (fetched.counts) {
        m.completedCount = fetched.counts.completed;
        m.failedCount = fetched.counts.failed;
      }
      this.applyProviderTimestamps(u, fetched.createdAt, fetched.finalizedAt);
      m.nextPollAt = new Date(Date.now() + config.polling.intervalSeconds * 1000).toISOString();

      if (m.localStatus === "submitted") u.transition("polling", { providerStatus: fetched.status });
      const s = fetched.status;
      if (s === "completed") {
        // Already provider_completed when a previous retrieval found results unavailable (e.g. HTTP 402).
        if (m.localStatus !== "provider_completed") u.transition("provider_completed", { providerStatus: s, cancelRace: m.localStatus === "cancel_requested" || undefined });
      } else if (s === "failed") {
        m.error = { code: "provider_failed", message: fetched.errorMessage ?? "OpenRouter reported the batch as failed" };
        u.transition("failed", { providerStatus: s });
      } else if (s === "expired") {
        m.error = { code: "provider_expired", message: "OpenRouter did not complete the batch within its 24h window" };
        u.transition("expired", { providerStatus: s });
      } else if (s === "cancelled") {
        u.transition("cancelled", { providerStatus: s });
      } else if (providerChanged) {
        // validating / in_progress / finalizing / cancelling / unknown future values
        u.transition(m.localStatus === "cancel_requested" ? "cancel_requested" : "polling", { providerStatus: s });
      }
      return m;
    });
    this.logger.log("info", "poll_ok", { localId, providerBatchId: job.providerBatchId, providerStatus: fetched.status, localStatus: job.localStatus });

    if (job.localStatus === "provider_completed") {
      job = this.retrieve(job, fetched.raw, fetched.paymentRequired === true);
    }
    if (TERMINAL_STATUSES.has(job.localStatus)) this.deps.onSettled?.(job);
    return { localId, status: job.localStatus, polled: true };
  }

  private recordPollError(job: JobManifest, err: unknown): ReconcileOutcome {
    const config = this.deps.getConfig();
    const e = err instanceof OpenRouterError ? err : new OpenRouterError("protocol", undefined, String((err as Error)?.message ?? err), "get");
    // 410 Gone: OpenRouter purged results after its retention window — definitive provider evidence.
    if (e.category === "gone") {
      const updated = this.registry.update(job.localId, (u) => {
        u.manifest.error = { code: "results_gone", message: `OpenRouter no longer holds this batch's results (HTTP 410): ${e.detail}` };
        u.manifest.lastPollAt = nowIso();
        u.transition("failed", { httpStatus: 410 });
        return u.manifest;
      });
      this.logger.log("error", "poll_gone", { localId: job.localId, providerBatchId: job.providerBatchId });
      this.deps.onSettled?.(updated);
      return { localId: job.localId, status: updated.localStatus, polled: true, error: e.message };
    }
    // Everything else (network, timeout, 5xx, 429, auth, 404 with a possibly-wrong account key, bad JSON)
    // is recorded and retried with backoff; the local status is unchanged.
    const updated = this.registry.update(job.localId, (u) => {
      const m = u.manifest;
      m.consecutivePollFailures += 1;
      m.pollAttempts += 1;
      m.lastPollAt = nowIso();
      m.lastPollError = { category: e.category, message: e.detail, ...(e.httpStatus ? { httpStatus: e.httpStatus } : {}), at: nowIso() };
      const backoff = Math.min(config.polling.maxBackoffSeconds, config.polling.intervalSeconds * 2 ** (m.consecutivePollFailures - 1));
      m.nextPollAt = new Date(Date.now() + backoff * 1000).toISOString();
      u.note("poll_error", { category: e.category, httpStatus: e.httpStatus, consecutive: m.consecutivePollFailures, backoffSeconds: backoff });
      return m;
    });
    this.logger.log("warn", "poll_error", {
      localId: job.localId,
      providerBatchId: job.providerBatchId,
      category: e.category,
      httpStatus: e.httpStatus,
      attempt: updated.consecutivePollFailures,
    });
    return { localId: job.localId, status: updated.localStatus, polled: true, error: e.message };
  }

  private normalise(job: JobManifest, rawText: string): NormalisedBatchResult {
    return normaliseBatchResult(rawText, {
      localJobId: job.localId,
      providerBatchId: job.providerBatchId!,
      expectedCustomIds: job.customIds,
      // Release 1 jobs never validated JSON output; keep their semantics.
      format: job.schemaVersion >= 2 ? job.format : "markdown",
      validateJson: this.outputValidator(job),
    });
  }

  /** provider_completed -> retrieving -> ready | partial | failed | corrupt | (back to provider_completed). */
  private retrieve(job: JobManifest, raw: RawExchange, paymentRequired: boolean): JobManifest {
    const localId = job.localId;
    this.registry.update(localId, (u) => u.transition("retrieving"));

    const probe = this.normalise(job, raw.bodyText);
    if (probe.outcome === "unavailable") {
      const config = this.deps.getConfig();
      return this.registry.update(localId, (u) => {
        const m = u.manifest;
        m.consecutivePollFailures += 1;
        const backoff = Math.min(config.polling.maxBackoffSeconds, config.polling.intervalSeconds * 2 ** (m.consecutivePollFailures - 1));
        m.nextPollAt = new Date(Date.now() + backoff * 1000).toISOString();
        m.lastPollError = {
          category: paymentRequired ? "payment" : "results_unavailable",
          message: paymentRequired
            ? "Batch completed but OpenRouter withheld results (HTTP 402: finalised cost exceeds balance). Top up credits; retrieval will retry."
            : "Batch completed but the response did not include results; retrieval will retry.",
          ...(paymentRequired ? { httpStatus: 402 } : {}),
          at: nowIso(),
        };
        u.transition("provider_completed", { reason: m.lastPollError.category });
        return m;
      });
    }

    // 1. Raw evidence first (write-once), and record where it is before interpreting it.
    const finalPath = writeOnce(this.registry.artefact(localId, "finalResponse"), raw.bodyText);
    const rel = path.relative(this.registry.jobDir(localId), finalPath).split(path.sep).join("/");
    this.registry.update(localId, (u) => {
      u.manifest.finalResponseFile = rel;
      u.note("final_response_saved", { file: rel, bytes: Buffer.byteLength(raw.bodyText) });
    });
    // 2..10. Interpret, write item artefacts and summary, settle the outcome.
    return this.finishRetrieval(localId, raw.bodyText, finalPath, {});
  }

  /** Normalises a saved final response and settles the job. Idempotent: safe to re-run after a crash. */
  private finishRetrieval(localId: string, rawText: string, finalPath: string, details: Record<string, unknown>): JobManifest {
    const job = this.registry.read(localId);
    const normalised = this.normalise(job, rawText);
    if (normalised.outcome === "unavailable") {
      // Cannot happen for a saved response (only complete responses are saved), but never guess.
      return this.registry.update(localId, (u) => (u.transition("provider_completed", { reason: "saved_response_unavailable" }), u.manifest));
    }
    this.writeResultArtefacts(job, normalised, finalPath);

    const next: LocalStatus = normalised.outcome;
    const counts = itemCounts(normalised.items.map((i) => i.status));
    const updated = this.registry.update(localId, (u) => {
      const m = u.manifest;
      m.retrievedAt = nowIso();
      if (normalised.usage) m.usage = normalised.usage;
      m.completedCount = counts.completed;
      m.failedCount = normalised.items.length - counts.completed;
      for (const w of normalised.warnings) if (!m.warnings.includes(w)) m.warnings.push(w);
      if (m.items) {
        for (const it of m.items) {
          const n = normalised.items.find((x) => x.customId === it.customId);
          if (!n) continue; // correlation never started (top-level corrupt): item keeps "submitted"
          it.status = n.status;
          it.validation = n.validation;
          if (n.error) it.error = n.error;
          else delete it.error;
          if (n.finishReason) it.finishReason = n.finishReason;
          if (n.usage) it.usage = n.usage;
        }
      }
      const breakdown = `${counts.failed} failed, ${counts.corrupt} corrupt, ${counts.missing} missing`;
      if (next === "corrupt") {
        m.error = {
          code: "result_invalid",
          message: normalised.issues.length ? normalised.issues.join("; ") : `no item result could be interpreted (${breakdown})`,
        };
      } else if (next === "failed") {
        const first = normalised.items.find((i) => i.error)?.error;
        m.error = { code: first?.code ?? "all_requests_failed", message: normalised.items.length > 1 ? `every request in the batch was unusable (${breakdown})` : (first?.message ?? "every request in the batch failed") };
      } else if (next === "partial") {
        m.error = { code: "some_requests_failed", message: `${m.failedCount} of ${m.requestCount} request(s) failed (${breakdown})` };
      } else {
        delete m.error;
      }
      u.transition(next, { finalResponse: path.basename(finalPath), ...counts, issues: normalised.issues.length ? normalised.issues : undefined, ...details });
      return m;
    });
    this.logger.log(next === "ready" ? "info" : "warn", "retrieved", { localId, providerBatchId: job.providerBatchId, outcome: next, ...counts });
    return updated;
  }

  private writeResultArtefacts(job: JobManifest, n: NormalisedBatchResult, finalPath: string): void {
    const localId = job.localId;
    const items = n.items.map(({ raw: _raw, ...rest }) => rest);
    const unexpected = n.unexpected.map(({ raw: _raw, ...rest }) => rest);
    atomicWriteJson(this.registry.artefact(localId, "resultJson"), { ...n, items, unexpected });
    const finalResponseFile = path.relative(this.registry.jobDir(localId), finalPath).split(path.sep).join("/");
    atomicWriteJson(this.registry.artefact(localId, "resultMetadata"), {
      localId,
      providerBatchId: job.providerBatchId,
      model: job.model,
      outcome: n.outcome,
      providerStatus: n.providerStatus,
      requestCounts: n.requestCounts,
      usage: n.usage,
      warnings: n.warnings,
      issues: n.issues,
      requestSha256: job.requestSha256,
      finalResponseFile,
      retrievedAt: nowIso(),
    });
    if (n.unexpected.length > 0) atomicWriteJson(this.registry.artefact(localId, "resultUnexpected"), n.unexpected);

    // Per-item artefacts, keyed by the ordinal of the expected custom_id (never by result order).
    const declared = jobItems(this.registry, job);
    const ordinalOf = new Map(job.customIds.map((id, i) => [id, i + 1]));
    for (const item of n.items) {
      const ordinal = ordinalOf.get(item.customId)!;
      if (item.raw !== undefined) writeOnceUnlessIdentical(this.registry.itemArtefact(localId, ordinal, "raw"), JSON.stringify(item.raw, null, 2) + "\n");
      const { raw: _raw, ...rest } = item;
      atomicWriteJson(this.registry.itemArtefact(localId, ordinal, "resultJson"), { ordinal, ...rest, batchOutcome: n.outcome, finalResponseFile });
      if (item.status === "completed" && n.outcome !== "corrupt") {
        atomicWriteFile(this.registry.itemArtefact(localId, ordinal, "resultMd"), item.text!.trimEnd() + "\n");
        // Parsed, schema-valid JSON is stored separately from the raw text.
        if (item.json !== undefined) atomicWriteJson(this.registry.itemArtefact(localId, ordinal, "output"), item.json);
      }
    }
    atomicWriteJson(this.registry.artefact(localId, "resultSummary"), {
      localId,
      providerBatchId: job.providerBatchId,
      outcome: n.outcome,
      providerStatus: n.providerStatus,
      counts: { expected: job.customIds.length, ...itemCounts(n.items.map((i) => i.status)), unexpected: n.unexpected.length },
      batchUsage: n.usage ?? null,
      items: n.items.map((it) => {
        const ordinal = ordinalOf.get(it.customId)!;
        const d = declared.find((x) => x.customId === it.customId);
        return {
          ordinal,
          customId: it.customId,
          source: d?.source ?? null,
          status: it.status,
          validation: it.validation,
          error: it.error ?? null,
          finishReason: it.finishReason ?? null,
          usage: it.usage ?? null,
        };
      }),
      issues: n.issues,
      warnings: n.warnings,
    });

    if (n.outcome === "corrupt") return; // no assistant text is trustworthy enough to render
    const completed = n.items.filter((i) => i.status === "completed");
    let md: string;
    if (n.items.length === 1 && completed.length === 1) {
      md = completed[0]!.text!.trimEnd() + "\n";
    } else {
      md = n.items
        .map((i) => {
          const ordinal = ordinalOf.get(i.customId)!;
          const d = declared.find((x) => x.customId === i.customId);
          const title = `## Item ${String(ordinal).padStart(3, "0")} · ${d ? sourceLabel(d) : i.customId}`;
          return i.status === "completed"
            ? `${title}\n\n${i.text!.trimEnd()}\n`
            : `${title} (${i.status.toUpperCase()})\n\n${i.error?.code ? `[${i.error.code}] ` : ""}${i.error?.message ?? "no usable result"}\n`;
        })
        .join("\n");
    }
    atomicWriteFile(this.registry.artefact(localId, "resultMd"), md);
  }

  // --------------------------------------------------------------- cancel

  public async cancel(localId: string): Promise<{ job: JobManifest; message: string }> {
    let job = this.registry.read(localId);
    if (job.localStatus === "previewed") {
      job = this.withLock(localId, () => this.registry.update(localId, (u) => (u.transition("cancelled", { reason: "never submitted" }), u.manifest)));
      return { job, message: `${localId} was never submitted; marked cancelled.` };
    }
    if (TERMINAL_STATUSES.has(job.localStatus)) {
      return { job, message: `${localId} is already ${job.localStatus}; nothing to cancel.` };
    }
    if (job.localStatus === "provider_completed" || job.localStatus === "retrieving") {
      return { job, message: `${localId} has already completed at OpenRouter (${job.localStatus}); it cannot be cancelled.` };
    }
    if (job.localStatus !== "submitted" && job.localStatus !== "polling" && job.localStatus !== "cancel_requested") {
      return { job, message: `${localId} is ${job.localStatus}; it cannot be cancelled now.` };
    }

    if (job.localStatus !== "cancel_requested") {
      job = this.withLock(localId, () =>
        this.registry.update(localId, (u) => {
          u.manifest.cancelRequestedAt = nowIso();
          u.transition("cancel_requested");
          return u.manifest;
        }),
      );
    }

    let providerNote: string;
    try {
      const apiKey = await this.deps.resolveApiKey(job.account);
      const res = await this.client(apiKey).cancel(job.providerBatchId!);
      if (res.raw) writeOnce(this.registry.artefact(localId, "cancelResponse"), res.raw.bodyText);
      providerNote = res.supported
        ? "OpenRouter accepted the cancellation request."
        : "OpenRouter does not document a batch cancel endpoint and did not accept one; the batch may still complete (and be billed).";
      this.withLock(localId, () => this.registry.update(localId, (u) => u.note("cancel_provider_response", { supported: res.supported, httpStatus: res.raw?.status })));
    } catch (err) {
      const e = err as OpenRouterError;
      providerNote = `Cancellation request to OpenRouter failed (${e.category ?? "error"}): ${e.detail ?? e.message}. Will keep reconciling.`;
      this.withLock(localId, () => this.registry.update(localId, (u) => u.note("cancel_provider_error", { category: e.category, httpStatus: e.httpStatus })));
    }

    const outcome = await this.reconcile(localId, { force: true });
    job = this.registry.read(localId);
    const finalNote =
      job.localStatus === "cancelled"
        ? "Status: cancelled."
        : job.localStatus === "ready" || job.localStatus === "partial"
          ? `The batch had already completed before cancellation took effect; the result was retrieved (${job.localStatus}).`
          : `Local status: ${job.localStatus}${outcome.error ? ` (last check: ${outcome.error})` : ""}. The real outcome will be reconciled by polling.`;
    return { job, message: `${providerNote}\n${finalNote}` };
  }

  private withLock<T>(localId: string, fn: () => T): T {
    const lock = this.registry.lock(localId);
    try {
      return fn();
    } finally {
      lock.release();
    }
  }

  // ---------------------------------------------------------------- retry

  /** Every item of a finished job, re-run as a new linked job from the exact original request bodies. */
  public async retry(localId: string, opts: { model?: string } = {}): Promise<JobManifest> {
    const source = this.registry.read(localId);
    this.assertNotChat(source);
    if (!TERMINAL_STATUSES.has(source.localStatus)) {
      throw new Error(`${localId} is ${source.localStatus}; only finished jobs (ready/partial/failed/cancelled/expired/corrupt) can be retried.`);
    }
    const items = jobItems(this.registry, source);
    const child = await this.createRetryJob(source, items, { model: opts.model, mode: "full", previewOnly: false });
    return child;
  }

  /**
   * Selected items of a finished job, re-run as a new linked job. `failed`
   * selects every item without a trusted usable result. The parent job and its
   * artefacts are never modified (an event is appended to its history).
   */
  public async retryItems(localId: string, opts: { failed?: boolean; selectors?: string[]; model?: string; previewOnly?: boolean }): Promise<JobManifest> {
    const source = this.registry.read(localId);
    this.assertNotChat(source);
    if (!TERMINAL_STATUSES.has(source.localStatus)) {
      throw new Error(`${localId} is ${source.localStatus}; only finished jobs can have items retried.`);
    }
    const items = jobItems(this.registry, source);
    const trusted = source.localStatus === "ready" || source.localStatus === "partial";
    const chosen = new Map<number, JobItem>();
    if (opts.failed) for (const it of items) if (!(trusted && isUsable(it))) chosen.set(it.ordinal, it);
    for (const sel of opts.selectors ?? []) {
      const it = resolveItem(items, sel);
      chosen.set(it.ordinal, it);
    }
    if (!opts.failed && (opts.selectors ?? []).length === 0) throw new Error("Choose items: --failed and/or --item <selector> (repeatable).");
    if (chosen.size === 0) throw new Error(`${localId} has no failed, corrupt or missing items to retry.`);
    const selected = [...chosen.values()].sort((a, b) => a.ordinal - b.ordinal);
    return this.createRetryJob(source, selected, { model: opts.model, mode: "items", previewOnly: opts.previewOnly ?? false });
  }

  private async createRetryJob(
    source: JobManifest,
    selected: JobItem[],
    opts: { model?: string; mode: "full" | "items"; previewOnly: boolean },
  ): Promise<JobManifest> {
    const config = this.deps.getConfig();
    const localId = source.localId;
    const srcBodyText = fs.readFileSync(this.registry.artefact(localId, "submittedRequest"), "utf8");
    const srcBody = JSON.parse(srcBodyText) as SubmitBody;
    const objective = fs.readFileSync(this.registry.artefact(localId, "objective"), "utf8");
    const bodies = selected.map((it) => {
      const req = srcBody.requests.find((r) => r.custom_id === it.customId);
      if (!req) throw new Error(`${localId}: item ${it.ordinal} (${it.customId}) is not in submitted-request.json; cannot retry it.`);
      return { item: it, body: req.body };
    });

    // The copied request bodies are re-scanned: secret rules may have changed since the original was built.
    if (config.security.scanSecrets && config.security.blockOnSecret) {
      const known = await this.knownSecrets(source.account);
      const findings = [
        ...scanForSecrets(objective, "<objective>", known),
        ...bodies.flatMap(({ item, body }) => scanForSecrets(JSON.stringify(body), `item ${item.ordinal} request`, known)),
      ];
      if (findings.length > 0) throw new SubmissionBlockedError(formatSecretFindings(findings));
    }

    const model = opts.model ? normalizeBatchModelSlug(opts.model) : srcBody.model;
    const promptOf = (body: BatchRequestItem["body"]) => body.messages.filter((m) => m.role === "user").map((m) => m.content).join("\n\n");
    const child = this.persistJob({
      kind: source.kind ?? "goal",
      objective: source.objective,
      model,
      account: source.account,
      pin: srcBody.provider,
      format: source.format,
      items: bodies.map(({ item, body }) => ({
        source: item.source,
        body,
        characters: item.characters ?? promptOf(body).length,
        prompt: promptOf(body),
        replaces: { jobId: localId, customId: item.customId, ordinal: item.ordinal },
        ...(item.inputSha256 ? { inputSha256: item.inputSha256 } : {}),
        metadata: this.inheritedItemMetadata(localId, item.ordinal),
      })),
      // A retry of a dataset job is a dataset job: same schema version, same stored workflow.
      ...(source.schemaVersion === DATASET_MANIFEST_SCHEMA_VERSION ? { schemaVersion: DATASET_MANIFEST_SCHEMA_VERSION } : {}),
      context:
        opts.mode === "items"
          ? {
              fileCount: new Set(selected.flatMap((s) => (s.source.path ? [s.source.path] : (s.source.paths ?? [])))).size,
              characters: bodies.reduce((n, { item, body }) => n + (item.characters ?? promptOf(body).length), 0),
              excludedCount: 0,
            }
          : { ...source.context },
      warnings: [],
      parentJobId: localId,
      retryCount: source.retryCount + 1,
      retryMode: opts.mode,
      ...(source.workflow ? { workflow: source.workflow } : {}),
      ...(source.synthesis ? { synthesis: source.synthesis } : {}),
      writeArtefacts: (newId, customIds) => {
        atomicWriteFile(this.registry.artefact(newId, "objective"), objective);
        for (const name of ["context", "contextManifest", "synthesisLinkage", "workflowSource", "workflowResolved", "dataset", "metadataPlan"] as const) {
          const from = this.registry.artefact(localId, name);
          if (fs.existsSync(from)) fs.copyFileSync(from, this.registry.artefact(newId, name));
        }
        if (opts.mode === "items" || source.workflow) {
          atomicWriteJson(this.registry.artefact(newId, "plan"), {
            retryOf: localId,
            mode: opts.mode,
            model,
            items: bodies.map(({ item }, i) => ({ ordinal: i + 1, customId: customIds[i], source: item.source, replaces: { jobId: localId, customId: item.customId, ordinal: item.ordinal } })),
            createdAt: nowIso(),
          });
        }
      },
      previewDetails: { retryOf: localId, model, mode: opts.mode, requests: bodies.length },
    });
    this.withLock(localId, () =>
      this.registry.update(localId, (u) =>
        u.note(opts.mode === "items" ? "items_retried" : "retried", { childJobId: child.localId, model, items: selected.map((s) => s.ordinal) }),
      ),
    );
    this.logger.log("info", "retry_created", { localId: child.localId, parentJobId: localId, mode: opts.mode, requests: bodies.length });
    if (opts.previewOnly) return child;
    return this.submit(child.localId, { skipDuplicateCheck: true });
  }

  /** Dataset provenance a retried item keeps from its parent (selected values), without re-reading the dataset. */
  private inheritedItemMetadata(jobId: string, ordinal: number): Record<string, unknown> | undefined {
    try {
      const meta = JSON.parse(fs.readFileSync(this.registry.itemArtefact(jobId, ordinal, "metadata"), "utf8")) as { selectedFields?: unknown };
      return meta.selectedFields !== undefined ? { selectedFields: meta.selectedFields } : undefined;
    } catch {
      return undefined;
    }
  }

  // ------------------------------------------------------------ synthesis

  public coverage(localId: string): Coverage {
    return combinedCoverage(this.registry, localId);
  }

  /** Synthesis jobs created from `sourceJobId`, newest first. */
  public synthesisJobs(sourceJobId: string): JobManifest[] {
    return this.registry.list().jobs.filter((j) => j.kind === "synthesis" && j.synthesis?.sourceJobId === sourceJobId);
  }

  /** Jobs linked to this one: retries (children) and syntheses. */
  public linkedJobs(localId: string): { retries: JobManifest[]; syntheses: JobManifest[] } {
    const jobs = this.registry.list().jobs;
    return {
      retries: jobs.filter((j) => j.parentJobId === localId),
      syntheses: jobs.filter((j) => j.kind === "synthesis" && j.synthesis?.sourceJobId === localId),
    };
  }

  /**
   * Deterministic synthesis package from locally validated item results
   * (including linked retry jobs). Blocked unless every expected item is usable,
   * or `allowPartial` is set — in which case the gaps are stated in the prompt
   * and recorded in the job, never left to the model to mention.
   */
  public async prepareSynthesis(sourceJobId: string, opts: SynthesisOptions): Promise<PreparedSynthesis> {
    const config = this.deps.getConfig();
    const source = this.registry.read(sourceJobId);
    this.assertNotChat(source);
    if (source.kind === "synthesis") throw new Error(`${sourceJobId} is itself a synthesis job; synthesize its source job instead.`);
    if (!TERMINAL_STATUSES.has(source.localStatus)) throw new Error(`${sourceJobId} is ${source.localStatus}; wait until it has finished.`);
    if (isDatasetWorkflow(source.workflow) && !source.workflow.synthesisEnabled) {
      throw new Error(`${sourceJobId} was created by workflow ${JSON.stringify(source.workflow.name)}, which has synthesis disabled (synthesis.enabled: false in the definition stored with the job).`);
    }
    const model = normalizeBatchModelSlug(opts.model ?? config.defaultModel);
    const account = opts.account ?? source.account;
    const pin: ProviderPin | undefined = opts.providerPin ? { only: [opts.providerPin], allow_fallbacks: false } : undefined;
    const coverage = this.coverage(sourceJobId);

    const included: SynthesisInputItem[] = [];
    const unusable: SynthesisUnusable[] = [];
    const blockers: string[] = [];
    for (const e of coverage.entries) {
      const label = sourceLabel(e.root);
      if (e.usable) {
        const job = this.registry.read(e.usable.jobId);
        const text = itemText(this.registry, job, e.usable.item);
        if (text === undefined) {
          blockers.push(`item ${e.root.ordinal} (${label}) is marked completed in ${e.usable.jobId} but its result text is missing on disk`);
          continue;
        }
        included.push({ sourceOrdinal: e.root.ordinal, source: e.root.source, sourceLabel: label, customId: e.usable.item.customId, jobId: e.usable.jobId, text });
      } else {
        const last = e.attempts[e.attempts.length - 1]!;
        const status = last.item.status === "planned" || last.item.status === "submitted" ? "no_result" : last.item.status;
        const reason =
          status === "no_result"
            ? `no result (job ${last.jobId} is ${last.jobStatus})`
            : `${status}${last.item.error ? `: ${last.item.error.message}` : ""}${last.jobStatus === "corrupt" ? " (batch correlation untrusted)" : ""}`;
        unusable.push({ sourceOrdinal: e.root.ordinal, sourceLabel: label, status, reason: reason.slice(0, 300) });
      }
    }
    if (included.length === 0) blockers.push(`${sourceJobId} has no usable item results to synthesize.`);
    if (unusable.length > 0 && !opts.allowPartial) {
      blockers.push(
        `${unusable.length} of ${coverage.entries.length} source item(s) have no usable result; synthesis is blocked by default:\n` +
          unusable.map((u) => `  - item ${u.sourceOrdinal} ${u.sourceLabel}: ${u.reason}`).join("\n") +
          `\nRetry them first (/batch retry-items ${sourceJobId} --failed) or pass --allow-partial to synthesize with stated gaps.`,
      );
    }
    const facts = coverageFacts(sourceJobId, coverage.entries.length, included.length, unusable, opts.allowPartial);
    const prompt = renderSynthesisPrompt({ sourceObjective: source.objective, coverage: facts, items: included });
    if (prompt.length > config.workflows.maxSynthesisCharacters) {
      blockers.push(
        `synthesis package is ${prompt.length} characters; workflows.maxSynthesisCharacters is ${config.workflows.maxSynthesisCharacters} (local policy). ` +
          "No results were dropped: raise the limit deliberately, or synthesize a smaller job.",
      );
    }
    if (config.security.scanSecrets) {
      const findings = scanForSecrets(prompt, "<synthesis package>", await this.knownSecrets(account));
      if (findings.length > 0 && config.security.blockOnSecret) blockers.push(formatSecretFindings(findings));
    }
    const linkage: SynthesisLinkage = {
      sourceJobId,
      expectedItems: coverage.entries.length,
      included: included.map((i) => ({ jobId: i.jobId, customId: i.customId, sourceOrdinal: i.sourceOrdinal, source: i.source })),
      excluded: unusable.map((u) => {
        const root = coverage.entries.find((e) => e.root.ordinal === u.sourceOrdinal)!.root;
        return { sourceOrdinal: u.sourceOrdinal, customId: root.customId, source: root.source, status: u.status as SynthesisLinkage["excluded"][number]["status"], reason: u.reason };
      }),
      allowPartial: opts.allowPartial,
    };
    const messages = synthesisMessages(prompt);
    const contentSha256 = contentHash(buildSubmitBody({ model, provider: pin, requests: [{ custom_id: "{custom_id}", body: this.requestBody(messages) }] }));
    return { sourceJobId, model, account, pin, coverage: facts, linkage, prompt, characters: prompt.length, contentSha256, blockers };
  }

  public async createSynthesisJob(prepared: PreparedSynthesis, opts: { previewOnly: boolean }): Promise<JobManifest> {
    if (prepared.blockers.length > 0) throw new SubmissionBlockedError(prepared.blockers.join("\n\n"));
    this.assertNoActiveDuplicate(prepared.contentSha256, opts.previewOnly);
    const source = this.registry.read(prepared.sourceJobId);
    const objective = `Synthesis of ${prepared.sourceJobId}: ${source.objective}`;
    const job = this.persistJob({
      kind: "synthesis",
      objective,
      model: prepared.model,
      account: prepared.account,
      pin: prepared.pin,
      format: "markdown",
      items: [
        {
          source: { kind: "synthesis", label: `synthesis of ${prepared.sourceJobId}` },
          body: this.requestBody(synthesisMessages(prepared.prompt)),
          characters: prepared.characters,
          prompt: prepared.prompt,
        },
      ],
      context: { fileCount: 0, characters: prepared.characters, excludedCount: prepared.linkage.excluded.length },
      warnings: prepared.linkage.excluded.length ? [`partial synthesis: ${prepared.linkage.excluded.length} of ${prepared.linkage.expectedItems} source item(s) not included`] : [],
      retryCount: 0,
      synthesis: prepared.linkage,
      writeArtefacts: (localId) => {
        atomicWriteFile(this.registry.artefact(localId, "objective"), objective + "\n");
        atomicWriteFile(this.registry.artefact(localId, "context"), prepared.prompt);
        atomicWriteJson(this.registry.artefact(localId, "synthesisLinkage"), { ...prepared.linkage, coverage: prepared.coverage, createdAt: nowIso() });
      },
      previewDetails: { synthesisOf: prepared.sourceJobId, included: prepared.linkage.included.length, excluded: prepared.linkage.excluded.length, characters: prepared.characters },
    });
    this.withLock(prepared.sourceJobId, () =>
      this.registry.update(prepared.sourceJobId, (u) => u.note("synthesis_created", { synthesisJobId: job.localId, included: prepared.linkage.included.length, allowPartial: prepared.linkage.allowPartial })),
    );
    if (opts.previewOnly) return job;
    return this.submit(job.localId, { skipDuplicateCheck: true });
  }

  /** Chat turn/compaction: item 1 is the reply (or summary), optional item 2 a title. Submitted immediately. */
  public async createChatJob(input: {
    threadId: string;
    purpose: "turn" | "compact";
    throughSeq: number;
    model: string;
    account: string;
    pin?: ProviderPin;
    main: ChatMessage[];
    title?: ChatMessage[];
  }): Promise<JobManifest> {
    const objective = `${input.purpose === "turn" ? "Chat turn" : "Chat compaction"} in ${input.threadId}`;
    const render = (m: ChatMessage[]): string => m.map((x) => x.content).join("\n\n");
    const mk = (messages: ChatMessage[], label: string) => {
      const prompt = render(messages);
      return { source: { kind: "goal" as const, label }, body: this.requestBody(messages), characters: prompt.length, prompt };
    };
    const items = [mk(input.main, input.purpose === "turn" ? "chat-reply" : "chat-summary")];
    if (input.title) items.push(mk(input.title, "chat-title"));
    const characters = items.reduce((n, it) => n + it.characters, 0);
    const chat: ChatLinkage = { threadId: input.threadId, purpose: input.purpose, throughSeq: input.throughSeq, titleItem: input.title !== undefined };
    const job = this.persistJob({
      kind: "chat",
      schemaVersion: CHAT_MANIFEST_SCHEMA_VERSION,
      objective,
      model: input.model,
      account: input.account,
      pin: input.pin,
      format: "markdown",
      items,
      context: { fileCount: 0, characters, excludedCount: 0 },
      warnings: [],
      retryCount: 0,
      chat,
      writeArtefacts: (localId) => {
        atomicWriteFile(this.registry.artefact(localId, "objective"), objective + "\n");
      },
      previewDetails: { threadId: input.threadId, purpose: input.purpose, characters },
    });
    return this.submit(job.localId, { skipDuplicateCheck: true });
  }

  /** Coverage facts of a synthesis job, rebuilt from its manifest (independent of the model's prose). */
  public synthesisCoverage(job: JobManifest): CoverageFacts | undefined {
    const s = job.synthesis;
    if (!s) return undefined;
    return coverageFacts(
      s.sourceJobId,
      s.expectedItems,
      s.included.length,
      s.excluded.map((e) => ({ sourceOrdinal: e.sourceOrdinal, sourceLabel: sourceLabel(e), status: e.status, reason: e.reason })),
      s.allowPartial,
    );
  }

  // --------------------------------------------------------------- export

  /**
   * Writes a CSV/JSONL export of a finished job (explicit user command only).
   * Destination: `--out` inside the workspace, else a new timestamped file in the
   * job's exports/ folder. Never overwrites unless `overwrite` is set.
   */
  public exportResults(localId: string, opts: { format: "jsonl" | "csv"; out?: string; overwrite?: boolean; jobOnly?: boolean }): ExportRecord {
    const job = this.registry.read(localId);
    this.assertNotChat(job);
    if (!TERMINAL_STATUSES.has(job.localStatus)) throw new Error(`${localId} is ${job.localStatus}; only finished jobs can be exported.`);
    const combined = !opts.jobOnly;
    const rows = buildExportRows(this.registry, job, { combined });
    const data = opts.format === "jsonl" ? toJsonl(rows) : toCsv(rows);
    let absPath: string;
    if (opts.out) {
      const r = resolveWorkspaceOutput(this.deps.workspaceRoot, opts.out);
      if (!r.ok) throw new SubmissionBlockedError(`Export refused: ${r.message}. Nothing was written.`);
      if (r.exists && !opts.overwrite) throw new SubmissionBlockedError(`Export refused: ${r.relPath} already exists. Nothing was written (use --overwrite to replace it).`);
      absPath = r.absPath;
    } else {
      const stamp = new Date().toISOString().replace(/[-:.]/g, "");
      absPath = path.join(this.registry.jobDir(localId), ARTEFACTS.exportsDir, `${localId}-${stamp}.${opts.format}`);
    }
    writeExport(absPath, data, opts.overwrite === true);
    const rootReal = fs.realpathSync.native(this.deps.workspaceRoot);
    const rel = path.relative(rootReal, fs.realpathSync.native(absPath)).split(path.sep).join("/");
    const record: ExportRecord = { format: opts.format, path: rel, sha256: sha256Hex(data), records: rows.length, combined, at: nowIso() };
    this.withLock(localId, () =>
      this.registry.update(localId, (u) => {
        u.manifest.exports = [...(u.manifest.exports ?? []), record];
        u.note("exported", { ...record });
      }),
    );
    this.logger.log("info", "exported", { localId, format: opts.format, records: rows.length });
    return record;
  }

  // ---------------------------------------------------------------- legacy

  /** Read-only inventory of a pre-Release-1 jobs.json. Never writes the file, never calls the network. */
  public legacyInventory(file: string): LegacyInventory {
    const abs = path.resolve(this.deps.workspaceRoot, file);
    const st = fs.existsSync(abs) ? fs.statSync(abs) : undefined;
    if (!st?.isFile()) throw new Error(`legacy jobs file not found: ${file}`);
    if (st.size > 50_000_000) throw new Error(`legacy jobs file is ${st.size} bytes (limit 50000000)`);
    const known = new Map<string, string>();
    for (const j of this.registry.list().jobs) if (j.providerBatchId) known.set(j.providerBatchId, j.localId);
    return inventoryLegacyJobs(fs.readFileSync(abs, "utf8"), known);
  }

  // ----------------------------------------------------------- read/inject

  /** Items table (also used by `/batch items`). Purely local. */
  public describeItems(localId: string): string {
    const job = this.registry.read(localId);
    const items = jobItems(this.registry, job);
    const trusted = job.localStatus === "ready" || job.localStatus === "partial";
    const lines = [`Job ${localId}: ${job.localStatus}${job.providerStatus ? ` (provider: ${job.providerStatus})` : ""}${job.workflow ? `   workflow: ${job.workflow.name}` : ""}`, ""];
    lines.push(`ITEM  STATUS      SOURCE                                    OUTPUT`);
    for (const it of items) {
      const output =
        it.status === "completed"
          ? trusted
            ? `available${it.validation?.warnings.length ? ` (⚠ ${it.validation.warnings.join("; ")})` : ""}`
            : "untrusted (batch corrupt)"
          : it.status === "failed"
            ? `provider error${it.error?.code ? ` [${it.error.code}]` : ""}`
            : it.status === "corrupt"
              ? `validation error${it.error?.code ? ` [${it.error.code}]` : ""}`
              : it.status === "missing"
                ? "not returned"
                : job.localStatus === "previewed" || job.localStatus === "draft"
                  ? "not submitted"
                  : TERMINAL_STATUSES.has(job.localStatus)
                    ? `no result (batch ${job.localStatus})`
                    : "pending";
      lines.push(`${String(it.ordinal).padStart(3, "0")}   ${it.status.padEnd(11)} ${truncate(sourceLabel(it), 40).padEnd(41)} ${output}`);
    }
    const counts = itemCounts(items.map((i) => i.status));
    lines.push("", `Completed ${counts.completed} · failed ${counts.failed} · corrupt ${counts.corrupt} · missing ${counts.missing} · of ${items.length}`);
    const { retries, syntheses } = this.linkedJobs(localId);
    if (retries.length > 0) {
      const cov = this.coverage(localId);
      lines.push("", `Original job: ${job.localStatus}`);
      for (const r of retries) lines.push(`Retry job ${r.localId}: ${r.localStatus} (${r.requestCount} item(s)${r.retryMode === "items" ? "" : ", full re-run"})`);
      lines.push(`Combined coverage: ${cov.complete ? "complete" : "incomplete"} (${cov.usableCount}/${cov.entries.length} usable)`);
      for (const e of cov.entries) {
        if (e.usable && e.usable.jobId !== localId) lines.push(`  item ${String(e.root.ordinal).padStart(3, "0")}: usable via ${e.usable.jobId} item ${e.usable.item.ordinal}`);
        if (!e.usable) lines.push(`  item ${String(e.root.ordinal).padStart(3, "0")}: no usable result yet`);
      }
    }
    for (const s of syntheses) lines.push(`Synthesis job ${s.localId}: ${s.localStatus}${s.synthesis?.allowPartial ? " (partial allowed)" : ""}`);
    lines.push("", `Details: /batch item ${localId} <n>`);
    return lines.join("\n");
  }

  /** One item's details; `text` adds the result text, `raw` adds the provider's raw item entry. */
  public describeItem(localId: string, selector: string, opts: { text?: boolean; raw?: boolean } = {}): { title: string; body: string } {
    const job = this.registry.read(localId);
    const items = jobItems(this.registry, job);
    const it = resolveItem(items, selector);
    const trusted = job.localStatus === "ready" || job.localStatus === "partial";
    const resultMd = this.registry.itemArtefact(localId, it.ordinal, "resultMd");
    const rows: Array<[string, string | number | undefined]> = [
      ["Item", `${it.ordinal} of ${items.length}`],
      ["Custom ID", it.customId],
      ["Source", sourceLabel(it)],
      ["Source ID", it.source.kind === "row" ? `${it.source.sourceId} (${it.source.file}${it.source.row !== undefined ? ` row ${it.source.row}` : ` line ${it.source.line}`})` : undefined],
      ["Input SHA-256", it.inputSha256],
      ["Item status", it.status],
      ["Batch status", `${job.localStatus}${job.providerStatus ? ` (provider: ${job.providerStatus})` : ""}`],
      ["Validation", it.validation ? (it.validation.valid ? "valid" : `invalid — ${it.validation.errors.join("; ")}`) : undefined],
      ["Warnings", it.validation?.warnings.length ? it.validation.warnings.join("; ") : undefined],
      ["Error", it.error ? `${it.error.code ? `[${it.error.code}] ` : ""}${it.error.message}` : undefined],
      ["Finish reason", it.finishReason],
      ["Item usage", it.usage ? formatUsage(it.usage) : job.usage ? "not reported per item (batch-level usage only; see /batch show)" : undefined],
      ["Replaces", it.replaces ? `${it.replaces.jobId} item ${it.replaces.ordinal} (${it.replaces.customId})` : undefined],
      ["Request SHA-256", it.requestSha256],
      ["Request", fs.existsSync(this.registry.itemArtefact(localId, it.ordinal, "request")) ? this.registry.itemArtefact(localId, it.ordinal, "request") : this.registry.artefact(localId, "submittedRequest")],
      ["Result", fs.existsSync(resultMd) ? resultMd : undefined],
      ["Parsed JSON", fs.existsSync(this.registry.itemArtefact(localId, it.ordinal, "output")) ? this.registry.itemArtefact(localId, it.ordinal, "output") : undefined],
    ];
    const lines = rows.filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `  ${k.padEnd(16)} ${v}`);
    if (it.status === "completed" && !trusted) lines.push("", "⚠ The batch response could not be correlated safely (corrupt); this item's text is not presented.");
    if (opts.text) {
      const text = trusted ? itemText(this.registry, job, it) : undefined;
      lines.push("", "---", "", text ?? "(no usable result text for this item)");
    }
    if (opts.raw) {
      const rawPath = this.registry.itemArtefact(localId, it.ordinal, "raw");
      lines.push("", "--- raw provider item entry ---", "", fs.existsSync(rawPath) ? fs.readFileSync(rawPath, "utf8") : "(no raw item entry: not returned or not retrieved yet)");
    }
    return { title: `${localId} item ${it.ordinal}: ${truncate(sourceLabel(it), 50)}`, body: lines.join("\n") };
  }

  public read(localId: string, mode: ReadMode): { title: string; body: string } {
    const job = this.registry.read(localId);
    const resultMd = this.registry.artefact(localId, "resultMd");
    const resultJson = this.registry.artefact(localId, "resultJson");
    const finalResponse = this.registry.artefact(localId, "finalResponse");

    if (mode === "raw") {
      if (!fs.existsSync(finalResponse)) {
        return { title: `${localId}: no final provider response yet`, body: `Status: ${job.localStatus}. Latest raw status (if any): ${this.registry.artefact(localId, "latestStatus")}` };
      }
      const text = fs.readFileSync(finalResponse, "utf8");
      let pretty = text;
      try {
        pretty = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        // show as-is if not JSON
      }
      return { title: `${localId}: raw provider response (exact bytes at ${finalResponse})`, body: pretty };
    }

    if (!fs.existsSync(resultJson)) {
      return {
        title: `${localId}: no retrieved result`,
        body: `Status: ${job.localStatus}${job.providerStatus ? ` (provider: ${job.providerStatus})` : ""}. ${
          POLLABLE_STATUSES.has(job.localStatus) ? "Use /batch check to reconcile now." : job.error ? `Error: ${job.error.message}` : ""
        }`,
      };
    }
    const synthesisBlock = job.kind === "synthesis" ? `COVERAGE (recorded locally, not written by the model)\n${renderCoverage(this.synthesisCoverage(job)!)}\n\n---\n\n` : "";
    const header = job.localStatus === "ready" ? "" : `⚠ Status: ${job.localStatus}${job.error ? ` — ${job.error.message}` : ""}\n\n`;
    const items = jobItems(this.registry, job);
    if (mode === "default" && items.length > 1) {
      return { title: `${localId}: ${truncate(job.objective, 60)}`, body: header + this.multiItemOverview(job, items) };
    }
    const text = fs.existsSync(resultMd) ? fs.readFileSync(resultMd, "utf8") : "(no renderable assistant output)";
    if (mode === "default") return { title: `${localId}: ${truncate(job.objective, 60)}`, body: header + synthesisBlock + text };

    const n = JSON.parse(fs.readFileSync(resultJson, "utf8")) as NormalisedBatchResult;
    const lines = [
      header + synthesisBlock + text.trimEnd(),
      "",
      "---",
      `Outcome: ${n.outcome}   Provider status: ${n.providerStatus}`,
      ...n.items.map(
        (i) =>
          `- ${i.customId}: ${i.status}${i.finishReason ? ` (finish_reason: ${i.finishReason})` : ""}${i.error ? ` — ${i.error.code ?? ""} ${i.error.message}` : ""}${i.usage ? ` [${formatUsage(i.usage)}]` : ""}`,
      ),
      ...(n.usage ? [`Usage: ${formatUsage(n.usage)}`] : ["Usage: not reported by provider"]),
      ...n.issues.map((i) => `Issue: ${i}`),
      ...n.warnings.map((w) => `Warning: ${w}`),
      `Artefacts: ${this.registry.jobDir(localId)}`,
    ];
    return { title: `${localId}: ${truncate(job.objective, 60)} (full)`, body: lines.join("\n") };
  }

  /** Bounded overview of a multi-item job: counts, sources, short excerpts, artefact paths. Never the full texts. */
  private multiItemOverview(job: JobManifest, items: JobItem[]): string {
    const trusted = job.localStatus === "ready" || job.localStatus === "partial";
    const counts = itemCounts(items.map((i) => i.status));
    const lines = [
      `Outcome: ${job.localStatus}   Items: ${items.length} (completed ${counts.completed}, failed ${counts.failed}, corrupt ${counts.corrupt}, missing ${counts.missing})`,
      ...(job.workflow ? [`Workflow: ${job.workflow.name}`] : []),
      `Objective: ${truncate(job.objective, 200)}`,
      "",
    ];
    for (const it of items) {
      const text = trusted ? itemText(this.registry, job, it) : undefined;
      const excerpt = text ? truncate(text, 240) : it.error ? `${it.error.code ? `[${it.error.code}] ` : ""}${it.error.message}` : "(no result)";
      lines.push(`${String(it.ordinal).padStart(3, "0")} ${it.status.padEnd(10)} ${sourceLabel(it)}`, `     ${excerpt}`);
    }
    const { syntheses } = this.linkedJobs(job.localId);
    lines.push("", syntheses.length ? `Synthesis: ${syntheses.map((s) => `${s.localId} (${s.localStatus})`).join(", ")}` : "Synthesis: none");
    lines.push(
      "",
      `Full results: /batch read ${job.localId} --item <n>   ·   all items: /batch read ${job.localId} --items`,
      `Artefacts: ${this.registry.jobDir(job.localId)}`,
    );
    return lines.join("\n");
  }

  /** Every item's full text (bounded only by what is stored), with item status. */
  public readAllItems(localId: string): { title: string; body: string } {
    const job = this.registry.read(localId);
    const md = this.registry.artefact(localId, "resultMd");
    const header = job.localStatus === "ready" ? "" : `⚠ Status: ${job.localStatus}${job.error ? ` — ${job.error.message}` : ""}\n\n`;
    return { title: `${localId}: all items`, body: header + (fs.existsSync(md) ? fs.readFileSync(md, "utf8") : "(no renderable item output)") };
  }

  /** The newest synthesis of a source job, with coverage shown separately from the model's prose. */
  public readSynthesis(sourceJobId: string): { title: string; body: string } {
    const all = this.synthesisJobs(sourceJobId);
    if (all.length === 0) return { title: `${sourceJobId}: no synthesis`, body: `No synthesis job exists for ${sourceJobId}. Create one with /batch synthesize ${sourceJobId}.` };
    // Newest usable synthesis first; a newer one still pending or previewed is listed, not shown.
    const job = all.find((j) => j.localStatus === "ready" || j.localStatus === "partial") ?? all[0]!;
    const others = all.filter((j) => j !== job).map((j) => `${j.localId} (${j.localStatus})`);
    const r = this.read(job.localId, "default");
    return { title: `${sourceJobId} synthesis ${job.localId} (${job.localStatus})`, body: r.body + (others.length ? `\n\nEarlier syntheses: ${others.join(", ")}` : "") };
  }

  public buildInjection(
    localId: string,
    mode: InjectMode,
    target: { item?: string; synthesis?: boolean } = {},
  ): { ok: true; content: string; characters: number; bounded: boolean; injectedJobId: string } | { ok: false; message: string } {
    if (target.synthesis) {
      const syn = this.synthesisJobs(localId).find((j) => j.localStatus === "ready");
      if (!syn) {
        const any = this.synthesisJobs(localId)[0];
        return { ok: false, message: any ? `The newest synthesis of ${localId} (${any.localId}) is ${any.localStatus}; only a ready synthesis can be injected.` : `No synthesis exists for ${localId}.` };
      }
      return this.buildInjection(syn.localId, mode);
    }
    const job = this.registry.read(localId);
    this.assertNotChat(job);
    if (job.localStatus !== "ready" && job.localStatus !== "partial") {
      return {
        ok: false,
        message: `${localId} is ${job.localStatus}; only ready (or explicitly partial) results can be injected.${job.error ? ` Error: ${job.error.message}` : ""}`,
      };
    }
    const config = this.deps.getConfig().injection;
    const items = jobItems(this.registry, job);
    let result: string;
    let resultPath: string;
    const head: string[] = [];
    if (target.item) {
      const it = resolveItem(items, target.item);
      const text = itemText(this.registry, job, it);
      if (!text) return { ok: false, message: `${localId} item ${it.ordinal} (${sourceLabel(it)}) is ${it.status}; it has no usable result to inject.` };
      result = text.trimEnd();
      resultPath = this.registry.itemArtefact(localId, it.ordinal, "resultMd");
      head.push(`Deferred batch result: ${localId} item ${it.ordinal} of ${items.length}`, `Source: ${sourceLabel(it)}`, `Custom ID: ${it.customId}`);
      if (it.validation?.warnings.length) head.push(`Validation warnings: ${it.validation.warnings.join("; ")}`);
    } else {
      resultPath = this.registry.artefact(localId, "resultMd");
      if (!fs.existsSync(resultPath)) return { ok: false, message: `${localId} has no rendered result (result/result.md missing).` };
      result = fs.readFileSync(resultPath, "utf8").trimEnd();
      head.push(`Deferred batch result: ${localId}`);
      if (job.localStatus === "partial") head.push("", `PARTIAL RESULT: ${job.error?.message ?? "some requests failed"}.`);
      if (items.length > 1) {
        const counts = itemCounts(items.map((i) => i.status));
        head.push(`Coverage: ${counts.completed} of ${items.length} item(s) usable.`);
        const gaps = items.filter((i) => i.status !== "completed");
        if (gaps.length) head.push(`Not covered: ${gaps.map((g) => `${sourceLabel(g)} (${g.status})`).join("; ")}`);
      }
    }
    if (job.kind === "synthesis" && job.synthesis) {
      head.push("", `Synthesis of source job: ${job.synthesis.sourceJobId}   Synthesis job: ${localId}`, "", "COVERAGE (recorded locally, not written by the model):", renderCoverage(this.synthesisCoverage(job)!));
    }
    if (config.includeObjective) head.push("", "Original objective:", job.objective);
    head.push("", "Result:");
    const tail: string[] = [];
    if (config.includeArtefactPaths) tail.push("", "Local artefacts:", this.registry.jobDir(localId));
    tail.push(
      "",
      `Note: this is batch-generated analysis (model ${job.model}, retrieved ${formatIsoShort(job.retrievedAt)}). ` +
        "Validate it against the current repository before making changes.",
    );
    const assemble = (body: string) => [...head, body, ...tail].join("\n");

    const full = assemble(result);
    if (mode === "full" || full.length <= config.maxCharacters) return { ok: true, content: full, characters: full.length, bounded: false, injectedJobId: localId };
    const flag = target.item ? ` --item ${target.item}` : "";
    if (mode === "default") {
      return {
        ok: false,
        message:
          `${localId} result is ${full.length} characters, above injection.maxCharacters (${config.maxCharacters}).\n` +
          `Nothing was injected. Choose explicitly:\n` +
          `  /batch inject ${localId}${flag} --summary   bounded excerpt (first ~${config.maxCharacters} characters, clearly marked)\n` +
          `  /batch inject ${localId}${flag} --full      the complete result` +
          (items.length > 1 && !target.item ? `\n  /batch inject ${localId} --item <n>   one item` : ""),
      };
    }
    // --summary: bounded, explicitly marked excerpt (not a model-generated summary).
    const marker = (shown: number) => `\n\n[EXCERPT: first ${shown} of ${result.length} result characters. Full result: ${resultPath}]`;
    const budget = Math.max(500, config.maxCharacters - assemble("").length - marker(result.length).length);
    let excerpt = result.slice(0, budget);
    const lastNl = excerpt.lastIndexOf("\n");
    if (lastNl > budget * 0.8) excerpt = excerpt.slice(0, lastNl);
    const content = assemble(excerpt + marker(excerpt.length));
    return { ok: true, content, characters: content.length, bounded: true, injectedJobId: localId };
  }

  public recordInjection(localId: string, details: { mode: InjectMode; characters: number; bounded: boolean; item?: number }): void {
    this.withLock(localId, () =>
      this.registry.update(localId, (u) => {
        u.manifest.injectedAt = nowIso();
        u.manifest.injectionCount += 1;
        u.note("injected", details);
      }),
    );
    this.logger.log("info", "injected", { localId, ...details });
  }
}

function withSystemPrompt(includeInstructions: boolean, userText: string): ChatMessage[] {
  return includeInstructions
    ? [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userText },
      ]
    : [{ role: "user", content: userText }];
}

export function itemCounts(statuses: readonly string[]): { completed: number; failed: number; corrupt: number; missing: number } {
  const c = (s: string) => statuses.filter((x) => x === s).length;
  return { completed: c("completed"), failed: c("failed"), corrupt: c("corrupt"), missing: c("missing") };
}

/** Duplicate-detection hash: canonical JSON of the request with custom_ids masked. */
export function contentHash(body: SubmitBody): string {
  const masked = { ...body, requests: body.requests.map((r) => ({ ...r, custom_id: "{custom_id}" })) };
  return sha256Hex(canonicalJson(masked));
}

export function formatUsage(u: NonNullable<JobManifest["usage"]>): string {
  const parts: string[] = [];
  if (u.inputTokens !== undefined) parts.push(`input ${u.inputTokens} tok`);
  if (u.outputTokens !== undefined) parts.push(`output ${u.outputTokens} tok`);
  if (u.cost !== undefined) parts.push(`charged $${u.cost.toFixed(6)}`);
  if (u.isByok !== undefined) parts.push(u.isByok ? "BYOK" : "not BYOK");
  if (u.upstreamInferenceCost !== undefined) parts.push(`upstream est. $${u.upstreamInferenceCost.toFixed(6)}`);
  return parts.join(", ") || "none reported";
}

function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}
