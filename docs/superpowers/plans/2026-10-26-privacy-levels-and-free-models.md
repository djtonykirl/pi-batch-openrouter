# Privacy Levels, Free Models and UC Metadata Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every request honours a per-project privacy level (`standard` / `no-training` / `zdr`). Free models become available in batch-chat threads through an immediate route. There is a fresh model catalog each session and full web UI support.

**Architecture:**
- **Pure privacy policy.** `src/privacy/policy.ts` decides, for a level, a model, a route, an optional user provider pin and a catalog snapshot, either the provider fields to send or a refusal.
- **Model catalog.** `src/models/catalog.ts` loads `/api/v1/models` and `/api/v1/endpoints/zdr` once per session, with a last-known copy on disk for display only.
- **One enforcement point.** `BatchService.persistJob` becomes async and is the single place every job's privacy is enforced and recorded.
- **Immediate route.** Free models go through `POST /chat/completions`. Each request is still a job manifest that settles through the existing `finishRetrieval` path, so ChatService is unaware of routes except when choosing one.
- **Remote deletion.** At `no-training` and `zdr`, finished batches are deleted at OpenRouter after the raw response is saved.

- **UC metadata enrichment (TDD Phase A, Tasks 9–12).** Four additions:
  - **Notebook cleaning.** `.ipynb` files lose their outputs before packaging.
  - **Standards mode.** It is opt-in on the `databricks-metadata` workflow and enforces the Fulcrum description and comment formats and the ungoverned UC tag taxonomy, including sparse column PII tags.
  - **Tags in the handoff.** Review and `approved.jsonl` carry tags.
  - **A web studio tab** for the workflow.
  - Metadata jobs already go through `persistJob`, so Task 3's privacy enforcement covers them without extra work.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Pi extension API 0.86, node:test, `FakeOpenRouter` fixtures.

