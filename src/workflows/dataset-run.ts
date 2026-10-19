import { formatSecretFindings, scanForSecrets, type SecretFinding } from "../context/secrets.js";
import { heading } from "../context/package.js";
import { decodeDatasetBytes, identityProblems, parseDataset, type DatasetRecord } from "../datasets/dataset.js";
import { canonicalJson, sha256Hex } from "../fsutil.js";
import type { BatchRequestItem, ChatMessage, ProviderPin } from "../openrouter/types.js";
import type { DatasetInfo, DatasetSelection, ItemSource } from "../types.js";
import type { WorkflowDefinition } from "./definition.js";
import { parseTemplate, renderTemplate } from "./template.js";

/**
 * Deterministic planning of a project workflow over a dataset (pure: the caller
 * supplies the file bytes and resolves paths, keys and config).
 *
 * For identical workflow definition, dataset bytes, selection, model, provider
 * pin and max_tokens, the plan is identical: same rows in dataset order, same
 * prompts, same request bodies and hashes (`planSha256`). Only the local job ID,
 * and with it the provider custom_ids, differ between runs.
 *
 * Only selected fields reach a prompt, and every provider-bound message is
 * secret-scanned exactly as it will be sent (unselected columns are never read
 * into a prompt, so they are neither sent nor scanned).
 */

export const OUTPUT_FORMAT_HEADING = "OUTPUT FORMAT";

export interface EffectiveLimits {
  maxRequests: number;
  maxRows: number;
  maxCharactersPerItem: number;
  maxTotalCharacters: number;
}

export interface DatasetPlanInput {
  definition: WorkflowDefinition;
  resolvedSha256: string;
  dataset: { relPath: string; bytes: Buffer };
  selection: DatasetSelection;
  model: string;
  pin?: ProviderPin;
  maxTokens: number;
  limits: EffectiveLimits;
  security: { scanSecrets: boolean; blockOnSecret: boolean; knownSecrets: readonly string[] };
}

export interface DatasetPlanItem {
  ordinal: number;
  source: ItemSource;
  /** The selected field values sent for this row. */
  values: Record<string, string>;
  inputSha256: string;
  prompt: string;
  /** Provider-bound characters (all message contents; not tokens). */
  characters: number;
  body: BatchRequestItem["body"];
  requestSha256: string;
}

export interface DatasetPlanCounts {
  totalRows: number;
  selectedRows: number;
  excludedRows: number;
  invalidRows: number;
  plannedRequests: number;
  missingIds: number;
  duplicateIds: number;
  blankLines: number;
}

export interface DatasetPlan {
  dataset: DatasetInfo;
  selection: DatasetSelection;
  items: DatasetPlanItem[];
  counts: DatasetPlanCounts;
  totalCharacters: number;
  largest?: { characters: number; label: string };
  secretFindings: SecretFinding[];
  /** Equal for identical logical inputs (see module comment). */
  planSha256: string;
  blockers: string[];
  warnings: string[];
}

const MAX_LISTED = 20;

function listed(messages: string[], what: string): string {
  const shown = messages.slice(0, MAX_LISTED).map((m) => `  - ${m}`);
  if (messages.length > MAX_LISTED) shown.push(`  … ${messages.length - MAX_LISTED} more`);
  return `${what}:\n${shown.join("\n")}`;
}

export function rowLabel(source: Pick<ItemSource, "sourceId" | "row" | "line">): string {
  const where = source.row !== undefined ? `row ${source.row}` : source.line !== undefined ? `line ${source.line}` : "";
  return `${source.sourceId ?? "?"}${where ? ` (${where})` : ""}`;
}

/** The fixed output instructions appended (after the rendered template) for JSON workflows. */
export function outputInstructions(schema: Record<string, unknown>): string {
  return [
    heading(OUTPUT_FORMAT_HEADING),
    "",
    "Respond with exactly one JSON object that conforms to the JSON Schema below.",
    "Do not add any text before or after the JSON object, and do not wrap it in a code fence.",
    "",
    JSON.stringify(schema, null, 2),
  ].join("\n");
}

