import type { NormalisedUsage } from "./openrouter/normalise-result.js";
import type { ProviderPin } from "./openrouter/types.js";
import type { PrivacyLevel, Route } from "./privacy/policy.js";
import type { LocalStatus } from "./state.js";

/**
 * One local job = one OpenRouter batch = one or more request items.
 *
 * Persisted as `<storage>/<localId>/manifest.json` (atomic snapshot). The
 * append-only `events.jsonl` next to it is the lifecycle history.
 * All timestamps are ISO-8601 UTC strings.
 *
 * Schema versions:
 *   1  Release 1: single-request goals. No `kind`, `items`, `workflow`, `synthesis`.
 *      Read as-is and never rewritten to v2; `jobItems()` derives a one-item view.
 *   2  Release 2: adds per-item inventory and workflow/synthesis linkage.
 *   3  Release 3: dataset workflow jobs (project workflow + CSV/JSONL rows, optional
 *      JSON Schema output validation). Only these jobs (and their retries) are written
 *      as v3, so a Release 2 build reports them as unreadable instead of retrieving
 *      them without schema validation. Every other new job is still written as v2.
 *   4  Batch chat jobs (kind "chat", with `chat` linkage). Only chat jobs are written as v4.
 */
export const MANIFEST_SCHEMA_VERSION = 2;
export const DATASET_MANIFEST_SCHEMA_VERSION = 3;
export const CHAT_MANIFEST_SCHEMA_VERSION = 4;
export type ManifestSchemaVersion = 1 | 2 | 3 | 4;

export type JobKind = "goal" | "workflow" | "synthesis" | "chat";

export interface ChatLinkage {
  threadId: string;
  purpose: "turn" | "compact";
  throughSeq: number;
  titleItem: boolean;
}

export function isChatJob(job: Pick<JobManifest, "kind">): boolean {
  return job.kind === "chat";
}

/**
 * Item result state, separate from both the local batch status and the
 * provider's batch status.
 *   planned    persisted, not yet accepted by OpenRouter
 *   submitted  part of an accepted batch; no item result retrieved (yet)
 *   completed  usable, validated output
 *   failed     provider/model reported an error, non-2xx, or produced no text
 *   corrupt    a result came back but could not be interpreted or failed validation
 *   missing    the completed batch did not return this custom_id
 */