**Spec:** `docs/superpowers/specs/2026-10-26-privacy-levels-and-free-models-design.md` (read it first). Base branch: `privacy-models` (from `batch-chat`, PR #1).

**Second spec (Tasks 9–12):** `C:\CODE\LighthouseModernization\docs\uc-migration\TDD_UC_Metadata_Enrichment.md` v1.1, §3.2–3.4, §4.2–4.3, §6, §7 and §9 Phase A.
- Its taxonomy and formats come from `C:\CODE\LighthouseModernization\.claude\skills\lighthouse-data-governance\references\{DESCRIPTION_STANDARDS,CLASSIFICATION_TAXONOMY,adversarial_checks}.md`.
- Phase B (`metadata_policy.py`, the applier notebook and the Pinpoint pilot) lives in the LighthouseModernization repo and is **not** in this plan.
- Where the TDD is silent, the "Rulings on the TDD" section below decides.

## Global Constraints

- **Levels:** `PrivacyLevel = "standard" | "no-training" | "zdr"`, ordered standard < no-training < zdr. The effective level is the stricter of thread and project. The extension never sends anything less strict than the effective level.
- **Byte-identical at `standard`:** batch request bodies are unchanged from today's (duplicate detection hashes them).
- **Batch bodies:** may carry only `provider.only` and `provider.allow_fallbacks`. Never add `data_collection` or `zdr` to a batch body.
- **Immediate bodies:** carry `provider: { data_collection: "deny" }` at `no-training`, and `provider: { zdr: true }` at `zdr`.
- **`zdr` on batch:** pin `provider.only` to the ZDR providers for the normalised model, plus `allow_fallbacks: false`. Refuse when there are none, or when the catalog was not loaded successfully in this session.
- **`no-training` on batch:** allowed only when `privacy.accountNoTraining === true`. Otherwise refuse.
- **Remote deletion:** delete a batch at OpenRouter only when that job's own recorded `privacy.level` is `no-training` or `zdr` and `privacy.deleteRemoteBatches` is true. Never base this on the current config level.
  - A completed batch is deleted only after its raw final response is on disk.
  - A batch that ends `failed`, `expired` or `cancelled` at OpenRouter is deleted too, since there is nothing more to retrieve; its last status is the saved evidence. A 410 "gone" batch is not deleted.
  - Failed deletes retry with exponential backoff for up to 24 hours from the first attempt, then show as needing attention. A missing API key is not an attempt: the job shows as waiting for a key.
  - *(Revised after the final review: the original wording covered only the retrieval case.)*
- **Model slugs:** normalise before any catalog lookup by stripping `:batch` and `:free`.
- **Route by model ID:** `:free` → `"immediate"`; anything else → `"batch"`, unless the picker set `route` explicitly.
- **Catalog freshness:** load on every Pi `session_start`, web server start and web workspace switch, plus on manual refresh. Loads are deduplicated. A catalog read from disk is `fresh: false` and is used only for display.
- **Refusal wording:** start with `"Privacy level <level>: "` and give the reason.
- **Batch-chat guarantees still hold:** isolation (no `sendMessage` under `src/chat/`, `src/web/`, `src/privacy/`, `src/models/`), the append-only transcript, the secret scan before saving or sending, one turn in flight per thread, and conversation order.
- **Web:** every new endpoint uses the existing session-cookie authentication, Host/Origin checks and CSRF protection. The server re-validates every level, model and route.
- **Config defaults:** `privacy.level: "standard"`, `privacy.accountNoTraining: false`, `privacy.deleteRemoteBatches: true`, `privacy.noticeShown: false`.

**UC metadata (Tasks 9–12):**
- **Standards mode is opt-in.**
  - It is on only when a metadata plan is given both `domain` (a lowercase slug, `^[a-z][a-z0-9_]*$`) and `ucPrefix` (`^[A-Z0-9]+_$`). Giving only one is an error.
  - Without them, requests, proposals, review and `approved.jsonl` are byte-identical to today's `databricks-metadata` version 1.
  - Standards-mode jobs record `version: 2` and `standards: { domain, ucPrefix }`.
- **Table description lines, in order:** `GRAIN:`, `PURPOSE:`, `SOURCE:`, `REFRESH:`, `OWNER:`, `CLASSIFICATION:`. A description is at least 30 characters.
- **Column comment:**
  - It is a plain-English definition line, then `TYPE:` (one of `Dimension`, `Measure`, `Key`, `Flag`, `Timestamp`), `VALUES:`, `SYNONYMS:` and `NULL MEANS:`, which are required.
  - `UNIT:`, `FORMULA:` and `JOIN:` are optional.
  - It is at least 30 characters.
- **Table tags:** exactly `classification`, `data_domain`, `uc_prefix`, `medallion_layer` and `pii`.
  - `classification` ∈ `public|internal|confidential|restricted|pii_scan_required`.
  - `medallion_layer` ∈ `bronze|silver|gold`.
  - `pii` ∈ `true|false`, and it is `"true"` if and only if some column has `pii: "true"`.
- **Column tags:** `{}`, or exactly `pii: "true"` plus:
  - `pii_type` ∈ `email|phone|ssn|name|address|dob|ip_address|device_id|financial|health|biometric|location`;
  - `sensitivity` ∈ `low|medium|high`;
  - `requires_masking` ∈ `true|false`.
  - `pii: "false"` is never emitted on a column.
- **Framework audit columns** (`fw_pipelinerowchecksum`, `fw_ingestdate`, `pipeline_timestamp`, matched case-insensitively) are never sent to the model. Their approved values are the existing values. The Lighthouse applier assigns their standard definitions.
- **No SQL, no Databricks connection, never `GRANT` or `REVOKE`.** Pi still only produces files.
- **Notebook text format:**
  - The first line is `# Databricks notebook source`.
  - Cells are separated by `\n\n# COMMAND ----------\n\n`.
  - Markdown cells become `# MAGIC %md` followed by one `# MAGIC <line>` per source line (`# MAGIC` alone for an empty line).
  - Code cells are their source verbatim.
  - Outputs, `execution_count`, attachments, raw cells and all metadata are dropped.

## Review Focus

1. **A user `--provider X` pin at `zdr` where X has no ZDR endpoint for the model:** refuse; never send the user's pin unfiltered. *Test in Task 3.*
2. **Thread model `"x/y:free"` or `"x/y:batch"` looked up in the ZDR list:** match after normalisation. A raw-ID mismatch must not make a ZDR model look unavailable, or let a different model through. *Test in Task 1.*
3. **The project level lowered in config while a thread is at a higher level:** the thread keeps its higher effective level. *Test in Task 6.*
4. **The catalog fails at session start, then a refresh succeeds:** `zdr` sends are refused before the refresh and allowed after it, with no restart needed. *Test in Task 2.*
5. **A job created at `standard` (or before this feature) after the project is raised to `zdr`:** it is never remotely deleted. *Test in Task 4.*

**UC metadata:**
6. **A notebook whose outputs contain a secret-looking string or a base64 image:** nothing from the outputs is sent, and the secret scan does not block. *Test in Task 9.*
7. **A version 1 metadata job made before this change** (no tags, no standards): summary, review, approved and validate-approved behave exactly as before. *Test in Task 11.*
8. **The model marks a column PII, but the table classification is `public`, or it sets column `pii: "false"`:** the item is `corrupt` with a schema problem, and it can be retried. *Test in Task 10.*
9. **An existing column comment that is not in the standard format:** in standards mode the draft takes the proposal instead, the review marks it as replacing a non-standard value, and `validate-approved` reports any non-standard approved value. *Test in Task 11.*
10. **A tables.jsonl table whose name does not start with the `ucPrefix`, or whose schema has no medallion layer:** the plan is blocked and lists the tables. *Test in Task 10.*

---

## Rulings on the TDD

These settle points the TDD leaves open. Each records what was decided, why, and what it costs if wrong.
- **R1. The model proposes only `classification` and column PII tags.** Pi derives `data_domain`, `uc_prefix` and `medallion_layer` from the plan options and the schema name (`lighthouse_bronze` → `bronze`: the first of `bronze|silver|gold` found in the schema part). Pi also derives the table `pii` from the column tags. *Why:* these values are facts, and a model can hallucinate them. *If wrong:* the model's prompt schema gains fields.
- **R2. Standards mode is opt-in.** It is enabled by `domain` plus `ucPrefix`, so the generic workflow and existing jobs are untouched. *If wrong:* it becomes the default later, as a config flip.
- **R3. Prefix scoping.** Pi blocks tables outside `ucPrefix` (case-insensitive) but does not read `scope.yaml`. Layer 2 file scoping is done by choosing files for the Pass 1 job, and Layer 3 filtering happens in the notebook export. *If wrong:* a `--scope scope.yaml` option is added later.
- **R4. In standards mode, the draft keeps an existing value only if it passes the standards checks**, and otherwise takes the proposal. Tags work the same way. *Why:* without this, the TDD's L1 gate would reject every draft that kept a legacy comment. *If wrong:* the reviewer reverts specific values by hand.
- **R5. A null approved value** (insufficient evidence) **stays allowed.** It is counted and listed, and the applier skips it.
- **R6. Pass 1 reverse-engineering needs no new workflow:** it is `/batch ask` (or the studio "Goal" tab) with the scoped files. The output is reviewed into `<Domain>_context.md` by the user.
- **R7. The preview warns** when tables carry sample values and the effective privacy level is `standard`. It does not block.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/privacy/policy.ts` (new) | Level types and ordering, `effectiveLevel`, `resolveBatchProvider`, `immediateProviderFields`, `normaliseModelSlug`, `routeForModel` |
| `src/models/catalog.ts` (new) | `ModelCatalog`: session load, dedup, last-known on disk, snapshot, labels |
| `src/openrouter/client.ts` | `deleteBatch`, `listModels`, `listZdrEndpoints`, `chatCompletion` |
| `src/openrouter/immediate.ts` (new) | Runs an immediate job's items; builds a batch-shaped final response; classifies 429s |
| `src/service.ts` | Async `persistJob` with privacy enforcement; immediate submit and reconcile; remote deletion pass |
| `src/types.ts`, `src/config.ts`, `src/chat/types.ts` | `privacy`/`route`/`remoteDeletion` manifest fields, `privacy.*` config, thread `privacyLevel`/`route` |
| `src/chat/service.ts`, `src/chat/session.ts`, `src/chat/commands.ts` | Thread level and route, model switch checks, footer badges, `/batch chat privacy`, picker |
| `src/privacy/commands.ts` (new), `src/commands.ts`, `src/runtime.ts`, `index.ts`, `src/poller.ts` | `/batch privacy …`, catalog wiring, deletion pass |
| `src/web/server.ts`, `src/web/ui.ts` | Privacy endpoints and controls |
| `src/context/notebook.ts` (new), `src/context/package.ts`, `src/attachments.ts` | `.ipynb` cleaning before packaging and upload |
| `src/metadata/standards.ts` (new) | Taxonomy constants, format/tag/PII-text checks, derived tags, audit-column list |
| `src/metadata/contract.ts`, `src/metadata/plan.ts`, `src/metadata/report.ts`, `src/metadata-commands.ts`, `src/types.ts`, `src/service.ts` | Tags and standards mode through plan, validation, review and handoff |
| `src/web/server.ts`, `src/web/ui.ts` | Studio "UC Metadata" tab and metadata job actions |
| `scripts/privacy-probe.mjs` (new), `README.md` | User-run probe and docs |
| `test/privacy-*.test.ts`, `test/catalog.test.ts`, `test/immediate.test.ts` (new) | One test file per new module |

Run one test file with: `npx tsc -p tsconfig.test.json && node --test .test-build/test/<name>.test.js`. Run everything with `npm test` (baseline 335 pass / 1 skipped) and type-check with `npm run check`.

---

### Task 1: Privacy policy core and config

**Files:**
- Create: `src/privacy/policy.ts`, `test/privacy-policy.test.ts`
- Modify: `src/config.ts` (interface, `DEFAULT_CONFIG`, `SCHEMA`)

**Interfaces:**
- Produces:
  ```ts
  export type PrivacyLevel = "standard" | "no-training" | "zdr";
  export const PRIVACY_LEVELS: readonly PrivacyLevel[];          // ordered, least → most strict
  export function isPrivacyLevel(v: unknown): v is PrivacyLevel;
  export function stricter(a: PrivacyLevel, b: PrivacyLevel): PrivacyLevel;
  export function effectiveLevel(project: PrivacyLevel, thread?: PrivacyLevel): PrivacyLevel;
  export function normaliseModelSlug(id: string): string;        // strips ":batch" and ":free"
  export type Route = "batch" | "immediate";
  export function routeForModel(id: string, explicit?: Route): Route;
  export interface ZdrEndpoint { model: string; provider: string }   // model already normalised; provider = slug usable in provider.only
  export interface CatalogView { fresh: boolean; zdr: ZdrEndpoint[] }
  export type ProviderDecision =
    | { ok: true; provider?: { only: string[]; allow_fallbacks: false } | ProviderPin; enforcement: string }
    | { ok: false; reason: string };
  export function resolveBatchProvider(input: { level: PrivacyLevel; model: string; userPin?: ProviderPin; catalog?: CatalogView; accountNoTraining: boolean }): ProviderDecision;
  export function immediateProviderFields(level: PrivacyLevel): { data_collection?: "deny"; zdr?: true };
  ```
  - `BatchConfig.privacy: { level: PrivacyLevel; accountNoTraining: boolean; deleteRemoteBatches: boolean; noticeShown: boolean }`.
- Rules:
  - **`standard`:** `{ ok: true, provider: userPin, enforcement: "none" }`.
  - **`no-training`:**
    - With `accountNoTraining` set: `{ ok: true, provider: userPin, enforcement: "account attested no-training" }`.
    - Otherwise: refuse with `"Privacy level no-training: batch providers can't be filtered per request; confirm your OpenRouter account disables training (/batch privacy attest) or use an immediate-route model"`.
  - **`zdr`:**
    - Refuse when `!catalog?.fresh`, with the reason containing `"model catalog not loaded this session"`.
    - Otherwise take the sorted unique providers for `normaliseModelSlug(model)`, intersected with `userPin.only` when a pin is given.
    - If none remain, refuse with the reason containing `"no ZDR provider"`.
    - Otherwise return `{ only, allow_fallbacks: false }` with `enforcement: "pinned to ZDR providers: a, b"`.

- [ ] **Step 1: Write the failing tests:**
  - **`levels order and stricter`:** `stricter("zdr", "standard") === "zdr"`; `effectiveLevel("no-training", undefined) === "no-training"`; `effectiveLevel("standard", "zdr") === "zdr"`.
  - **`normaliseModelSlug`:** `"a/b:free"` → `"a/b"`; `"a/b:batch"` → `"a/b"`; `"a/b"` unchanged.
  - **`routeForModel`:** `":free"` gives `"immediate"`, a plain ID gives `"batch"`, and an explicit route wins.
  - **`standard keeps the user pin unchanged`:** the result's `provider` deep-equals the input `userPin`, or is undefined when no pin is given.
  - **`no-training on batch`:** refused without attestation, with the reason starting `"Privacy level no-training: "`. Allowed with it, keeping the pin.
  - **`zdr pins to ZDR providers`:** the catalog has `{model:"a/b",provider:"p2"}` and `{model:"a/b",provider:"p1"}`. Model `"a/b:batch"` gives `{ only: ["p1","p2"], allow_fallbacks: false }` (Review Focus 2).
  - **`zdr refuses without a fresh catalog`**, and **`zdr refuses when the model has no ZDR provider`**.
  - **`immediateProviderFields`:** `standard` gives `{}`, `no-training` gives `{ data_collection: "deny" }`, `zdr` gives `{ zdr: true }`.
  - **`config defaults and validation`:** `DEFAULT_CONFIG.privacy` deep-equals the Global Constraints defaults, and `validateConfig({ privacy: { level: "bogus" } })` keeps `"standard"` and reports an error.
- [ ] **Step 2: Run** `npx tsc -p tsconfig.test.json && node --test .test-build/test/privacy-policy.test.js`. Expected: FAIL (the module is missing).
- [ ] **Step 3: Implement** `src/privacy/policy.ts` and the `privacy` config section, following the existing `SCHEMA` style.
- [ ] **Step 4: Run** the same command, then `npm run check`. Expected: PASS and clean.
- [ ] **Step 5: Commit** `feat(privacy): add privacy levels, policy decisions and config`.

---

### Task 2: Model catalog and client listing methods

**Files:**
- Create: `src/models/catalog.ts`, `test/catalog.test.ts`, `test/fixtures/catalog.ts`
- Modify: `src/openrouter/client.ts`

**Interfaces:**
- Consumes: `ZdrEndpoint`, `CatalogView`, `normaliseModelSlug` (Task 1).
- Produces:
  ```ts
  // client.ts
  public async listModels(): Promise<{ raw: RawExchange; models: CatalogModel[] }>;          // GET /models
  public async listZdrEndpoints(): Promise<{ raw: RawExchange; endpoints: ZdrEndpoint[] }>;  // GET /endpoints/zdr
  export function parseModels(text: string): CatalogModel[];
  export function parseZdrEndpoints(text: string): ZdrEndpoint[];
  // catalog.ts
  export interface CatalogModel { id: string; name: string; free: boolean; contextLength?: number }   // free = id endsWith ":free" || prompt and completion pricing === "0"
  export interface CatalogSnapshot extends CatalogView { models: CatalogModel[]; loadedAt: string; error?: string }
  export class ModelCatalog {
    constructor(deps: { fetch: () => Promise<{ models: CatalogModel[]; zdr: ZdrEndpoint[] }>; file: string; now?: () => Date; logger?: Logger })
    load(): Promise<CatalogSnapshot>;               // deduplicated: concurrent calls share one in-flight load
    snapshot(): CatalogSnapshot | undefined;        // after a failed load: last-known from disk with fresh=false and error set
    whenLoaded(timeoutMs: number): Promise<CatalogSnapshot | undefined>;
    labels(modelId: string): { free: boolean; zdr: boolean };
  }
  ```
- **Capture real shapes first:** `GET https://openrouter.ai/api/v1/models` and `GET https://openrouter.ai/api/v1/endpoints/zdr` are documented as public.
  - Fetch each once with `curl -s`, and save a trimmed sample (about 5 entries) as fixtures in `test/fixtures/catalog.ts`.
  - Write `parseZdrEndpoints` against the real field names. Record in your report which field becomes `provider` (the slug `provider.only` accepts) and why.
  - If either endpoint needs an API key, or its shape doesn't identify a provider slug, stop and report NEEDS_CONTEXT. Do not guess.

- [ ] **Step 1: Write the failing tests:**
  - **`parseModels marks free`:** from the real fixture.
  - **`parseZdrEndpoints normalises model slugs`:** from the real fixture.
  - **`load is deduplicated`:** two concurrent `load()` calls trigger one fetch.
  - **`a successful load is fresh and saved to disk`.**
  - **`failed load falls back to last-known with fresh=false`:**
    - Write the file, then build a new catalog whose fetch rejects.
    - `snapshot().fresh === false`, `snapshot().error` is set, and the models come from disk.
  - **`refresh after failure becomes fresh`** (Review Focus 4): the first fetch rejects and the second resolves. After the second `load()`, `snapshot().fresh === true`.
  - **`whenLoaded times out`:** returns `undefined` within the timeout when the fetch hangs.
- [ ] **Step 2: Run** `npx tsc -p tsconfig.test.json && node --test .test-build/test/catalog.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** the client methods (through the existing `request()`) and `ModelCatalog`. Save the disk file with `atomicWriteJson`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(models): add session model catalog with free and ZDR data`.

---

### Task 3: Enforce privacy at the single persistence point

**Files:**
- Modify: `src/service.ts` (`ServiceDeps`, `persistJob` and every caller), `src/types.ts`
- Test: `test/privacy-enforcement.test.ts`

**Interfaces:**
- Consumes: Task 1 `resolveBatchProvider`, Task 2 `ModelCatalog`.
- Produces:
  - `ServiceDeps.catalog?: ModelCatalog`.
  - `JobManifest.privacy?: { level: PrivacyLevel; route: Route; enforcement: string }`.
  - `JobManifest.route?: Route` (absent means `"batch"`).
  - `JobDraft.privacyLevel?: PrivacyLevel` (absent means the config's `privacy.level`).
  - `JobDraft.route?: Route`.
  - `persistJob(draft): Promise<JobManifest>`, now async. Callers `await` it.
- Behaviour:
  - **Batch route:** `persistJob` calls `resolveBatchProvider`. At `zdr` it first awaits `catalog.whenLoaded(requestTimeoutSeconds*1000)`.
    - A refusal throws `SubmissionBlockedError(reason)`.
    - Success replaces `draft.pin` with the decided provider and records `privacy`.
  - **Immediate route:** no pin is computed here (Task 5 adds the immediate fields). The job records `privacy` with `enforcement: "immediate: data_collection=deny"` / `"immediate: zdr=true"` / `"none"`.
  - **Retries** (`retry`, `retryItems`) and **synthesis** go through `persistJob`, so they are re-evaluated at the *current* effective level.
- [ ] **Step 1: Write the failing tests** (`FakeOpenRouter`, `makeService` with an injected catalog stub):
  - **`standard request bytes are unchanged`:** build a `/batch ask` job with and without the privacy code path at `standard`. The `submittedRequest` artefact and `contentSha256` equal a fixture captured before the change (snapshot the bytes in the test).
  - **`zdr pins every creation path`:** for `createJob`, `createWorkflowJob`, `createDatasetJob`, `createChatJob` and `retry`, the posted body's `provider` deep-equals `{ only: [...], allow_fallbacks: false }`, and `manifest.privacy.level === "zdr"`.
  - **`zdr refusal persists nothing`:** with no ZDR provider, `SubmissionBlockedError` is thrown, no job directory is created and no request is posted.
  - **`user provider pin outside ZDR is refused`** (Review Focus 1): `providerPin: "notzdr"` at `zdr` throws with the reason containing `"no ZDR provider"`.
  - **`no-training batch requires attestation`**.
  - **`a batch body never contains data_collection or zdr`:** assert on the posted text at every level.
- [ ] **Step 2: Run** `npx tsc -p tsconfig.test.json && node --test .test-build/test/privacy-enforcement.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** Make `persistJob` async, `await` it in every caller and apply the decision before the body is built. Keep the `buildSubmitBody` key order.
- [ ] **Step 4: Run** the focused test, then `npm test` and `npm run check`. Expected: PASS, with no regressions.
- [ ] **Step 5: Commit** `feat(privacy): enforce privacy level for every batch job at persistence`.

---

### Task 4: Delete finished batches at OpenRouter

**Files:**
- Modify: `src/openrouter/client.ts`, `src/service.ts`, `src/types.ts`, `src/poller.ts`
- Test: `test/privacy-deletion.test.ts`

**Interfaces:**
- Produces:
  - `client.deleteBatch(batchId): Promise<{ deleted: boolean; raw?: RawExchange; detail?: string }>`. It sends `DELETE /batches/{id}`. A 404 or 410 counts as already deleted (`deleted: true`). A 409 means not finished yet (`deleted: false`, retry later).
  - `JobManifest.remoteDeletion?: { state: "pending" | "done" | "failed"; attempts: number; lastError?: string; at?: string }`.
  - `BatchService.runRemoteDeletions(): Promise<void>`, called by the poller after each pass.
- Behaviour:
  - After `finishRetrieval` writes the raw final response, a job whose **own** `privacy.level` is `no-training`/`zdr` and whose config has `privacy.deleteRemoteBatches` is marked `remoteDeletion.state = "pending"`.
  - `runRemoteDeletions` processes pending jobs and gives up as `failed` after 10 attempts.
  - Deletion never changes `localStatus`, and never touches immediate-route jobs (they have no batch ID).
  - Every attempt is logged as an event.
- [ ] **Step 1: Write the failing tests:**
  - **`zdr job is deleted after retrieval`:** after settling, run `runRemoteDeletions()`. A DELETE is posted to `/batches/batch_123`, `state` is `"done"`, the raw response file still exists, and `localStatus` stays `"ready"`.
  - **`delete failure is retried and never changes status`:** a 500 then a 204 give `attempts` 2 and `state` `"done"`.
  - **`409 retries later`**.
  - **`standard job after the project level is raised is never deleted`** (Review Focus 5): create at `standard`, switch the config to `zdr`, settle, run deletions. No DELETE is posted and `remoteDeletion` is undefined.
  - **`deleteRemoteBatches false disables it`**.
- [ ] **Step 2: Run** `npx tsc -p tsconfig.test.json && node --test .test-build/test/privacy-deletion.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** Mark the job pending inside the same `registry.update` that settles it. The poller calls `runRemoteDeletions` after `runPass`, with errors caught.
- [ ] **Step 4: Run** the same command, then `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(privacy): delete finished batches at OpenRouter at strict levels`.

---

### Task 5: The immediate route

**Files:**
- Create: `src/openrouter/immediate.ts`, `test/immediate.test.ts`
- Modify: `src/openrouter/client.ts`, `src/service.ts`

**Interfaces:**
- Consumes: Task 1 `immediateProviderFields`, Task 3 `route`/`privacy` on drafts.
- Produces:
  ```ts
  // client.ts
  public async chatCompletion(bodyText: string): Promise<RawExchange>;   // POST /chat/completions; non-2xx throws OpenRouterError with rawBody
  // immediate.ts
  export type ImmediateOutcome =
    | { kind: "done"; finalResponseText: string }                 // batch-shaped; normaliseBatchResult must accept it
    | { kind: "retry"; notBefore: string; reason: string }        // per-minute 429
    | { kind: "failed"; code: "rate_limited_daily" | "provider_error"; message: string };
  export async function runImmediateJob(job: JobManifest, requests: BatchRequestItem[], client: OpenRouterBatchClient, level: PrivacyLevel, now?: () => Date): Promise<ImmediateOutcome>;
  export function classify429(raw: { status: number; bodyText: string; headers?: Record<string, string> }): { daily: boolean; retryAfterMs: number };
  ```
  - `createChatJob` input gains `route?: Route`. Immediate chat jobs record `route: "immediate"`.
- Behaviour:
  - **Body:** each item becomes `{ model, ...item.body, provider: immediateProviderFields(level) }`. When the fields object is empty, omit `provider`.
  - **Calls:** item 1 is called, then item 2. An item 2 failure makes that item failed only; the job settles `partial` (ChatService already judges a turn by item 1).
  - **The final response** is built in exactly the shape of `completed([successItem(...)])` from `test/fixtures/openrouter.ts`, with the real usage, and saved as the write-once final response. `finishRetrieval` then runs unchanged.
  - **429s:**
    - Per-minute: the job stays in flight with `nextPollAt = notBefore` (`Retry-After`, or 30 s × 2^attempt capped at 15 min), and no failure is recorded.
    - Daily (the body mentions a daily or free-models-per-day limit, or more than 8 consecutive 429s): fail with code `rate_limited_daily`, message `"Free-model daily limit reached; try later or switch model"`.
  - **Wiring:** `submit()` and `reconcile()` dispatch on `job.route === "immediate"` to `runImmediateJob` instead of the batch endpoints.
- [ ] **Step 1: Write the failing tests:**
  - **`immediate job settles ready through the normal path`:** `fake` answers `POST /chat/completions` with a completion JSON. `manifest.localStatus === "ready"`, and `itemText` returns the content.
  - **`immediate body carries the privacy fields`:** `no-training` gives `"data_collection":"deny"`, `zdr` gives `"zdr":true`, and `standard` gives no `provider` key.
  - **`per-minute 429 reschedules without failure`:** `Retry-After: 20` sets `nextPollAt` 20 s ahead, leaves the status in flight, and records no error. The next reconcile succeeds.
  - **`daily 429 fails with rate_limited_daily`**.
  - **`title item failure leaves the job partial with item 1 completed`**.
  - **`batch jobs never call chat completions`**.
- [ ] **Step 2: Run** `npx tsc -p tsconfig.test.json && node --test .test-build/test/immediate.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `immediate.ts`, `chatCompletion` and the route dispatch.
- [ ] **Step 4: Run** the same command, then `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(models): add immediate route for free models through the job lifecycle`.

---

### Task 6: Chat threads, levels and routes

**Files:**
- Modify: `src/chat/types.ts`, `src/chat/service.ts`, `src/chat/session.ts`, `src/chat/commands.ts`
- Test: `test/privacy-chat.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces:
  - `ThreadState.privacyLevel?: PrivacyLevel`, `ThreadState.route?: Route`.
  - `ChatService.effectiveLevel(threadId): PrivacyLevel`.
  - `ChatService.raisePrivacy(threadId, level): void`. It throws `"Privacy level: can't lower a thread below the project level"` when the level isn't stricter than both the thread and the project levels, and appends a `status` entry on success.
  - `ChatService.setModel(threadId, slug, opts?: { route?: Route }): Promise<void>`, now async. It checks the model against the effective level using the catalog (the batch route through `resolveBatchProvider`; at `zdr`, the immediate route requires a ZDR endpoint for the model) and throws the refusal reason. It stores `route`.
  - The `/batch chat privacy <level>` subcommand.
- Behaviour:
  - `submitTurn` and `startCompaction` pass `route: thread.route ?? routeForModel(thread.model)` and `privacyLevel: effectiveLevel` to `createChatJob`.
  - **Footer** (`session.ts`): `🔒 zdr` or `no-train` after the model, and `· free` for free models. Unchanged at `standard`.
  - **`/batch chat context`** adds the batch line: `"Batch jobs are held at OpenRouter until finished; deleted after retrieval"` when the effective level is ≥ no-training and deletion is on. Otherwise: `"…kept up to 30 days"`.
- [ ] **Step 1: Write the failing tests:**
  - **`thread level can be raised, not lowered below project`**.
  - **`project lowered keeps a higher thread level`** (Review Focus 3): the thread is at `zdr`, then the config is set to `standard`. `effectiveLevel` is still `"zdr"` and the next job's `privacy.level === "zdr"`.
  - **`setModel refuses a model the level blocks, and stores the route for :free`**.
  - **`a free-model turn goes immediate and settles`:** end to end through the fake.
  - **`footer shows the privacy badge and free`**, and **`context shows the batch retention line`**.
- [ ] **Step 2: Run** `npx tsc -p tsconfig.test.json && node --test .test-build/test/privacy-chat.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** The commands calling `setModel` now `await` it.
- [ ] **Step 4: Run** the same command, then `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(chat): privacy levels and free-model routes for threads`.

---

### Task 7: `/batch privacy`, the picker and runtime wiring

**Files:**
- Create: `src/privacy/commands.ts`, `test/privacy-commands.test.ts`
- Modify: `src/commands.ts` (dispatch, `SUBCOMMANDS`, `HELP`), `src/chat/commands.ts` (model picker), `src/runtime.ts`, `index.ts`

**Interfaces:**
- Consumes: Tasks 1–6.
- Produces:
  - `cmdPrivacy(rt, rest, ctx)` for `/batch [--global] privacy [level|attest|unattest|refresh]`. With no argument it shows the level, where it comes from, the attestation state, the catalog state (`fresh at <time>` / `from <time>, refresh failed` / `loading`) and the account-settings pointer. A level argument writes the setting through the existing config writer used by `/batch model`.
  - `BatchRuntime.catalog: ModelCatalog | null`. The catalog file is `<storage>/model-catalog.json`.
  - Pure helpers, so they can be tested: `pickerEntries(catalog: CatalogSnapshot | undefined, batchModels: string[], level: PrivacyLevel, accountNoTraining: boolean): Array<{ id: string; route: Route; labels: string[]; blocked?: string }>` and `formatPrivacyStatus(...)`.
- Behaviour:
  - `reloadConfig` builds the catalog. `session_start` calls `void catalog.load()` (non-blocking).
  - The first time the level is raised above `standard`, the account-settings notice is shown and `privacy.noticeShown` is set.
  - `/batch chat model` with no slug uses `pickerEntries`:
    - labels `[batch]`/`[free]`/`[ZDR]`;
    - blocked models hidden;
    - a "Refresh models" option;
    - "loading models…" or the stale-catalog text.
  - `--refresh` reloads before showing the picker.
  - `/batch show` prints `privacy.level`, the route, the enforcement and the `remoteDeletion` state.
- [ ] **Step 1: Write the failing tests:** `pickerEntries` filtering and labels at each level (including `blocked` reasons), `formatPrivacyStatus` for fresh, stale and loading, and the notice shown only once.
- [ ] **Step 2: Run** `npx tsc -p tsconfig.test.json && node --test .test-build/test/privacy-commands.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** the commands and wiring.
- [ ] **Step 4: Run** `npm test` and `npm run check`. Expected: PASS and clean.
- [ ] **Step 5: Commit** `feat(privacy): /batch privacy, labelled model picker and session catalog wiring`.

---

### Task 8: Web UI

**Files:**
- Modify: `src/web/server.ts`, `src/web/ui.ts`
- Test: `test/privacy-web.test.ts`

**Interfaces:**
- Consumes: Tasks 1–7 (`cmdPrivacy`'s setting writer, `pickerEntries`, `ChatService.raisePrivacy`/`setModel`, `ModelCatalog`).
- Produces these endpoints, all behind the existing auth, Host/Origin and CSRF checks:
  - `GET /api/privacy` → `{ level, source, accountNoTraining, deleteRemoteBatches, noticeShown, catalog: { state, loadedAt, error } }`
  - `POST /api/privacy` with `{ level }`
  - `POST /api/privacy/attest` with `{ attested: boolean }`
  - `POST /api/models/refresh`
  - `GET /api/models` → `pickerEntries` output for a `threadId` query parameter, or the project level
  - `POST /api/threads/:id/privacy` with `{ level }`. Lowering is refused with 400 and the reason.
  - The existing thread model-change and send endpoints call `ChatService.setModel` and the persistence checks, so a blocked model posted by the page gets 400 with the refusal reason.
- **UI:**
  - A workspace settings level selector, plus the attestation checkbox-and-confirm.
  - The one-time notice with a link to `https://openrouter.ai/settings/privacy`.
  - A chat-header badge and a raise-level control (lowering is disabled, with a tooltip).
  - A picker grouped "Batch (cheaper, slower)" / "Immediate (free)", with labels, a "Show blocked" toggle, catalog state text and a "Refresh models" button.
  - Inline refusal messages.
  - The jobs view shows the privacy level, route, enforcement and remote-deletion state.
  - Follow the PR #1 pattern: `data-action` attributes and delegated listeners, with no inline handlers.
- The standalone server and workspace switch call `catalog.load()`.
- [ ] **Step 1: Write the failing tests** (pattern: the existing web tests in `test/web-and-attachments.test.ts`):
  - Each new endpoint returns 401 without a session, and 403 with a foreign Origin.
  - `POST /api/threads/:id/privacy` refuses lowering.
  - Posting a blocked model gives 400, and no job is created.
  - `GET /api/models` labels and filtering match `pickerEntries`.
  - The page HTML contains no `onclick=`.
- [ ] **Step 2: Run** `npx tsc -p tsconfig.test.json && node --test .test-build/test/privacy-web.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** the endpoints and UI.
- [ ] **Step 4: Run** `npm test` and `npm run check`. Expected: PASS and clean.
- [ ] **Step 5: Commit** `feat(web): privacy levels, labelled model picker and job privacy status`.

---

### Task 9: Notebook cleaning before packaging

**Files:**
- Create: `src/context/notebook.ts`
- Modify: `src/context/package.ts` (the read/size/binary section, `SelectedFile`, `PackageProblem`, `ExclusionLayer`), `src/attachments.ts` (the text-upload branch of `prepareAttachments`)
- Test: `test/notebook.test.ts`

**Interfaces:**
- Produces:
  - `cleanNotebook(text: string): { ok: true; text: string; cells: number; droppedOutputs: number } | { ok: false; reason: string }`, in the Notebook text format from the Global Constraints. `source` can be a string or a string array.
  - `MAX_NOTEBOOK_RAW_BYTES = 32 * 1024 * 1024`.
  - `SelectedFile.transform?: "ipynb-cleaned"`. On a cleaned file, `bytes` and `sha256` describe the file on disk, while `characters` and `content` describe the cleaned text that is sent.
  - New `PackageProblem` kind `"invalid_notebook"`, and new `ExclusionLayer` `"invalid-notebook"`.
- **Rules:**
  - A `.ipynb` file (extension matched case-insensitively) is checked against `MAX_NOTEBOOK_RAW_BYTES` on disk. `context.maxFileBytes` is then applied to the UTF-8 byte length of the cleaned text.
  - A notebook that can't be parsed is never sent raw:
    - an explicit file gives an `invalid_notebook` problem, which blocks;
    - a context-expanded file is excluded with the `invalid-notebook` layer.
  - The secret scan runs on the cleaned text.
  - Uploads named `*.ipynb` are cleaned the same way in `prepareAttachments`, before the secret scan.
  - The preview line for a cleaned file says `notebook outputs stripped`.

- [ ] **Step 1: Write the failing tests:**
  - `cleanNotebook` on a fixture with a markdown cell `["# Title\n", "\n", "text"]`, a code cell `"x = 1"` with an `image/png` base64 output and a stream output containing `AKIAABCDEFGHIJKLMNOP`, and a raw cell. Expect exactly `"# Databricks notebook source\n# MAGIC %md\n# MAGIC # Title\n# MAGIC\n# MAGIC text\n\n# COMMAND ----------\n\nx = 1"`, with `cells: 2` and `droppedOutputs: 2`.
  - `cleanNotebook("{not json")` and `cleanNotebook('{"cells": 5}')` both give `ok: false`.
  - `buildContextPackage` with an explicit 2 MB notebook whose cleaned text is under 1 KB, and `maxFileBytes: 1_000_000`: the file is accepted with `transform: "ipynb-cleaned"`, its `content` contains no `AKIA` and no `base64`, and `secretFindings` is empty.
  - An explicit invalid notebook gives an `invalid_notebook` problem, and its raw text appears in no package content.
  - A context-expanded invalid notebook is excluded with the `invalid-notebook` layer.
  - `prepareAttachments` with an upload named `N.IPYNB` sends the cleaned text.
- [ ] **Step 2: Run** `npx tsc -p tsconfig.test.json && node --test .test-build/test/notebook.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `src/context/notebook.ts` and wire it into both call sites.
- [ ] **Step 4: Run** `npm test` and `npm run check`. Expected: PASS and clean.
- [ ] **Step 5: Commit** `feat(context): strip .ipynb outputs and metadata before packaging`.

---

### Task 10: Metadata standards mode: contract, prompt and proposal checks

**Files:**
- Create: `src/metadata/standards.ts`
- Modify: `src/metadata/contract.ts`, `src/metadata/plan.ts`, `src/types.ts` (`MetadataWorkflowInfo`), `src/service.ts` (`MetadataRunOptions`, `StoredMetadataPlan`, `planMetadata`, `createMetadataJob`, `outputValidator`), `src/metadata-commands.ts` (`plan` flags, preview, help)
- Test: `test/metadata-standards.test.ts`

**Interfaces:**
- Consumes: Task 1's `effectiveLevel`/config `privacy.level` (for R7), and Task 3's async `persistJob` (metadata jobs already go through it).
- **Produces in `standards.ts`:**
  - `MetadataStandards = { domain: string; ucPrefix: string }`.
  - The constants `TABLE_HEADERS`, `COLUMN_REQUIRED_HEADERS`, `COLUMN_TYPES`, `CLASSIFICATIONS`, `PII_TYPES`, `SENSITIVITIES`, `MEDALLION_LAYERS` and `FRAMEWORK_AUDIT_COLUMNS`, with values from the Global Constraints.
  - Check functions:
    - `isAuditColumn(name): boolean`;
    - `medallionLayer(table: string): "bronze"|"silver"|"gold"|null`;
    - `descriptionProblems(text: string, classification?: string): string[]`, which checks the headers appear in order, the length is at least 30, and the `CLASSIFICATION:` value matches the tag (lower-cased, spaces to `_`, trailing `.` stripped);
    - `columnCommentProblems(text: string): string[]`;
    - `piiTextProblems(text: string): string[]`, for an email, an SSN `\b\d{3}-\d{2}-\d{4}\b` or a phone number written with separators `\b(?:\+?\d{1,3}[ .-])?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b`;
    - `tableTagProblems(tags, expected: { domain, ucPrefix, layer }, anyColumnPii: boolean): string[]` and `columnTagProblems(tags): string[]`.
  - Builders:
    - `deriveTableTags(classification, standards, layer, anyColumnPii): TagMap`, with the key order `classification, data_domain, uc_prefix, medallion_layer, pii`;
    - `columnTagsFromProposal(piiTags | null): TagMap`, with the key order `pii, pii_type, sensitivity, requires_masking`.
  - Problem strings never include values from the evidence, matching the existing style.
- **Produces in `contract.ts`:**
  - `TagMap = Record<string, string>`.
  - Optional `existing_tags?: TagMap` on `TableEvidence` and `ColumnEvidence`. Evidence schema: an object of strings, with at most 50 keys.
  - `PROPOSAL_SCHEMA_V2`: like the v1 schema, plus a top-level `classification` (enum `CLASSIFICATIONS`), and on each column `pii_tags: null | { pii_type, sensitivity, requires_masking }` (enums, `additionalProperties: false`).
  - `proposalProblems(value, expected, standards?: MetadataStandards)`. With `standards`, it validates against v2, applies `descriptionProblems`, `columnCommentProblems` and `piiTextProblems` to every non-null comment, and rejects a `public` classification when any column has `pii_tags`.
  - `promptEvidence(ev: TableEvidence, standards?): TableEvidence`, which drops audit columns in standards mode. `expected` in `proposalProblems` is this reduced evidence.
- **Produces in `plan.ts`:**
  - `MetadataPlanInput.standards?: MetadataStandards`.
  - `METADATA_STANDARDS_INSTRUCTIONS`, appended to the instruction list only in standards mode. It covers:
    - the six-line table template;
    - the column template with optional `UNIT:`/`FORMULA:`/`JOIN:`;
    - the classification values, with `pii_scan_required` when evidence is unclear;
    - "set `pii_tags` only for a column that holds personal data; otherwise null";
    - never copying sample values that look personal.
  - `renderMetadataPrompt(context, evidence, standards?)` uses `promptEvidence` and `PROPOSAL_SCHEMA_V2` in standards mode.
  - `planMetadataRun` blocks, listing the table names:
    - tables whose last name part does not start with `ucPrefix` (case-insensitive);
    - tables where `medallionLayer` is null.
  - `planSha256` includes `standards` only when it is set, so v1 hashes don't change.
- `MetadataWorkflowInfo.version: 1 | 2`, plus optional `standards`. `StoredMetadataPlan` records `standards`. `outputValidator` passes the job's stored `standards` to `proposalProblems`.
- **Commands:**
  - `/batch metadata plan` gains `--domain <slug> --uc-prefix <PREFIX>`.
  - The preview adds the lines `Standards:` (`off`, or `<domain> / <PREFIX>`) and `Audit columns: N not sent`.
  - The preview adds the R7 warning: `sample values will be sent at privacy level standard; consider /batch privacy zdr`.

- [ ] **Step 1: Write the failing tests:**
  - **v1 unchanged:** for the existing metadata fixtures without standards, the request bodies and `planSha256` are byte-identical before and after. Compare against a hash captured from `HEAD` in this test file before implementing.
  - **Bad options:** `domain` given without `ucPrefix` gives an error mentioning both.
  - **Prefix and layer blocking:** with `{domain:"pinpoint", ucPrefix:"PNPT_"}`, `uc_dev.lighthouse_gold.PNPT_location_data` plans fine. `uc_dev.lighthouse_gold.STRL_x` and `uc_dev.misc.PNPT_y` block, and both names are listed.
  - **Audit columns:** `fw_ingestdate` and `FW_PIPELINEROWCHECKSUM` don't appear in the prompt. A proposal that omits them is valid, and one that includes them is "invented".
  - **Corrupt proposals:** each of these is a problem:
    - a column with `pii_tags` while `classification` is `public`;
    - a column `pii_tags` with `pii_type: "postcode"`;
    - a description missing `OWNER:`, or a description whose `CLASSIFICATION: Restricted.` disagrees with `classification: "internal"`;
    - a comment missing `NULL MEANS:`;
    - a comment containing `jane@example.com`.
  - **Valid proposal:** the TDD §3.3 `pk_loc_id` comment and the §3.3 description, with `classification: "internal"` and `pii_tags: null`, give no problems.
  - **`deriveTableTags`:** `deriveTableTags("internal", {domain:"pinpoint", ucPrefix:"PNPT_"}, "gold", false)` deep-equals the §3.3 table `approved_tags`, including key order.
  - **R7 warning:** the preview warns at `standard` with samples, and doesn't warn at `zdr`.
- [ ] **Step 2: Run** `npx tsc -p tsconfig.test.json && node --test .test-build/test/metadata-standards.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `standards.ts`, then the contract, plan, types and service changes, then the flags.
- [ ] **Step 4: Run** `npm test` and `npm run check`. Expected: PASS and clean, with the existing metadata tests unchanged.
- [ ] **Step 5: Commit** `feat(metadata): opt-in UC standards mode with tag taxonomy and format checks`.

---

### Task 11: Tags in the review, the approved draft and validate-approved

**Files:**
- Modify: `src/metadata/contract.ts` (`ApprovedRow`, `APPROVED_SCHEMA`), `src/metadata/report.ts`, `src/metadata/outputs.ts`, `src/metadata-commands.ts`
- Test: `test/metadata-approved-tags.test.ts`

**Interfaces:**
- Consumes: Task 10 (`standards.ts`, `promptEvidence`, the stored `standards` on the job and its `StoredMetadataPlan`).
- **Approved rows:**
  - `ApprovedRow` gains optional `existing_tags`/`approved_tags` at table and column level.
  - Key order in standards mode: `table, existing_description, approved_description, existing_tags, approved_tags, columns[name, existing_comment, approved_comment, existing_tags, approved_tags], provenance`, as in TDD §3.3.
  - v1 rows have no tag keys.
  - `APPROVED_SCHEMA` allows the tag keys, but `validateApprovedText` requires them exactly when the job is in standards mode, and rejects them on a v1 job.
- **Draft in standards mode** (`approvedDraftRows`):
  - **Description:**
    - existing passes `descriptionProblems` → keep existing;
    - otherwise → proposal;
    - no proposal → existing.
  - **Column comments:** the same rule, using `columnCommentProblems`. Audit columns always keep their existing comment and existing tags.
  - **Table tags:** `deriveTableTags(proposal.classification, …, anyColumnPii)`. With no proposal, use the existing tags (or `{}`).
  - **Column tags:** `columnTagsFromProposal(pii_tags)`. With no proposal, use the existing tags (or `{}`).
  - `existing_tags` is copied from the evidence, or `{}` when absent.
- **`validateApprovedText` in standards mode** adds:
  - `tableTagProblems`/`columnTagProblems`;
  - the standards checks on every non-null approved value of a non-audit column, and on the description;
  - `piiTextProblems`.
  - It also checks that `existing_tags` reproduces the evidence exactly.
  - Its counts gain `replacedNonStandard`.
- **Review Markdown in standards mode:**
  - each table gets a `**Tags:**` line, existing → approved;
  - columns get a `PII` column in the table;
  - a value that replaces a non-standard existing value is marked `_replaces a non-standard existing value_`.
- The `approved` command's notification adds `N non-standard existing value(s) replaced by proposals`.

- [ ] **Step 1: Write the failing tests:**
  - **v1 job:** summary, review Markdown, approved draft and validate-approved outputs are byte-identical to the current output, compared against fixtures generated from `HEAD`.
  - **Standards job, legacy comment:** a column with the existing comment `"Location id"` takes the proposal. `validate-approved` on that draft gives no problems, and `replacedNonStandard: 1`.
  - **Reviewer reverts it:** after a reviewer edits that value back to `"Location id"`, `validate-approved` reports a `TYPE:` problem for that column.
  - **Draft tags:** an all-non-PII table has every column `approved_tags` as `{}` and table `pii` as `"false"`. One `pii_tags` column gives `{pii:"true",…}` and table `pii` as `"true"`.
  - **Hand-edited tags rejected:** a row with a column `approved_tags: {pii:"false"}` is a problem, and so is a table missing `uc_prefix`.
  - **Audit columns:** an audit column keeps its existing comment and isn't checked against the standards.
  - **Partial run:** `--allow-partial` with a table that has no proposal keeps its existing values and tags.
- [ ] **Step 2: Run** `npx tsc -p tsconfig.test.json && node --test .test-build/test/metadata-approved-tags.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` and `npm run check`. Expected: PASS and clean.
- [ ] **Step 5: Commit** `feat(metadata): UC tags and standards checks in review and approved handoff`.

---

### Task 12: Web studio "UC Metadata" tab

**Files:**
- Modify: `src/web/server.ts`, `src/web/ui.ts`
- Test: `test/metadata-web.test.ts`

**Interfaces:**
- Consumes: Task 8's UI patterns and privacy display; Task 10's `planMetadata` options, `formatMetadataPreview` and `createMetadataJob`; Task 11's `writeMetadataReview`, `writeApprovedDraft` and `validateApprovedText`.
- **Endpoints**, all behind the existing session cookie, Host/Origin and CSRF checks, with every path resolved through `resolveWorkspaceInput` or the artifact system (workspace containment):
  - `POST /api/jobs/metadata` with `{ context, input, domain?, ucPrefix?, model?, account?, providerPin?, mode: "dryrun"|"preview"|"submit" }`.
    - `dryrun` → `{ blockers, warnings, preview }`, where `preview` is the `formatMetadataPreview` text.
    - Otherwise → 201 `{ job }`, with a 400 and the blocker text when blocked.
  - `POST /api/jobs/:id/metadata/review` with `{ out?, overwrite? }` → `{ path, artifactId, gaps }`.
  - `POST /api/jobs/:id/metadata/approved` with `{ out, overwrite?, allowPartial? }` → `{ path, artifactId, sha256, counts, problems }`.
  - `POST /api/metadata/validate-approved` with `{ file, job? }` → `{ rows, jobId, counts, problems }`.
- **UI:**
  - A fourth studio kind button, `UC Metadata`, with fields for the context file, the tables file, domain, UC prefix and model, plus the existing Dry run / Save preview / Submit buttons.
  - The dry run shows the preview text verbatim in a `<pre>`.
  - For a finished `databricks-metadata` job, the jobs view shows "Write review.md", "Write approved.jsonl" (with an allow-partial checkbox) and "Validate approved file".
  - Use `data-action` attributes and delegated listeners only.
- [ ] **Step 1: Write the failing tests:**
  - Each new endpoint gives 401 without a session, and 403 with a foreign Origin.
  - A `context` of `../outside.md` gives 400, and no job is created.
  - A dry run with `domain` but no `ucPrefix` gives 400 naming both.
  - A dry run on the Task 10 fixtures returns the same preview text as `formatMetadataPreview`.
  - `approved` on an unfinished job gives 400 "wait until it has finished".
  - The page HTML contains no `onclick=`.
- [ ] **Step 2: Run** `npx tsc -p tsconfig.test.json && node --test .test-build/test/metadata-web.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** the endpoints and UI.
- [ ] **Step 4: Run** `npm test` and `npm run check`. Expected: PASS and clean.
- [ ] **Step 5: Commit** `feat(web): UC metadata studio tab and review/handoff actions`.

---

### Task 13: Probe script and documentation

**Files:**
- Create: `scripts/privacy-probe.mjs`
- Modify: `README.md`

- [ ] **Step 1: Write `scripts/privacy-probe.mjs`.**
  - **Usage:** `node scripts/privacy-probe.mjs <model> [--account <alias>]`.
  - **Key:** read the same way the standalone server does (`OPENROUTER_API_KEY` or `auth.json` for the account).
  - **Guard:** print a cost note and require typing `yes`.
  - **Submission:** submit one batch with a single request (`max_tokens: 1`, content `"ping"`) and `provider: { data_collection: "deny" }`. Report `ACCEPTED` or `REJECTED (<status>: <detail>)`.
  - **Repeat with `provider: { zdr: true }`.**
  - **Clean-up:** if a probe batch was accepted, it can't be cancelled (no cancel endpoint), so print its ID. Its results are deleted once it finishes, via `DELETE /batches/{id}`, which the script polls for up to 10 minutes.
  - **Exit codes:** 0 when done, 1 on usage errors, 2 when not confirmed.
- [ ] **Step 2: Update the README.**
  - Add a "Privacy levels and free models" section covering:
    - the three-level table;
    - what is enforced per route;
    - attestation;
    - remote deletion and the 30-day retention fact;
    - the account settings the extension can't see (with links);
    - the session catalog and refresh;
    - free-model rate limits;
    - the probe script.
  - Add command-table rows for `/batch privacy`, `/batch chat privacy` and `/batch chat model --refresh`, and the `privacy.*` config defaults.
  - Add a "UC metadata standards mode" subsection to the metadata docs covering:
    - `--domain`/`--uc-prefix`;
    - the description, comment and tag rules;
    - the sparse PII column rule;
    - audit columns;
    - the draft rule for non-standard existing values;
    - notebook cleaning;
    - the studio tab;
    - a pointer to the TDD's two-pass flow (Pass 1 is `/batch ask` with the scoped files);
    - a recommendation to use `zdr` when tables carry sample values.
- [ ] **Step 3: Run** `npm test` and `npm run check`. Expected: PASS and clean.
- [ ] **Step 4: Commit** `docs: privacy levels, free models and probe script`.