export function planDatasetRun(input: DatasetPlanInput): DatasetPlan {
  const def = input.definition;
  const blockers: string[] = [];
  const warnings: string[] = [];
  const datasetSha256 = sha256Hex(input.dataset.bytes);
  const datasetBase = { type: def.input.type, path: input.dataset.relPath, sha256: datasetSha256, bytes: input.dataset.bytes.length, idField: def.input.idField, fields: [...def.input.fields] };
  const empty = (): DatasetPlan => ({
    dataset: { ...datasetBase, totalRows: 0, selectedRows: 0, excludedRows: 0, invalidRows: 0, blankLines: 0 },
    selection: input.selection,
    items: [],
    counts: { totalRows: 0, selectedRows: 0, excludedRows: 0, invalidRows: 0, plannedRequests: 0, missingIds: 0, duplicateIds: 0, blankLines: 0 },
    totalCharacters: 0,
    secretFindings: [],
    planSha256: "",
    blockers,
    warnings,
  });

  const text = decodeDatasetBytes(input.dataset.bytes);
  if (text === undefined) {
    blockers.push(`dataset ${input.dataset.relPath} is not valid UTF-8 text`);
    return empty();
  }
  const parsed = parseDataset(text, { type: def.input.type, idField: def.input.idField, fields: def.input.fields, delimiter: def.input.delimiter });
  if (parsed.fatal.length > 0) {
    blockers.push(listed(parsed.fatal, `dataset ${input.dataset.relPath} cannot be used`));
    return empty();
  }
  const records = parsed.records;
  const identity = identityProblems(records, def.input.type);
  if (identity.messages.length > 0) {
    blockers.push(listed(identity.messages, `source IDs must be present and unique in every row (${identity.missing} missing, ${identity.duplicates} duplicate)`));
  }
  const duplicateRows = new Set<number>();
  {
    const seen = new Set<string>();
    for (const r of records) {
      if (r.id === undefined) continue;
      if (seen.has(r.id)) duplicateRows.add(r.index);
      seen.add(r.id);
    }
  }
  const isInvalid = (r: DatasetRecord) => r.problems.length > 0 || duplicateRows.has(r.index);
  const where = (r: DatasetRecord) => (r.row !== undefined ? `row ${r.row}` : `line ${r.line}`);

  // ---- selection (dataset order is always kept) ----
  const sel = input.selection;
  let selected: DatasetRecord[] = records;
  if (sel.ids && sel.ids.length > 0 && (sel.fromRow !== undefined || sel.toRow !== undefined)) {
    blockers.push("use either --id or --from-row/--to-row, not both");
  } else if (sel.ids && sel.ids.length > 0) {
    const wanted = new Set(sel.ids);
    if (wanted.size < sel.ids.length) warnings.push("a source ID was given more than once with --id; each row is planned once");
    const known = new Set(records.map((r) => r.id).filter((x): x is string => x !== undefined));
    const unknown = [...wanted].filter((id) => !known.has(id));
    if (unknown.length > 0) blockers.push(listed(unknown.map((u) => JSON.stringify(u.slice(0, 64))), "--id names source IDs that are not in the dataset"));
    selected = records.filter((r) => r.id !== undefined && wanted.has(r.id));
  } else if (sel.fromRow !== undefined || sel.toRow !== undefined) {
    const from = sel.fromRow ?? 1;
    const to = sel.toRow ?? records.length;
    if (!Number.isInteger(from) || from < 1) blockers.push("--from-row must be a positive integer");
    else if (!Number.isInteger(to) || to < from) blockers.push("--to-row must be an integer not less than --from-row");
    else if (from > records.length || to > records.length) blockers.push(`row range ${from}-${to} is outside the dataset (rows 1-${records.length})`);
    selected = records.filter((r) => r.index >= from && r.index <= to);
  }

  const invalidSelected = selected.filter((r) => r.problems.length > 0 && r.id !== undefined);
  if (invalidSelected.length > 0) blockers.push(listed(invalidSelected.map((r) => `${where(r)}: ${r.problems.join("; ")}`), "selected rows have invalid fields"));
  const invalidUnselected = records.filter((r) => !selected.includes(r) && r.problems.length > 0 && r.id !== undefined).length;
  if (invalidUnselected > 0) warnings.push(`${invalidUnselected} unselected row(s) have invalid fields (not planned)`);
  if (selected.length === 0 && blockers.length === 0) blockers.push("no rows selected");

  // ---- prompts, bodies, hashes ----
  const template = parseTemplate(def.request.prompt);
  const suffix = def.output.type === "json" ? outputInstructions(def.output.schema) : "";
  const items: DatasetPlanItem[] = [];
  // With missing or duplicate IDs anywhere, no row has a trustworthy identity: nothing is planned.
  const identitySound = identity.messages.length === 0;
  for (const r of identitySound ? selected : []) {
    if (r.id === undefined || r.problems.length > 0) continue;
    const values: Record<string, string> = {};
    for (const f of def.input.fields) values[f] = r.values[f]!;
    const rendered = renderTemplate(template, values);
    const prompt = suffix ? `${rendered.replace(/\s+$/, "")}\n\n${suffix}\n` : rendered;
    const messages: ChatMessage[] = def.request.system ? [{ role: "system", content: def.request.system }, { role: "user", content: prompt }] : [{ role: "user", content: prompt }];
    const body: BatchRequestItem["body"] = { messages, max_tokens: input.maxTokens };
    const source: ItemSource = {
      kind: "row",
      sourceId: r.id,
      file: input.dataset.relPath,
      ...(r.row !== undefined ? { row: r.row } : {}),
      ...(r.line !== undefined ? { line: r.line } : {}),
    };
    items.push({
      ordinal: items.length + 1,
      source,
      values,
      inputSha256: sha256Hex(canonicalJson({ sourceId: r.id, fields: values })),
      prompt,
      characters: messages.reduce((n, m) => n + m.content.length, 0),
      body,
      requestSha256: sha256Hex(canonicalJson(body)),
    });
  }
  const totalCharacters = items.reduce((n, it) => n + it.characters, 0);
  const largestItem = items.reduce<DatasetPlanItem | undefined>((a, b) => (!a || b.characters > a.characters ? b : a), undefined);

  // ---- local limits (not OpenRouter limits) ----
  const L = input.limits;
  if (selected.length > L.maxRows) blockers.push(`${selected.length} rows selected; the row limit is ${L.maxRows} (local policy: workflows.maxRowsPerRun / limits.maxRows). Select a subset with --id or --from-row/--to-row.`);
  if (items.length > L.maxRequests) blockers.push(`plan has ${items.length} requests; the request limit is ${L.maxRequests} (local policy: workflows.maxRequestsPerBatch / limits.maxRequests). Plans are never split into several batches automatically.`);
  const oversized = items.filter((it) => it.characters > L.maxCharactersPerItem);
  if (oversized.length > 0) blockers.push(listed(oversized.map((it) => `item ${it.ordinal} (${rowLabel(it.source)}): ${it.characters} characters`), `items above the per-item limit of ${L.maxCharactersPerItem} characters (local policy)`));
  if (totalCharacters > L.maxTotalCharacters) blockers.push(`plan totals ${totalCharacters} characters; the limit is ${L.maxTotalCharacters} (local policy)`);

  // ---- secret scan of exactly what is sent ----
  const secretFindings: SecretFinding[] = [];
  if (input.security.scanSecrets) {
    if (def.request.system) secretFindings.push(...scanForSecrets(def.request.system, "<workflow system prompt>", input.security.knownSecrets));
    for (const it of items) {
      secretFindings.push(...scanForSecrets(it.prompt, `item ${String(it.ordinal).padStart(3, "0")} (${def.input.type === "csv" ? `row ${it.source.row}` : `line ${it.source.line}`})`, input.security.knownSecrets));
    }
    if (secretFindings.length > 0 && input.security.blockOnSecret) blockers.push(formatSecretFindings(secretFindings));
  } else {
    warnings.push("secret scanning is disabled by configuration");
  }

  const invalidRows = records.filter(isInvalid).length;
  const counts: DatasetPlanCounts = {
    totalRows: records.length,
    selectedRows: selected.length,
    excludedRows: records.length - selected.length,
    invalidRows,
    plannedRequests: items.length,
    missingIds: identity.missing,
    duplicateIds: identity.duplicates,
    blankLines: parsed.blankLines,
  };
  const planSha256 = sha256Hex(
    canonicalJson({
      workflow: input.resolvedSha256,
      dataset: datasetSha256,
      selection: sel,
      model: input.model,
      pin: input.pin ?? null,
      items: items.map((it) => ({ sourceId: it.source.sourceId, requestSha256: it.requestSha256 })),
    }),
  );
  return {
    dataset: { ...datasetBase, totalRows: counts.totalRows, selectedRows: counts.selectedRows, excludedRows: counts.excludedRows, invalidRows, blankLines: parsed.blankLines },
    selection: sel,
    items,
    counts,
    totalCharacters,
    ...(largestItem ? { largest: { characters: largestItem.characters, label: rowLabel(largestItem.source) } } : {}),
    secretFindings,
    planSha256,
    blockers,
    warnings,
  };
}
