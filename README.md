# pi-batch-openrouter

Dependable deferred goals for the Pi coding agent, using the OpenRouter Batch API.

Submit a substantial reasoning task, keep working, close Pi if you like, and later
bring the result back into your active conversation:

```
/batch ask --file docs/architecture.md "Identify material assumptions and unresolved risks"
   → package context → exclusions + secret scan → preview → persist → submit → return immediately
   … background polling (survives restarts) → retrieve → preserve raw + normalised result
/batch read B-20261016-A7C2
/batch inject B-20261016-A7C2
```

Or fan one objective out over many files — one OpenRouter batch, one independently traceable request per file —
then inspect, retry and synthesize the results:

```
/batch run map-files --file src/service.ts --file src/registry.ts --file src/openrouter/client.ts --prompt "Review this component for reliability defects and cite the relevant code."
/batch items B-20261017-K3M9
/batch retry-items B-20261017-K3M9 --failed
/batch synthesize B-20261017-K3M9
/batch inject B-20261017-K3M9 --synthesis
```

OpenRouter batches are typically billed at about 50% of standard per-token pricing and complete within 24 hours
(see the [Batch API quickstart](https://openrouter.ai/docs/batch-quickstart)). This extension does not guarantee either.

## Installation

Add to `~/.pi/agent/settings.json` or `.pi/settings.json`:

```json
{ "packages": ["git:github.com/mastnacek/pi-batch-openrouter"] }
```

The API key comes from Pi's model registry/`auth.json` for the selected account (`/batch provider`), falling back to `OPENROUTER_API_KEY`.

## Commands

| Command | Purpose |
|---|---|
| `/batch ask [options] "<objective>"` | Build, check and submit a deferred goal. `/batch goal` is an alias. |
| `/batch run map-files [options] --prompt "<objective>"` | One batch, one request per selected file (see [Multi-request workflows](#multi-request-workflows)). `/batch plan …` is `run … --preview`. |
| `/batch submit <id>` | Submit a job created with `--preview` (goal, workflow, retry or synthesis). |
| `/batch list [--status active\|done\|ready\|failed\|…\|all] [--limit n]` | List jobs from **local** state (no network). `ITEMS` shows usable/total for multi-request jobs. |
| `/batch show <id>` | Local status vs provider status, timings, usage/cost (only if reported), item counts, linked retries/syntheses, errors, artefact path, recent events. |
| `/batch items <id>` | Item inventory: status, source, output availability, plus combined coverage with linked retry jobs. |
| `/batch item <id> <n\|custom_id\|path> [--text] [--raw]` | One item: custom ID, source, item status, validation, provider error, item usage (only if returned), artefact paths; `--text` adds the result, `--raw` the provider's raw item entry. |
| `/batch read <id> [--full\|--raw\|--items\|--item <sel>\|--synthesis]` | Read locally retrieved results. For multi-request jobs the default is a **bounded overview** (counts, sources, short excerpts, paths); `--items` shows every item, `--item` one item, `--synthesis` the newest synthesis with its coverage. |
| `/batch inject <id> [--item <sel>\|--synthesis] [--summary\|--full]` | Add a result, one item, or a synthesis to **this conversation's** model context. |
| `/batch check [id]` | Reconcile with OpenRouter now. With an id, waits up to 10 s for an in-flight background check of that job to finish, then reports fresh state. |
| `/batch cancel <id>` | Request cancellation; history is kept (see limitations). |
| `/batch retry <id> [--model <slug>]` | New job, linked via `parentJobId`, re-running every request from the exact original request bodies. |
| `/batch retry-items <id> --failed \| --item <sel> … [--model <slug>] [--preview]` | New linked job re-running only the selected items (see [Retry and coverage](#retry-and-coverage)). |
| `/batch synthesize <id> [--allow-partial] [--model] [--account] [--provider] [--preview]` | New linked one-request job that consolidates the item results (see [Synthesis](#synthesis)). |
| `/batch view` | TUI dashboard: `↑/↓` move, `Enter` details, `o` read, `i` inject, `c` cancel, `r` refresh. |
| `/batch [--global] model [slug]` | Default batch model. Saved per project unless `--global` is given. |
| `/batch [--global] provider [alias]` | Default Pi account (provider alias) for the API key. |

IDs accept a unique suffix (`A7C2`) or the provider batch ID.

### `ask` options

| Option | Meaning |
|---|---|
| `--file <path>` | Include a text file. Repeatable. If the file is excluded, binary, too large, outside the workspace or unreadable, the **whole submission is blocked**; requested files are never silently skipped. |
| `--context <path>` | Include a file or directory. Repeatable. Files inside a directory that are excluded, binary or too large are skipped, and every skip is listed in the preview. |
| `--model <slug>` | Override the model. A `:batch` suffix is stripped. |
| `--account <alias>` | Override the Pi account used for the API key. |
| `--provider <slug>` | Pin the upstream provider (`provider.only`, with `allow_fallbacks: false`). |
| `--format markdown\|json` | `json` asks the model for a single JSON object. |
| `--preview` | Build, validate and persist the exact request without sending it. Use `/batch submit` to send it later. |
| `--no-instructions` | Omit the system prompt and the RESPONSE REQUIREMENTS section. |

Quote objectives that contain spaces. Backslash paths (`src\auth.ts`) work as typed. Text after `--` is never parsed as an option.

### Injection

`/batch inject` uses Pi's `pi.sendMessage()` custom-message mechanism. The result is stored in the session and included in the model's context. It does **not** start a model turn on its own: the model sees it with your next message. Only `ready` results can be injected, plus `partial` ones, which are clearly labelled as partial.

If the injected text would exceed `injection.maxCharacters` (default 30,000), nothing is injected until you choose:

- `--summary` injects a bounded, explicitly marked **excerpt**. This is the start of the result, not a model-generated summary.
- `--full` injects everything.

## Multi-request workflows

Pi slash commands are typed **inside Pi**. When scripting Pi from a Windows shell, use PowerShell
(`pi -p "/batch run map-files …"`). Do not script `/batch …` from Git Bash: MSYS path conversion rewrites a
leading `/batch` into a file path such as `C:/Program Files/Git/batch`, which Pi then sends to the model as a prompt.

### `map-files`

```
/batch run map-files --file src/service.ts --file src/registry.ts --prompt "Review this component for reliability defects."
```

| Option | Meaning |
|---|---|
| `--file <path>` | Include a file (repeatable). Same rules as `ask`: an excluded, binary, too-large, outside-workspace or secret-bearing file **blocks the whole plan**. |
| `--context <dir>` | Expand a directory; excluded files are skipped and listed. |
| `--prompt "<objective>"` | Shared objective for every request (or give it as trailing text). |
| `--group-size <n>` | Put `n` consecutive files (in selection order) in each request. Default 1. No file is omitted or repeated; group membership is persisted. |
| `--model`, `--account`, `--provider`, `--format`, `--no-instructions` | As for `ask`. One batch uses one model. |
| `--preview` | Build, check and persist the exact plan and payload without sending; submit later with `/batch submit <id>`. |

Each request contains only the shared objective, its own file path(s) and content, and the response
requirements. Files are never concatenated into every request. The preview reports exact numbers:
requests, selected files, total prompt characters (not tokens), the largest item, and excluded and blocked files.

Before anything is persisted, planning runs all of these checks:
- path containment
- hard-deny rules
- ignore rules
- the secret scan
- the text/binary check
- per-file, per-item and total size limits
- `custom_id` format and uniqueness

If any check fails, nothing is saved or sent.

**Request IDs.** `custom_id` is `<local ID>_request-NNN`. It matches `^[A-Za-z0-9_-]{1,64}$`, which is what a
real Anthropic batch endpoint enforced (HTTP 422 on `:`). It never contains file paths or user text; those
live in local item metadata. Results are matched by `custom_id` only, never by result order.

### Multi-request outcome rules

Item states are recorded separately from the local batch status and the provider's batch status:

| Item state | Meaning |
|---|---|
| `completed` | Usable, validated text. |
| `failed` | The provider or model reported an error, returned a non-2xx status, or produced no text. |
| `corrupt` | A result came back but could not be interpreted, or failed validation (e.g. not JSON with `--format json`). |
| `missing` | The completed batch did not return this `custom_id`. |

Batch outcome:

| Outcome | Rule |
|---|---|
| `ready` | Correlation is sound **and every expected item is `completed`**. Provider "completed" alone is never enough. |
| `partial` | Correlation is sound, at least one item is usable, and at least one is failed, corrupt or missing. Usable items stay readable. |
| `failed` | The provider failed the batch, or correlation is sound but no item is usable. |
| `corrupt` | The response cannot be correlated safely: not JSON, wrong batch ID, `results` not an array, an entry without `custom_id`, a **duplicate** or **unknown** returned `custom_id`, or an empty `results` array for a non-empty batch. Also used when every item is individually corrupt. No text from a corrupt batch is presented or injectable. |

Unknown and duplicate entries are preserved as evidence (`result/unexpected.json`). `finish_reason: length` and code-fenced JSON are recorded as item validation warnings.

### Retry and coverage

`/batch retry-items <id> --failed` selects every item without a trusted usable result. `--item <n|custom_id|path>`
(repeatable) selects explicitly. The new job:
- copies the exact original request bodies of the selected items, re-scanned for secrets;
- gets new local and `custom_id` identifiers, and links each item to the parent item it replaces;
- bypasses duplicate protection only because it is an explicit retry;
- supports `--preview`.

The parent job is **never modified**; only an event is appended to its history. `/batch items <parent>` then shows:

```
Original job: partial
Retry job B-20261017-Q8RT: ready (1 item(s))
Combined coverage: complete (3/3 usable)
  item 002: usable via B-20261017-Q8RT item 1
```

### Synthesis

`/batch synthesize <id>` creates a **separate, linked, deferred one-request job**. It is never run as part of
retrieving the source job. Its input is built deterministically from locally validated item results, using
combined coverage, so a successful retry fills a gap. The new job records:
- the source job
- each included item's `custom_id` and the job that supplied it
- each excluded item with its reason
- whether partial synthesis was allowed
- the exact prompt and request hash

- **Default:** blocked unless every expected item is usable.
- **`--allow-partial`:** proceeds, but the prompt states the expected, included, failed, corrupt and missing counts and the affected sources, and says conclusions may be incomplete.
- `/batch read <id> --synthesis` and `/batch inject <id> --synthesis` render that **coverage block from local state, separately from the model's prose**. They never rely on the model to mention missing inputs.
- A package larger than `workflows.maxSynthesisCharacters` is rejected with a diagnostic; results are never silently dropped.

### Usage and cost (multi-request)

- **Batch level:** the batch's usage is shown exactly as returned: tokens, charged cost, BYOK flag, upstream inference cost.
- **Item level:** usage is recorded only when the provider includes it in that item's response body.
- **No allocation:** batch cost is never divided across items. `/batch item` says "not reported per item" when that is the case.

## What happens to your data

- **Exclusions are applied before the request is built.** Evaluation order (the first match decides):
  1. **Hard-deny.** Cannot be configured or overridden. Covers `.env`, `.env.*`, `*.pem`, `*.key`, `*.pfx`, `*.p12`, `*.jks`, `id_rsa`/`id_ed25519`/…, `credentials.json`, `.npmrc`, `.netrc`, `secrets/`, `.ssh/`, `.aws/`, `.git/`, and similar.
  2. `.pi/batchignore` (gitignore syntax).
  3. `.gitignore`, via `git check-ignore`, which honours nested `.gitignore` files. If `git` is unavailable, only the root `.gitignore` is used, with a warning.
  4. `context.excludePatterns` in config. By default this covers `node_modules/`, `.venv/`, `dist/`, `build/`, … and `.pi/batches/`.
  5. Your explicit selection.
- **Paths:** paths are resolved against the workspace and canonicalised (symlinks resolved). Both the lexical and the real path must stay inside the workspace. Outside-workspace files are disabled by default.
- **Secret scanning (high-confidence patterns):** private-key blocks; AWS, GitHub, OpenRouter/OpenAI/Anthropic/Slack/Google keys; bearer tokens; `client_secret`/`api_key`/`password` assignments; credential-bearing connection strings; and the exact value of your current API key. The objective is scanned too. A finding blocks submission and reports file, line, type and a short one-way fingerprint, **never the value**.
- **Previews count characters, not tokens.**
- **The extension never applies results to your files.** Batch output is an advisory artefact. Acting on it is a separate, interactive request to Pi.

### Security boundary: please read

- **Technical capability is not organisational approval.** OpenRouter can technically process whatever you send, and this extension can send it. That says nothing about whether your organisation permits sending a given repository, source code or data to OpenRouter or to the upstream model provider. Check your organisation's policy. This extension does not grant, imply or check that approval.
- The secret scanning is **basic protection against accidental leakage**. It is not a DLP or compliance control. It cannot recognise confidential business content, personal data, or secrets in formats it doesn't know.
- Local configuration (exclusions, `blockOnSecret`, `allowOutsideWorkspace`) controls what this tool will send. It is not a policy decision on your organisation's behalf.

## Storage

Everything is project-local in `.pi/batches/`. A `.gitignore` containing `*` is created there so job state isn't committed by accident.

```
.pi/batches/
  extension.log                      structured diagnostics (no keys, headers or payloads)
  B-20261016-A7C2/
    manifest.json                    current state (atomic snapshot)
    events.jsonl                     append-only lifecycle history
    request/  objective.md  context.md  context-manifest.json  submitted-request.json  request.sha256
              plan.json (workflows, item retries)   synthesis-linkage.json (synthesis jobs)
    request/items/001/  metadata.json  request.json  request.sha256  prompt.md       (one folder per item)
    provider/ submission-response.json  latest-status.json  final-response.json   (raw provider bytes)
    result/   result.md  result.json  metadata.json  summary.json  unexpected.json  (normalised)
    result/items/001/   raw.json  result.json  result.md                          (per item)
```

- `submitted-request.json` contains the **exact bytes** POSTed to OpenRouter. `request.sha256` is the hash of those bytes.
- Each item's `request.sha256` hashes its canonical request body (`custom_id` excluded), so a retried item can be shown to carry the identical request.
- Item folders are named by **submission ordinal**, not `custom_id`: Release 1 IDs could contain `:`, which is not a valid Windows file name character. `raw.json` is the provider's entry for that item, extracted from `final-response.json`.
- **Manifest schema.** New jobs are `schemaVersion: 2`. They add `kind` (`goal`/`workflow`/`synthesis`), `items[]` (source, status, validation, error, usage, `replaces`), `workflow` and `synthesis`. Release 1 manifests (`schemaVersion: 1`) are read as-is and shown as one-item jobs; they are never upgraded in place. Their stored `custom_id`s are always matched verbatim, never regenerated.
- Raw provider responses are preserved first and never overwritten. A second retrieval writes `final-response.2.json`.
- All writes go through a temporary file, `fsync`, then rename, so a crash cannot leave a valid-looking partial file.
- There are three distinct identifiers:
  - local ID: `B-YYYYMMDD-XXXX`, allocated by exclusive `mkdir`
  - OpenRouter batch ID: `batch_…`
  - request `custom_id`: `<local ID>_request-001` (only `[A-Za-z0-9_-]`, which some upstream batch backends require)
- **Duplicate protection:** submitting a request identical to an *active* job (compared by canonical request hash with `custom_id` masked) is refused. `/batch retry` deliberately bypasses this. This is local protection only; OpenRouter documents no server-side idempotency.

**Why files rather than SQLite:** `better-sqlite3` is a native addon that must match Pi's Node ABI, and it needs prebuilt-binary downloads that corporate Windows networks often block. `node:sqlite` prints an `ExperimentalWarning` to stderr on the Node versions Pi supports, which would corrupt the TUI. The registry interface (`src/registry.ts`) is narrow enough to swap later.

## Lifecycle

```
draft → previewed → submitting → submitted → polling ⟲ → provider_completed → retrieving → ready
                                    │            │                               ├→ partial  (some requests failed)
                                    │            ├→ failed / expired / cancelled  ├→ failed   (all requests failed)
                                    └→ cancel_requested → cancelled | provider_completed | failed | expired
                                                                                  └→ corrupt  (response could not be trusted)
```

- **Local status and provider status are stored separately.** An illegal transition throws instead of corrupting state.
- **Polling failures** (network, timeout, 5xx, 429, auth, 404) never fail a job. They are recorded as `lastPollError` and retried with exponential backoff (`intervalSeconds × 2ⁿ`, capped at `maxBackoffSeconds`). Only provider evidence marks a job failed: batch status `failed`, or HTTP 410 for purged results.
- **Startup recovery:** on every session start, the extension rediscovers non-terminal jobs and reconciles them.
  - A job left in `submitting` by a crash becomes `failed` with `submission_unknown`. It is *not* resubmitted. Check OpenRouter first.
  - A job left in `retrieving` after its raw response was saved finishes from that local `final-response.json`, with no network call. Item artefacts are rewritten idempotently.
  - A job left in `retrieving` before the raw response was saved is retrieved again.
- **Concurrency:** a per-job lock file prevents overlapping polls, including across two Pi processes on the same project.

## Configuration

Layers, with later ones winning:

1. Defaults
2. `~/.pi/agent/pi-batch-openrouter/config.json` (global)
3. `.pi/pi-batch-openrouter.json` (legacy, read-only)
4. `.pi/batch.config.json` (project)

Invalid values fall back to the default and are reported. Legacy keys (`defaultProvider`, `pollIntervalMs`) are migrated. `outputBaseDir`/`docs/batches` is retired.

```json
{
  "schemaVersion": 1,
  "defaultModel": "anthropic/claude-opus-5.5",
  "defaultAccount": "openrouter",
  "endpoint": "/v1/chat/completions",
  "storagePath": ".pi/batches",
  "notifyOnComplete": true,
  "request": { "maxTokens": 16000 },
  "polling": { "enabled": true, "intervalSeconds": 60, "maxBackoffSeconds": 900, "requestTimeoutSeconds": 60 },
  "context": {
    "respectGitignore": true,
    "batchIgnoreFile": ".pi/batchignore",
    "maxFileBytes": 1000000,
    "maxContextCharacters": 1000000,
    "excludePatterns": ["node_modules/", ".venv/", "venv/", "dist/", "build/", "__pycache__/", ".pi/batches/"]
  },
  "security": { "scanSecrets": true, "blockOnSecret": true, "allowOutsideWorkspace": false },
  "injection": { "maxCharacters": 30000, "includeObjective": true, "includeArtefactPaths": true },
  "submission": { "showPreview": true, "requireConfirmation": false },
  "workflows": { "maxRequestsPerBatch": 100, "maxCharactersPerItem": 500000, "maxTotalCharacters": 5000000, "maxSynthesisCharacters": 1000000 }
}
```

These are application defaults (local policy), not OpenRouter limits. OpenRouter documents a 200 MB batch
payload limit and no maximum request count. Setting `excludePatterns` replaces the whole list. The
`workflows` section is optional; Release 1 configuration files keep working unchanged.

## LLM tools

All tools call the same `BatchService` as the slash commands, so they get the same path, exclusion, secret, limit and duplicate checks.

- `batch_submit_goal` (`prompt`, optional `files`, `model`, `provider` (account alias)) submits a single deferred goal.
- `batch_plan_files` (`prompt`, `files`, optional `model`, `group_size`) builds and saves a map-files plan. It **never submits** and incurs no cost.
- `batch_submit_plan` (`batch_id`) submits a saved plan. It is described to the model as **cost-bearing**, to be used only after the user agrees.
- `batch_get_items` (`batch_id`) is a read-only item inventory.
- `batch_check_jobs` (optional `batch_id`) reconciles, then reports from local state.

## Known limitations

- **Cancellation.** OpenRouter documents a `cancelling`/`cancelled` status but **no cancel endpoint** (checked 2026-10-16). `/batch cancel` records the request, tries the OpenAI-compatible `POST /batches/{id}/cancel`, and reports "unsupported" on 404/405. The batch may still complete and be billed; the job then ends `ready`, never falsely `cancelled`.
- **No model-generated summaries.** `--summary` injects a marked excerpt.
- **Legacy jobs are not imported.** Jobs recorded by pre-Release-1 versions in `~/.pi/agent/pi-batch-openrouter/jobs.json` are not shown. An import command was deferred so it would not delay multi-request correctness.
- **Scope.** `/batch ask` is one batch with one request. `/batch run map-files` is one batch with one request per file or group. Both support only `/v1/chat/completions` and only text files (no images or URLs). There are no dataset-row workflows and no project-local workflow definition files. One batch uses one model.
- **Model eligibility is decided by OpenRouter.** A model having a normal endpoint does not mean it has a `:batch` endpoint. The extension does not claim eligibility; it preserves the provider's 400/404/422 response and never switches models on its own.
- **Item-level usage** appears only when the upstream provider includes it per item. Otherwise only batch totals are shown.
- **Print mode.** In `pi -p`, Pi has no UI, so command output (`notify`) is not displayed. The state on disk is still correct.

## Development

```
npm install
npm run check   # type-check source and tests
npm test        # compiles to .test-build/ and runs node:test
```

The tests use a scripted fake OpenRouter (`test/fixtures/fake-openrouter.ts`). No network access or API key is needed. The fake rejects:
- `custom_id`s outside `[A-Za-z0-9_-]{1,64}` (HTTP 422, like the live defect)
- duplicate IDs
- empty `requests`
- `requests` not serialised last
- per-request models that differ from the batch model

Passing the fake does not prove every upstream rule is met.