export const ITEM_STATUSES = ["planned", "submitted", "completed", "failed", "corrupt", "missing"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export interface ItemSource {
  /** goal: an `/batch ask` request; file/group: map-files; row: a dataset row; synthesis: a synthesis request. */
  kind: "goal" | "file" | "group" | "row" | "synthesis";
  /** Workspace-relative path (kind "file"). */
  path?: string;
  /** Workspace-relative paths (kind "group", or the files of a goal). */
  paths?: string[];
  label?: string;
  /** kind "row": the stable logical source ID (from the workflow's idField; never the provider custom_id). */
  sourceId?: string;
  /** kind "row": workspace-relative dataset path. */
  file?: string;
  /** kind "row": 1-based CSV data record (header excluded). */
  row?: number;
  /** kind "row": 1-based physical JSONL line. */
  line?: number;
}

export interface JobItem {
  customId: string;
  /** 1-based position in the submitted `requests` array (never the provider's result order). */
  ordinal: number;
  source: ItemSource;
  /** SHA-256 of the canonical request item body (custom_id excluded), so lineage survives re-identification. */
  requestSha256?: string;
  /** Characters of the user prompt for this item (not tokens). */
  characters?: number;
  /** Dataset rows: SHA-256 of the canonical selected input (source ID + selected field values). */
  inputSha256?: string;
  status: ItemStatus;
  validation?: { valid: boolean; errors: string[]; warnings: string[] };
  error?: { code?: string; message: string };
  finishReason?: string;
  /** Only what the provider returned for this item; never apportioned from batch totals. */
  usage?: NormalisedUsage;
  /** Retry lineage: the parent item this one re-runs. */
  replaces?: { jobId: string; customId: string; ordinal: number };
}

export type WorkflowInfo = MapFilesWorkflowInfo | DatasetWorkflowInfo | MetadataWorkflowInfo;

/**
 * Built-in Databricks metadata enrichment (Phase 1): one table per request, shared
 * domain context. Evidence and per-table hashes are in request/metadata.json.
 */
export interface MetadataWorkflowInfo {
  name: "databricks-metadata";
  /** 1: generic; 2: opt-in UC standards mode (then `standards` is set). */
  version: 1 | 2;
  standards?: { domain: string; ucPrefix: string };
  origin: "builtin";
  context: { path: string; sha256: string; bytes: number };
  input: { path: string; sha256: string; bytes: number; tables: number; tablesWithSamples: number };
  planSha256: string;
}

export function isMetadataWorkflow(w: WorkflowInfo | undefined): w is MetadataWorkflowInfo {
  return !!w && w.name === "databricks-metadata" && (w as MetadataWorkflowInfo).origin === "builtin";
}

export interface MapFilesWorkflowInfo {
  name: "map-files";
  version: 1;
  options: { groupSize: number; format: "markdown" | "json"; includeInstructions: boolean };
}

/**
 * A project workflow run over a dataset. The full resolved definition, a verbatim
 * copy of the YAML and the dataset mapping are request artefacts
 * (request/workflow.json, request/workflow.yaml, request/dataset.json); the
 * manifest keeps the identity and the facts needed for summaries.
 */
export interface DatasetWorkflowInfo {
  name: string;
  /** The workflow definition's schemaVersion. */
  version: 1;
  origin: "project";
  /** Workspace-relative path of the definition when the job was planned. */
  definitionFile: string;
  /** SHA-256 of the definition file bytes. */
  definitionSha256: string;
  /** SHA-256 of the canonical resolved definition. */
  resolvedSha256: string;
  output: "markdown" | "json";
  synthesisEnabled: boolean;
  dataset: DatasetInfo;
  selection: DatasetSelection;
  /** SHA-256 of the logical plan (source IDs, request hashes, model, pin); equal for identical inputs. */
  planSha256: string;
}

export interface DatasetInfo {
  type: "csv" | "jsonl";
  /** Workspace-relative path. */
  path: string;
  sha256: string;
  bytes: number;
  idField: string;
  fields: string[];
  totalRows: number;
  selectedRows: number;
  excludedRows: number;
  invalidRows: number;
  blankLines: number;
}

export interface DatasetSelection {
  /** Stable source IDs given with --id, in the order given (planning uses dataset order). */
  ids?: string[];
  fromRow?: number;
  toRow?: number;
}

export function isDatasetWorkflow(w: WorkflowInfo | undefined): w is DatasetWorkflowInfo {
  return !!w && (w as DatasetWorkflowInfo).origin === "project";
}

export interface ExportRecord {
  format: "jsonl" | "csv";
  /** Workspace-relative path of the written file. */
  path: string;
  sha256: string;
  records: number;
  combined: boolean;
  at: string;
}

export interface SynthesisSourceRef {
  /** Job holding the result actually used (the source job, or a linked retry job). */
  jobId: string;
  customId: string;
  /** Ordinal of the item in the source (root) job. */
  sourceOrdinal: number;
  source: ItemSource;
}

export interface SynthesisLinkage {
  sourceJobId: string;
  expectedItems: number;
  included: SynthesisSourceRef[];
  excluded: Array<{ sourceOrdinal: number; customId: string; source: ItemSource; status: ItemStatus | "no_result"; reason: string }>;
  allowPartial: boolean;
}

export interface JobManifest {
  schemaVersion: ManifestSchemaVersion;
  localId: string;
  /** Absent on Release 1 manifests, which are always "goal". */
  kind?: JobKind;
  providerBatchId?: string;
  parentJobId?: string;
  retryCount: number;
  /** Set on jobs created by `/batch retry-items`. */
  retryMode?: "full" | "items";

  objective: string;
  model: string;
  /** Service the job was sent to. Always "openrouter". */
  provider: "openrouter";
  /** Pi provider/account alias whose API key is used (e.g. "openrouter-work"). */
  account: string;
  /** Optional upstream provider pin (`provider.only` in the OpenRouter request). */
  providerPin?: ProviderPin;
  /** How the job's requests are sent. Absent means "batch" (every job made before the immediate route). */
  route?: Route;
  /**
   * The privacy level enforced when this job was created, and how. Absent on
   * jobs made before privacy levels existed (they were sent at `standard`).
   */
  privacy?: { level: PrivacyLevel; route: Route; enforcement: string };
  /** Deletion of the finished batch at OpenRouter (strict levels only). Absent when not applicable. */
  remoteDeletion?: { state: "pending" | "done" | "failed"; attempts: number; lastError?: string; at?: string };
  endpoint: "/v1/chat/completions";
  format: "markdown" | "json";

  localStatus: LocalStatus;
  /** Verbatim provider status string; never interpreted as local status. */
  providerStatus?: string;

  requestCount: number;
  completedCount?: number;
  failedCount?: number;
  /** Stored verbatim at creation; results are matched against these, never regenerated. */
  customIds: string[];
  /** Release 2 per-item inventory (same order as `customIds`). */
  items?: JobItem[];
  workflow?: WorkflowInfo;
  synthesis?: SynthesisLinkage;
  chat?: ChatLinkage;
  /** Exports written by `/batch export` (explicit user command only). */
  exports?: ExportRecord[];

  createdAt: string;
  submittedAt?: string;
  providerCreatedAt?: string;
  finalizedAt?: string;
  retrievedAt?: string;
  injectedAt?: string;
  cancelRequestedAt?: string;

  nextPollAt?: string;
  lastPollAt?: string;
  pollAttempts: number;
  consecutivePollFailures: number;
  lastPollError?: { category: string; message: string; httpStatus?: number; at: string };

  /**
   * Job-relative path of the raw final response this job's results were derived
   * from (write-once). Lets an interrupted retrieval finish from local evidence.
   */
  finalResponseFile?: string;

  /** Batch-level usage exactly as reported. */
  usage?: NormalisedUsage;

  /** SHA-256 of the exact bytes POSTed to OpenRouter. */
  requestSha256?: string;
  /** SHA-256 of the canonical request with custom_ids masked; used for duplicate detection. */
  contentSha256?: string;

  context: { fileCount: number; characters: number; excludedCount: number };
  injectionCount: number;

  error?: { code: string; message: string };
  warnings: string[];
}

export interface JobEvent {
  id: string;
  localId: string;
  eventType: string;
  previousStatus?: LocalStatus;
  newStatus?: LocalStatus;
  eventAt: string;
  details?: Record<string, unknown>;
}
