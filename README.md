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

Or define a reusable workflow once and run it over CSV or JSONL data, one request per row, with JSON output
validated against a schema and exported with full provenance:

```
/batch workflow validate classify-tickets
/batch run classify-tickets --input data/tickets.csv --preview
/batch submit B-20261019-QNM4
/batch export B-20261019-QNM4 --format jsonl
```

Then turn validated results into controlled files: Markdown, HTML or PDF, rendered locally and traceable to
the job they came from. Edit the Markdown with Pi first if you like:

```
/batch artifact B-20261017-K3M9 --synthesis --template report --format markdown --out reports/review.md
/artifact render reports/review.md --format pdf --out reports/review.pdf
/artifact show A-20261019-E1ZF
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
| `/batch run <workflow> --input <file> [options]` | One batch, one request per dataset row, from a project workflow (see [Project workflows and datasets](#project-workflows-and-datasets)). |
| `/batch workflow list \| show <name> \| validate <name> \| validate --file <path>` | Discover, inspect and validate project workflows (`.pi/batch-workflows/*.yaml`). Local only. |
| `/batch export <id> --format jsonl\|csv [--out <path>] [--overwrite] [--job-only]` | Write a finished job's results with provenance to a file (see [Export](#export)). |
| `/batch artifact <id> [--synthesis\|--item <sel>] --format markdown\|html\|pdf\|text [--template <name>] [--out <path>] [--overwrite] [--allow-partial]` | Write a controlled file from validated results (see [Artifacts](#artifacts)). |
| `/artifact list [--job <id>]` · `show <id>` · `render <file.md> --format html\|pdf` · `regenerate <id>` · `templates` | Inspect artifacts, render Pi/user-edited Markdown, re-render without a model call, list templates. |
| `/batch metadata plan --context <context.md> --input <tables.jsonl> [--domain <slug> --uc-prefix <PREFIX>] [--preview]` · `summary` · `review` · `approved` · `validate-approved` | Databricks table descriptions and column comments: proposals, review and a handoff file (see [Databricks metadata enrichment](#databricks-metadata-enrichment-phase-1) and [UC metadata standards mode](#uc-metadata-standards-mode)). |
| `/batch [--global] privacy [standard\|no-training\|zdr\|attest\|unattest\|refresh]` | Show or set the project privacy level, record or clear the no-training attestation, or reload the model catalog (see [Privacy levels and free models](#privacy-levels-and-free-models)). |
| `/batch chat [continue\|resume\|clear\|rename\|model\|compact\|context\|cost\|export\|retry\|off\|help]` | Chat with a batch model; replies arrive when the batch completes (see [Batch chat](#batch-chat)). |
| `/batch web [--port n] [stop]` | Local web UI on 127.0.0.1 with a one-time sign-in link (see [Web UI](#web-ui-batch-web)). |
| `/batch import-legacy <jobs.json> --preview` | Read-only inventory of pre-Release-1 jobs (see [Known limitations](#known-limitations)). |
| `/batch submit <id>` | Submit a job created with `--preview` (goal, workflow, retry or synthesis). |
| `/batch list [--status active\|done\|ready\|failed\|…\|all] [--limit n]` | List jobs from **local** state (no network). `ITEMS` shows usable/total for multi-request jobs. |
| `/batch show <id>` | Local status vs provider status, timings, usage/cost (only if reported), item counts, linked retries/syntheses, errors, artefact path, recent events. |
| `/batch items <id>` | Item inventory: status, source, output availability, plus combined coverage with linked retry jobs. |
| `/batch item <id> <n\|custom_id\|source-id\|id:<source-id>\|path> [--text] [--raw]` | One item: custom ID, source, item status, validation, provider error, item usage (only if returned), artefact paths; `--text` adds the result, `--raw` the provider's raw item entry. |
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

## Privacy levels and free models

Each project has a privacy level. It only ever **tightens what this extension sends**; it does not change your
OpenRouter account settings.

| Level | Meaning | Batch jobs | Immediate requests (free models) |
|---|---|---|---|
| `standard` (default) | No extra restriction. Batch request bodies are byte-identical to earlier versions. | No privacy fields added. | No privacy fields added. |
| `no-training` | Providers must not train on your data. | Allowed only after you attest (below). | `provider: { data_collection: "deny" }` |
| `zdr` | Zero data retention providers only. | Pinned to the model's ZDR endpoints (see below). | `provider: { zdr: true }` |

```
/batch privacy                      show the level, attestation and catalog state
/batch privacy zdr                  set this project's level (--global for every project)
/batch chat privacy no-training     raise one chat thread (never below the project level)
```

The effective level of a job or thread is the **stricter** of the thread and the project. Lowering the project level
later does not lower an existing thread. The extension never sends anything less strict than the effective level.
Every privacy decision reads the `privacy` config section fresh from disk, so a level raised in another Pi session, the
standalone web UI or by editing the config file applies to this process's next decision too. A config file that can't
be parsed, or an invalid `privacy` value (a typo such as `"ZDR"`), never relaxes anything: each setting then takes its
most private value from what could be read, the last clean read and the settings this process started with.

### What is enforced per route

- **Batch route.** The Batch API accepts only `provider.only` and `provider.allow_fallbacks`, so the extension never
  adds `data_collection` or `zdr` to a batch body.
  - At `no-training`, batch jobs are refused unless `privacy.accountNoTraining` is true.
  - At `zdr`, the job is pinned with `provider.only` set to the **full ZDR endpoint tags** from
    `/api/v1/endpoints/zdr` for that model (for example `azure/eu`), not base provider slugs, plus
    `allow_fallbacks: false`. It is refused when the model has no ZDR endpoint, when your own `--provider` pin has none
    in the ZDR list, or when the catalog was not loaded successfully this session.
- **Immediate route.** Models with the `:free` suffix run through `POST /chat/completions` and carry the
  `data_collection` or `zdr` field above. Items sent later (after a per-minute 429 or a crash) go out at the stricter
  of the job's recorded level, the current project level and the thread's own level; an escalation is recorded as a
  `privacy_escalated` event. An explicit `immediate` route (picker or web API) is accepted only for a `:free` model or
  one the catalog lists as free.
- Refusals read `Privacy level <level>: <reason>` and nothing is sent.
- **Model names** are normalised before any catalog lookup by stripping `:batch` and `:free`.
- **Stale previews.** Submitting a previewed job is refused if the project level has been raised above the level the job
  was prepared at. Recreate the job. A previewed `no-training` batch job is also refused once the attestation has been
  removed.
- **Retries** keep their source job's level (the stricter of the source and the project).
- Metadata, map-files, dataset and synthesis jobs go through the same enforcement point as any other job.

### Attestation

OpenRouter's account-level privacy settings control whether providers may train on your data, and the extension cannot
read them. `/batch privacy attest` (or the web attest control) records that **you** confirm your account disables
training, and stores `privacy.accountNoTraining: true` with `privacy.attestedAt`. The extension cannot verify it.
`/batch privacy unattest` clears both.

### Account settings the extension cannot see

These are yours to set at OpenRouter, and the extension never checks them:
- [Privacy settings](https://openrouter.ai/settings/privacy): logging, and the use of inputs and outputs for training.
- The training settings for free and paid models (same page).

A one-time notice repeats this the first time you raise a project above `standard`.

### Remote deletion and retention

OpenRouter keeps batch results for 30 days unless you delete them. At `no-training` and `zdr`
(`privacy.deleteRemoteBatches`, default `true`), a finished batch is deleted at OpenRouter with `DELETE /batches/{id}`
**after** its raw final response is saved locally. A batch that ends without results (OpenRouter reports it failed,
expired or cancelled) is deleted too; one OpenRouter reports gone (HTTP 410) is not.
- The decision uses **each job's own recorded level**, never the current config. A job made at `standard` is never
  deleted remotely, even if the project is raised later.
- Deletion is retried with exponential backoff (30 s, doubling, at most 1 hour apart). 24 hours after the first
  attempt the job's remote deletion is marked `failed`, shown as needing attention in the status badge,
  `/batch show` and the web UI; delete the batch yourself. A missing API key does not count as an attempt: the job
  waits, shown as "waiting for an API key" in the badge, `/batch show` and the web UI, until a key is available.
- Local files are unaffected.

### Model catalog

The extension loads `/api/v1/models` and `/api/v1/endpoints/zdr` once on every Pi `session_start`, web server start
and web workspace switch. Loads are deduplicated. A last-known copy is kept on disk **for display only**: a catalog read
from disk is never used to authorise a `zdr` send. If the load fails, `zdr` batch sends are refused until
`/batch privacy refresh` (or `/batch chat model --refresh`, or the web "Refresh models" button) succeeds; no restart is
needed. The model picker labels models `batch`, `free` and `ZDR`, and hides the ones the level rules out.

### Free models

Models ending in `:free` run immediately, not as a batch. They work **only in batch chat** (`/batch chat`):
`/batch ask`, map-files, datasets, metadata and synthesis refuse them with "Free models run only in batch chat
(/batch chat); /batch ask and workflows need a batch model". Each chat turn is still a job and settles through the
usual retrieval path.
- **Per-minute 429:** the request is rescheduled using `Retry-After`, or with exponential backoff capped at 15 minutes.
- **Daily 429:** the job fails with "Free-model daily limit reached; try later or switch model".
- **Crashes:** an immediate request is never sent twice. If the outcome is unknown after a crash, the job becomes
  `submission_unknown` and you decide whether to retry.

### Probe script

`scripts/privacy-probe.mjs` checks live that the Batch API accepts the privacy-related `provider` fields. **It
submits real batches and bills your account**, so you run it yourself:

```
node scripts/privacy-probe.mjs <model> [--account <alias>]
```

It reads the key like the standalone web server (the account's entry in `~/.pi/agent/auth.json`, or
`OPENROUTER_API_KEY` for the default account), prints a cost note, and requires typing `yes`. It submits up to three
one-request batches (`max_tokens: 1`, content "ping") and reports `ACCEPTED` or `REJECTED (<status>: <detail>)` for
`provider: { data_collection: "deny" }`, `provider: { zdr: true }`, and `provider: { only: [<first ZDR endpoint tag>],
allow_fallbacks: false }` (skipped if the model has no ZDR endpoint). Accepted batches cannot be cancelled, so their
IDs are printed and the script polls for up to 10 minutes, then deletes them. Exit codes: 0 done, 1 usage error or no
key, 2 not confirmed.

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

**Instructions versus source material.** The synthesis prompt keeps the synthesis task apart from the
material being synthesised. That material, everything that came from earlier requests, is treated as
untrusted data: the original source objective, every item result, and source file names.
- The task is stated in a synthesis-specific system message and in the `SYNTHESIS TASK` and
  `OUTPUT REQUIREMENTS` sections. Coverage is generated locally.
- The original objective is quoted in its own section, labelled as context that must not be carried out.
- Each item result is quoted in a block between `<<<BEGIN … TOKEN>>>` and `<<<END … TOKEN>>>` lines.
  The token is derived from the quoted content and checked not to occur in any of it, so source text cannot
  end a block early or imitate a section. Quoted text is kept byte for byte.
- File names and provider error reasons are JSON-quoted on a single line.

This was added after a live test in which the synthesis model obeyed an instruction-like original objective
("Reply with exactly the single word …") instead of synthesising. The separation makes that confusion much
less likely. It is **not** complete protection against prompt injection: a model can still be influenced by
quoted text, so synthesis output, like all batch output, is advisory and needs review.

### Usage and cost (multi-request)

- **Batch level:** the batch's usage is shown exactly as returned: tokens, charged cost, BYOK flag, upstream inference cost.
- **Item level:** usage is recorded only when the provider includes it in that item's response body.
- **No allocation:** batch cost is never divided across items. `/batch item` says "not reported per item" when that is the case.

## Project workflows and datasets

A project workflow is **declarative configuration** for the existing batch engine: one YAML file in
`.pi/batch-workflows/` that names a dataset's ID column, the fields to send, one prompt template, and
optionally a JSON Schema for the output. It is data, not a program. A workflow cannot run commands or
scripts, call URLs, import other files, read environment variables, or evaluate expressions.

```yaml
# .pi/batch-workflows/classify-tickets.yaml
schemaVersion: 1
name: classify-tickets            # must equal the file name
description: Classify support tickets
model:
  default: openai/gpt-oss-20b     # optional; else the configured default. Optional `provider:` pin.
input:
  type: csv                       # csv | jsonl
  idField: ticket_id              # stable source ID (never sent unless also listed in fields)
  fields: [title, description]    # the ONLY values sent; each must be used in the prompt
  # delimiter: ","                # csv only: "," ";" "\t" or "|"
request:
  # system: "literal system prompt (no templates)"
  prompt: |
    Classify this ticket.

    Title:
    {{title}}

    Description:
    {{description}}
  # maxTokens: 2000
output:
  type: json                      # markdown | json
  schema:                         # JSON Schema draft-07; top level must be an object
    type: object
    additionalProperties: false
    required: [category, rationale]
    properties:
      category: { type: string, enum: [billing, bug, other] }
      rationale: { type: string }
synthesis:
  enabled: false                  # true allows /batch synthesize on its jobs
limits:                           # optional; can only tighten the local config limits
  maxRequests: 100
  maxCharactersPerItem: 100000
```

**Validation** (`/batch workflow validate`) is strict. It reports each problem with its file and location
(for example `request.promt: unknown property "promt"`), and an invalid workflow cannot be run. The rules:
- `schemaVersion` is required; only `1` is supported.
- Unknown properties are rejected at every level, as are wrong types and invalid values.
- YAML must be a single document with unique keys, and no anchors, aliases or custom tags.
- Names use `[a-z0-9-]`, must equal the file name, and cannot redefine the built-in `map-files`.
  Two files claiming one name (`x.yaml` and `x.yml`) make both unusable.
- The template's fields must be exactly `input.fields`.
- A JSON output schema must compile in strict mode, with no unknown keywords and no remote `$ref`.

Discovery reads only the workflow folder itself (not subfolders), in file-name order, and does not follow
symbolic links. `/batch workflow validate --file <path>` checks a draft anywhere in the workspace.

**Templates** support `{{field}}` (or `{{ field }}`) and nothing else: no expressions, filters, dots, loops,
helpers or escapes. Any `{{` that is not a plain field reference is a validation error. A lone `}}` is ordinary
text, so JSON examples can appear in prompts. Values are substituted in a single pass and are never scanned
again, so braces or `{{...}}` inside your data stay data. A missing value fails planning; it is never replaced with "".

For `output.type: json`, a fixed `OUTPUT FORMAT` section is appended after the rendered prompt. It contains
the schema and asks for one JSON object with no surrounding text.

### Datasets

| | CSV | JSONL |
|---|---|---|
| Encoding | UTF-8 (leading BOM ignored); CRLF, LF and mixed | same |
| Structure | header row; RFC 4180 quoting (quoted delimiters, `""` escapes, multi-line fields) | one JSON object per non-blank line |
| Blank lines | ignored and counted in the preview | ignored and counted |
| Fatal | duplicate headers, missing required columns, a record with the wrong column count, unterminated quotes | any line that is not valid JSON or not an object (reported with its **line number**) |
| Values | strings; an empty field is a value | strings, numbers, booleans (`String()`); null, missing, objects and arrays are row errors |
| Position | `row` = data record number (header excluded) | `line` = physical line number |

**Stable identity.** Every row needs a source ID in `idField`: non-empty, at most 256 characters, no control
characters (in JSONL it may also be an integer). A missing or duplicate ID **anywhere** in the file fails planning,
even for rows you didn't select. IDs are never generated. The source ID is kept separate from the provider
`custom_id`, which stays `<local ID>_request-NNN`. Each item records:
- the dataset path and type;
- its row or line;
- the source ID;
- the selected field values;
- an input SHA-256 (canonical source ID plus values);
- its request SHA-256.

**Selection.** Give `--id <source-id>` (repeatable), or a range with `--from-row <n>` and/or `--to-row <m>`
(1-based record numbers, so JSONL counts records, not lines). You can't combine `--id` with a range. Rows are
always planned in dataset order, and an unknown ID fails the plan. Rows with invalid fields block the plan only
when they are selected; others are counted as invalid.

**Data minimisation and checks.**
- Only the selected fields are put into prompts, and other columns are never read into a request.
- The dataset path gets the same containment, hard-deny, `.pi/batchignore` and configured-exclusion checks as
  `--file`. `.gitignore` is **not** applied to datasets, because data files are routinely gitignored.
- The secret scan covers **exactly the provider-bound messages** of every planned item. A finding blocks the
  plan and is reported by item and row, never by value.
- Diagnostics name rows, lines and fields, never row contents. Parser messages that quote input are replaced.

**Preview** (`--preview`, or a plain `run`, which previews before it submits) reports:
- rows parsed, selected, excluded and invalid, plus blank lines;
- missing and duplicate IDs;
- requests planned;
- the fields sent;
- model and provider pin;
- the output mode;
- provider-bound characters (not tokens) and the largest item;
- the effective local limits;
- the secret-scan result;
- whether synthesis is enabled;
- a **plan SHA-256**.

No cost is estimated. A plan over limits fails; it is never split into several paid batches.

**Determinism and immutability.**
- **Identical inputs give an identical plan:** same workflow definition, dataset bytes, selection, model and
  pin produce the same source IDs, request order, prompts, request hashes and plan SHA-256. Only local job IDs
  and `custom_id`s differ.
- **The stored request is what gets submitted:** a preview persists the exact request, a verbatim copy of the
  workflow file, the resolved definition with its hashes, and the dataset hash and mapping.
- **Edits after preview don't change it:** if the workflow file changes before submit, `/batch submit` warns
  and records an event, then sends the request exactly as previewed. It never rebuilds the request from the
  new file.

### Structured output

For JSON workflows, each item's raw text is kept (`raw.json`, `result.md`), and then:
1. **Extraction is strict:** the whole response must be one JSON object, or exactly one outer
   ```` ``` ```` / ```` ```json ```` fence around one (accepted, with a warning). Prose around the JSON, several
   fences, arrays and scalars are invalid. JSON is never searched for inside text.
2. **Validation** is by [Ajv](https://ajv.js.org/) against the schema stored **with the job**. It uses draft-07,
   adds no defaults, does no type coercion and removes no properties.
3. **Outcomes:**
   - A valid object is stored separately as `result/items/NNN/output.json`.
   - Invalid JSON (`invalid_json`) or a schema mismatch (`schema_invalid`) makes the item **corrupt**. Its errors
     are persisted (locations and rules, not values), and nothing is invented or coerced.
   - Release 2 outcome rules apply unchanged: some valid and some corrupt items give a `partial` job.

Provider-native structured output (`response_format`) is not used. Local validation is authoritative.

### Retry and synthesis with datasets

`/batch retry-items` works unchanged. A retried row keeps its source ID, row or line, input hash and selected
values, and its workflow and dataset identity and hashes. It links to its parent job and item, and gets a new
`custom_id`. The retry also carries the parent's stored workflow files, so it is validated against the same schema
even if the workflow file has changed. `/batch synthesize` is the Release 2 linked synthesis, with the same
instruction/source isolation. Item results and source IDs are quoted, untrusted material. It is refused for jobs of a
workflow with `synthesis.enabled: false`.

### Export

`/batch export <id> --format jsonl|csv` writes one record per item, but only when you run the command
(there is no agent tool for it).

| Column | Meaning |
|---|---|
| `job_id`, `workflow`, `workflow_sha256`, `dataset_path`, `dataset_sha256` | job and workflow provenance |
| `ordinal`, `source_id`, `source_row`, `source_line`, `custom_id` | item identity (`source_id` is the file path for map-files jobs) |
| `result_job_id`, `result_custom_id` | where the exported result came from (this job or a linked retry) |
| `status` | `completed`, `failed`, `corrupt`, `missing`, `untrusted` (item of a corrupt batch), … |
| `result` | parsed JSON object (JSONL) or one compact JSON string (CSV) for JSON workflows; text for markdown |
| `validation_errors`, `finish_reason`, `error_code`, `error_message` | as recorded |
| `input_tokens`, `output_tokens`, `cost` | only if the provider reported them **for that item**; otherwise null / empty, never estimated |

- **Retries:** by default, results from linked retry jobs fill gaps (combined coverage). `--job-only` exports
  only the job's own items.
- **Destination:**
  - The default is a new timestamped file in the job's `exports/` folder.
  - `--out <path>` must resolve inside the workspace, including through symlinked directories, and must not be a
    hard-denied or `.git` path.
- **No overwrite:** an existing file is never overwritten unless you pass `--overwrite`.
- **Atomic writes:** the file is written to a temporary file, flushed, then created exclusively.
- **History:** every export is recorded in the job's manifest and events.
- **CSV specifics:**
  - CRLF line endings, RFC 4180 quoting, no BOM.
  - A cell starting with `=`, `+`, `-`, `@`, tab or CR gets a leading `'`, so a spreadsheet does not run model
    output as a formula.
  - JSON results are never flattened into columns.
  - JSONL is the exact representation.

## Artifacts

An artifact is a file produced from validated batch results by a **trusted local renderer**. The model supplies
content (validated text or schema-validated JSON) and never controls anything else.

```
UNTRUSTED                     validated result (text, or JSON checked against a schema)
---------------------------------- trust boundary ----------------------------------
TRUSTED                       template (local data) -> renderer (in process) -> file at a path you chose
```

- **Model output never chooses** a path, a renderer, a format, a command, a URL, or code to run.
- **Paths** come only from:
  - your `--out`;
  - your workflow's `artifact.filename`;
  - a fixed internal default inside the artifact's folder.
- **No automatic files:** retrieving a batch never creates one. Only `/batch artifact`, `/artifact render` and
  `/artifact regenerate` do, and none of them calls OpenRouter or a model.

### Creating artifacts

```
/batch artifact <job> --format markdown|html|pdf|text [--synthesis | --item <n|custom_id|source-id>]
                      [--template <name>] [--out <workspace path>] [--overwrite] [--allow-partial]
```

**Source**, one of:
- **`--synthesis`**: the newest *ready* synthesis of the job.
- **`--item`**: one completed item. A dataset item with JSON output gives its parsed `output.json`.
- **Neither**: the whole job result.
  - Requires a ready job, or a partial one with `--allow-partial`; the gap is recorded and warned about.
  - JSON jobs give `{ "items": [ { "source_id": …, …parsed fields } ] }`.

Corrupt, failed and unfinished jobs are refused.

**Formats:**

| Format | From | Notes |
|---|---|---|
| `markdown` | text, or JSON through a template | UTF-8 `.md`/`.markdown` |
| `html` | Markdown | self-contained; see the HTML rules below |
| `pdf` | Markdown | rendered locally by pdfkit; validated before it is written |
| `text` | the source content unchanged | `.txt .md .json .csv .yaml .yml .sql`; JSON sources only to `.json` (pretty-printed); a `.json` destination must parse |

**Executable types are refused** (allowlist). Every other extension is refused, including `.ps1 .sh .bat .cmd
.exe .dll .com .msi .js .py` and macro-enabled Office files. Generated code is not materialised in this release,
and nothing is ever executed.

### Templates

Artifact templates live in `.pi/artifact-templates/<name>.yaml` and are **data**:

```yaml
schemaVersion: 1
name: findings-report            # must equal the file name
input:
  type: json                     # json: a validated object; text: the result as {{content}}
  schema:                        # json only: draft-07 schema the data must satisfy before rendering
    type: object
    required: [title, executiveSummary, findings]
    properties:
      title: { type: string }
      executiveSummary: { type: string }
      findings: { type: array, items: { type: string } }
body: |
  # {{title}}

  {{executiveSummary}}

  ## Findings

  {{findings}}
```

**Placeholder rules.** The body uses the same `{{field}}`-only engine as workflows, so there are no expressions,
loops, includes, environment variables or code, and values are never re-scanned. For JSON input, every
placeholder must be a **required** schema property, so missing data fails before anything is rendered.
Values become Markdown by fixed rules:
- strings as is;
- lists as `- item` lines;
- lists of objects and objects as `**key:** value`;
- deeper nesting or `null` is an error.

**Validation.** Invalid structured data fails with schema errors (locations, not values), and nothing is rendered.
`/artifact templates` lists templates with their problems. Each artifact records the template's file hash and the
hash of the resolved input. It also keeps a copy of the template, so later edits to the template file never change
an earlier artifact's recorded provenance.

### HTML rules

The Markdown is treated as untrusted text:
- **Raw HTML** in the Markdown is escaped and shown as text.
- **Images** are not loaded; each becomes `[image: alt]`.
- **Links** keep only `http(s)`, `mailto`, `#` and relative targets.
- **Content-Security-Policy:** the page carries one that blocks scripts and every external resource, as a second
  layer.
- **Styles** are inline; nothing is fetched.

### PDF renderer

PDFs are laid out **in process by [pdfkit](https://pdfkit.org/)**, which is pure JavaScript. There is no browser,
no external program, no web service and no network access at render time, so it works the same on locked-down
Windows. The model never produces PDF bytes.

**Supported Markdown:**
- headings and paragraphs, with bold, italic and inline code;
- lists, including nested;
- code blocks, quotes, rules and tables (one line per row);
- links, shown as text with the target, not as clickable annotations;
- images, shown as alt text.

**Validation before writing.** The file goes to its destination only after these checks: `%PDF-` header,
`%%EOF`, a `startxref` offset pointing at the cross-reference section, `/Root`, and at least one page. Otherwise
nothing is written. The tests also load every PDF with an independent parser (pdf-lib).

**Fonts.** The PDF standard fonts (Helvetica, Courier) are used. They are not embedded and cover Windows-1252.
Other characters become ASCII equivalents (`→` becomes `->`) or `?`, and the artifact records how many were
replaced.

**Determinism.** Metadata dates are a fixed constant, so the same Markdown gives byte-identical PDFs. The render
time is in the manifest.

**Rendering dependencies:**

| Package | Version | License | Kind | Network at render time | Why |
|---|---|---|---|---|---|
| `marked` | 18.0.11 | MIT | pure JS, no dependencies | none | Markdown parser; already in Pi's own dependency tree |
| `pdfkit` | 0.20.2 | MIT | pure JS (fontkit, linebreak, fflate, png-js, @noble/*) | none | in-process PDF layout; no browser, executable or service |
| `pdf-lib` | 1.17.1 | MIT | pure JS, **development only** | none | independent PDF parser used by the tests |

### Provenance, the Pi-curated route, and regeneration

Each artifact has a manifest at `.pi/batches/artifacts/<A-id>/manifest.json`, with an `events.jsonl` history,
a `source.md` holding the exact Markdown rendered, and a `template.yaml` copy. It records:
- **Source:** batch result, item, synthesis or local file, with its job and item IDs, the files read and their
  SHA-256.
- **State:** `batch-generated`, `unmodified-generated-output`, `modified-after-generation` or
  `unlinked-local-file`.
- **Lineage:** the artifact it was derived from or regenerated from, and the generation number at that path.
- **Rendering:** the template and its input hash, the renderer and version, the destination and its SHA-256, and
  the hash of any file replaced with `--overwrite`.

**Pi-curated route.** `/batch artifact … --format markdown --out reports/x.md` creates an ordinary workspace
file, so Pi can read and edit it with its normal tools. Then `/artifact render reports/x.md --format pdf --out
reports/x.pdf` renders what the file contains **now**:
- the new artifact records the current file's hash;
- it links to the artifact that generated the file and to the originating job;
- its source state says whether the file was **edited after generation**.

An edited document is never presented as the original batch output.

**Regeneration.** `/artifact regenerate <id> [--format …] [--out …]` re-renders the stored `source.md`, after
checking its hash. It makes no model or OpenRouter call, and identical input gives identical output.

**Safety:**
- **Destinations** must resolve inside the workspace, including through symlinked directories, and may not be
  inside `.pi/`, hard-denied paths or `.git/`.
- **No overwrite** without `--overwrite`. Every successful render gets a new manifest, so earlier provenance is
  never lost.
- **Atomic writes:** each file is written to a temporary file, flushed, then hard-linked into place, or renamed
  over the target with `--overwrite`. A failed render writes nothing.

**Workflow default.** A Release 3 workflow can declare the artifact its jobs produce:

```yaml
artifact:
  template: findings-report
  format: pdf
  filename: reports/findings.pdf
```

The default is **never generated automatically**:
- when the job finishes, the notification and `/batch show` say an artifact is available;
- `/batch artifact <job>` with no format, template or `--out` uses this default, read from the definition stored
  with the job.

## Batch chat

`/batch chat` is a conversation with a batch-capable model at batch prices. Each message is one single-request
batch job, so a reply arrives when that batch completes (typically well within 24 hours), not immediately.
Close Pi and come back: threads are stored on disk and the background poller delivers the reply.

```
/batch chat                  start a thread; plain text now goes to the batch model
hello, can you review my plan?
/batch chat off              plain text goes to the live Pi model again
/batch chat continue         come back later
```

Chat mode is per Pi session and is off when Pi starts. Lines starting with `/` are always commands.

| Command | Purpose |
|---|---|
| `/batch chat` | Start a new thread and enter chat mode. |
| `/batch chat continue` | Re-enter the most recently active thread. |
| `/batch chat resume [thread]` | Pick a thread, or give an ID suffix or exact title. |
| `/batch chat clear` | Start a fresh thread. The old one stays resumable. |
| `/batch chat rename <title>` · `rename --auto` | Rename the thread (this locks the title) · unlock auto-titling. |
| `/batch chat model [slug] [--refresh]` | Change the model from the next message on. No slug opens a picker. `--refresh` reloads the model catalog first. |
| `/batch chat privacy <level>` | Raise this thread to `no-training` or `zdr`. It never goes below the project level. |
| `/batch chat compact [focus]` | Summarise older messages now, with optional focus instructions. |
| `/batch chat context` | Estimated size of the next request and distance to auto-compact. |
| `/batch chat cost` | Usage and cost totals the provider reported for this thread. |
| `/batch chat export [file] [--overwrite]` | Write the transcript as Markdown to a workspace-relative file, or show it. |
| `/batch chat send [--file <path>] [--context <dir>] "<message>"` | Send a message with workspace files or directories attached. |
| `/batch chat retry [--force]` | Resubmit the last turn if it failed. `--force` is needed after "no response from OpenRouter" (see below). |
| `/batch chat off` | Leave chat mode. |
| `/batch chat help` | List these commands. |

**Footer.** In chat mode the footer shows `💬 <title> · <model>`, with `· waiting` while a reply is pending and
`· compacting` while a compaction runs. Once usage reaches 80% of `chat.autoCompactTokens`, it adds
`· N% until compact`, where N is the percentage **remaining**.

**Isolation.** Chat text is stored in `.pi/batches/threads/` and is never added to the live model's context.
After `/batch chat off`, the live model does not know what you said to the batch model.

**Queueing.** One reply is awaited per thread. Messages you type while a reply is pending are queued and sent
together as one message once the reply lands. In exports, a reply is shown before the messages queued behind
it. After a failed turn, new messages are queued until you run `/batch chat retry`.

**Retry after "no response from OpenRouter".** If a submit times out or the network drops, OpenRouter may still
have accepted, and billed, the turn. That failure is marked as *submission unknown*, and a plain
`/batch chat retry` is refused so you do not pay twice. Check your OpenRouter activity first. Only if the turn was
not billed, run `/batch chat retry --force`. A submit that is still in flight (or that Pi was stopped during) is
never declared lost while its batch job exists: the poller links the job back to the thread and the reply
arrives as usual.

**Attachments.** `/batch chat send --file`/`--context` (and the web UI) attach workspace files; the web UI also
uploads text files, PDFs and images. What is scanned for secrets, and what is not:

| Attachment | Sent as | Secret scan |
|---|---|---|
| Workspace files and directories | text | Yes, with the same exclusions as `/batch ask` (hard-deny, `.pi/batchignore`, `.gitignore`, size limits). |
| Uploaded text, code, CSV, JSON, Markdown | text | Yes. |
| PDF, text mode (default) | extracted text | Yes, on the extracted text. A PDF with no extractable text (for example a scan) is **refused**, never sent raw. |
| PDF, multimodal mode | the raw file | **No.** Needs an explicit per-file opt-in (`allowUnscanned`; the web UI asks per file). |
| Image (PNG, JPEG, WEBP, GIF) | the raw image | **No.** Needs the same per-file opt-in. |

A message with a finding is refused before anything is saved. Each binary file sent unscanned adds a warning to
the thread. A binary attachment is sent only with the turn it belongs to; later turns carry a short
`[attached: name (type, size)]` placeholder instead, so it is not paid for again on every turn. The context
estimate counts attachments (base64 characters / 4). PDF text extraction is bounded (time, decompressed size),
and a PDF that exceeds a limit is refused as "could not extract".

**Compaction.** Everything before the `chat.keepRecentExchanges` most recent exchanges can be replaced by a
summary in later requests; the full transcript is kept. It runs automatically when the estimated next request
exceeds `chat.autoCompactTokens` (estimate: characters / 4), or on demand with `/batch chat compact`. Sending
continues while it runs, and the summary applies from the next request after it lands.

**Titles.** A thread is titled from its first message. Once, around message `chat.retitleAtTurn`, the model
proposes a better title. `/batch chat rename` locks the title; `rename --auto` unlocks it.

**Project instructions.** If `.pi/BATCH_CHAT.md` exists, its text is sent with every chat request, alongside
`chat.systemPrompt`.

**Secret scan.** Messages and `.pi/BATCH_CHAT.md` get the same secret scan as other submissions. A message with
a finding is refused **before it is saved**: remove the secret and type it again. A finding in
`.pi/BATCH_CHAT.md` sends nothing; fix the file, then `/batch chat retry`.

**Chat jobs and other commands.** Chat jobs appear in `/batch list`, `show` and `view` and in the badge.
`/batch inject`, `retry`, `retry-items`, `synthesize`, `export` and `artifact` refuse them, as do the extension's
LLM tools. Use `/batch chat retry` and `/batch chat export` instead.

**Configuration** (`chat` section; defaults shown):

| Key | Default | Meaning |
|---|---|---|
| `chat.autoCompact` | `true` | Compact automatically when the limit is exceeded. |
| `chat.autoCompactTokens` | `60000` | Estimated request size that triggers automatic compaction. |
| `chat.keepRecentExchanges` | `4` | Most recent exchanges left out of a compaction. |
| `chat.retitleAtTurn` | `3` | Message number at which the model is asked for a better title. |
| `chat.systemPrompt` | a short general-assistant prompt | System prompt for every chat request. |

## Web UI (`/batch web`)

`/batch web [--port <n>]` starts a local web UI for batch jobs, chat threads, attachments and artifacts, and
prints a one-time sign-in link. `/batch web stop` closes it; it also stops when the Pi session changes. Outside
Pi, `npm run web [-- --port 3456 --cwd <workspace>]` runs the same UI standalone, with its own poller so chat
replies still land.

Security model:

- **Local only.** The server binds to `127.0.0.1` and refuses any request whose `Host` header is not
  `127.0.0.1:<port>` or `localhost:<port>`, which blocks DNS-rebinding attacks.
- **Session cookie.** The printed link carries a one-time token. Opening it sets an HttpOnly, SameSite=Strict
  session cookie and drops the token from the address bar. The page and every `/api` request, reads and the event
  stream included, need that session. Run `/batch web` again for a fresh link (for another browser, say).
- **No cross-site requests.** API calls with a foreign `Origin` or `Sec-Fetch-Site: cross-site` are refused, and
  changes also need the per-server CSRF token that only the signed-in page has. Tokens are compared in constant
  time.
- **Headers.** A Content-Security-Policy (the page's single script runs by nonce; no inline handlers),
  `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. Rendered HTML artifacts are served in a
  script-less sandbox.
- **Keys.** Standalone, the server uses only the selected account's key from `~/.pi/agent/auth.json`, or
  `OPENROUTER_API_KEY` for the configured default account, and never falls back to another account's key. Keys
  are redacted from its log.

Anyone who can run programs as you on this machine can still reach the server; it is not a multi-user service.
Switching the workspace in the UI never stops Pi's own poller: the UI polls the other workspace itself.

## Databricks metadata enrichment (Phase 1)

This proposes **table descriptions and column comments** for Databricks tables from evidence exported by
Databricks, plus one shared domain context file, through OpenRouter Batch. It produces a review document and a
reviewed handoff file for Databricks to validate and apply.

**What Pi never does here:**
- connect to Databricks or hold Databricks credentials;
- generate or run SQL;
- change Unity Catalog;
- approve anything on its own.

There are no tags, glossary, ontology or relationships in Phase 1.

```
metadata/<domain>/context.md      shared business context (untrusted source material)
metadata/<domain>/tables.jsonl    one Databricks table per line (exported by Databricks)
```

```
/batch metadata plan --context metadata/beverage/context.md --input metadata/beverage/tables.jsonl --preview
/batch submit <job>                       (then /batch check, items, item, retry-items as usual)
/batch metadata summary <job>
/batch metadata review <job> --out metadata/beverage/review.md
/batch metadata approved <job> --out metadata/beverage/approved.jsonl
/batch metadata validate-approved metadata/beverage/approved.jsonl
```

### Input: `tables.jsonl`

```json
{"table": "catalog.schema.formulation", "existing_description": null,
 "columns": [{"name": "status_cd", "data_type": "STRING", "nullable": true, "existing_comment": null,
              "sample_values": ["ACTIVE", "DRAFT"]}]}
```

**Required fields:**
- `table`: a three-part `catalog.schema.table` name;
- `existing_description`, which may be `null`;
- `columns`, each with `name`, `data_type`, `nullable` and `existing_comment` (which may be `null`).

**Optional:** `sample_values`, at most 20 scalars per column.

**Rejected input:**
- unknown fields;
- duplicate tables or columns (compared case-insensitively, as Databricks does);
- malformed lines, reported with their line number and never their values.

**Samples.** The Databricks extraction decides whether to include sample values; Pi sends exactly what is in the
file. The context and every table's evidence are secret-scanned before anything is sent, and findings block the
plan without echoing the value. The preview shows how many tables carry samples, never the samples themselves.

### One table per request, with isolation

Each request contains the shared context and **only its own table**:

```
METADATA GENERATION INSTRUCTIONS
DOMAIN CONTEXT    <<<DOMAIN CONTEXT BEGIN Q…>>> context.md <<<DOMAIN CONTEXT END Q…>>>
TABLE EVIDENCE    <<<TABLE EVIDENCE BEGIN Q…>>> one table as JSON <<<TABLE EVIDENCE END Q…>>>
OUTPUT REQUIREMENTS  (the proposal JSON Schema)
```

This uses the same isolation as synthesis:
- a task-specific system message;
- quoted blocks whose boundary token is derived from, and verified absent from, the quoted text;
- instruction-like text in the context, in names, in existing comments or in samples remains source material.

The model is told:
- explain business meaning, and don't just restate the type;
- don't invent meaning;
- keep the domain's terminology;
- treat existing comments as evidence;
- return `null` with confidence `insufficient` rather than guess.

This reduces prompt-injection risk but doesn't eliminate it.

The preview shows the context and input paths with their SHA-256, the number of tables and requests, the tables
with samples, the provider-bound characters, the largest request and the model. Planning persists the evidence,
per-table input hashes and request hashes in `request/metadata.json`.

### Proposals and validation

```json
{"table": "catalog.schema.formulation",
 "table_description": {"comment": "…", "confidence": "high|medium|low|insufficient", "reason": "…"},
 "columns": [{"name": "status_cd", "comment": null, "confidence": "insufficient", "reason": "…"}]}
```

**Validation, before an item can complete:**
- strict JSON Schema, with unknown fields rejected and no coercion;
- `table` must equal the item's **own** table, taken from the request rather than from what the model claims;
- every input column appears exactly once, with its exact name: no missing, duplicate or invented columns;
- a `null` comment requires `insufficient`, and `insufficient` requires `null`.

Invalid JSON or a failed check makes the item `corrupt`, with the raw output and errors kept. The usual outcome
rules apply (`partial`, `retry-items`, combined coverage). The checks cover identity and structure, not whether
the prose is right.

### Review and handoff

- **`review`** writes a Markdown review as an artifact. It contains:
  - coverage and confidence totals;
  - per table, the existing and proposed description, confidence and reason, a column table (existing,
    proposed, confidence), and an "Insufficient evidence" list;
  - tables without a usable proposal, listed rather than dropped;
  - the statement "Proposed metadata has not been applied to Databricks".

  Render it with `/artifact render … --format pdf`.
- **`approved`** writes a **draft** handoff (`.jsonl`, one table per line, input order, fixed keys).
  - **Existing values are kept**: a generated replacement is never approved automatically, but appears in the
    review for the reviewer to adopt.
  - Empty values take the proposal, and insufficient evidence stays `null`.
  - Every table is included. A table without a usable proposal keeps its existing values, and needs
    `--allow-partial`. In standards mode, its non-standard existing text is withheld as `null` (the live value is left
    unchanged) and marked in the review.
  - Each row carries provenance: job, result job and `custom_id`, input hash, context hash and proposal hash.
- **`validate-approved`** checks a (reviewer-edited) file against the job's stored evidence. It rejects:
  - tables or columns that aren't in the job, or are missing or duplicated;
  - altered existing values;
  - stale hashes;
  - extra fields, such as SQL.

  It reports how many values were kept, taken as proposed, **edited by a reviewer**, or left null.

```json
{"table": "catalog.schema.formulation", "existing_description": null, "approved_description": "…",
 "columns": [{"name": "status_cd", "existing_comment": null, "approved_comment": null}],
 "provenance": {"job_id": "B-…", "result_job_id": "B-…", "result_custom_id": "B-…_request-002",
                "input_sha256": "…", "context_sha256": "…", "proposal_sha256": "…"}}
```

### UC metadata standards mode

Standards mode is **opt-in**. Give a plan both a domain slug and a Unity Catalog prefix (giving only one is an error):

```
/batch metadata plan --context metadata/pinpoint/context.md --input metadata/pinpoint/tables.jsonl \
    --domain pinpoint --uc-prefix PIN_ --preview
```

`--domain` matches `^[a-z][a-z0-9_]*$`; `--uc-prefix` matches `^[A-Z0-9]+_$`. Without them, requests, proposals, review
and `approved.jsonl` are unchanged. Standards jobs record `version: 2` and `standards: { domain, ucPrefix }`; earlier
jobs keep working. The web UI's **UC Metadata** studio tab offers the same options plus the review and handoff actions.
A table whose name does not start with the prefix, or whose schema has no `bronze`/`silver`/`gold` layer, blocks the
plan and is listed.

With [contract v2](#contract-v2-profile-evidence-phase-2) evidence, a table's `layer` is its medallion layer. It must agree
with the layer in the schema name, and `layer: "other"` blocks the table. A `domain_prefix` must equal `--uc-prefix`
without its trailing `_` (case-insensitive; `PNPT` matches `PNPT_`). Each mismatch blocks the plan and lists the table.
The evidence's `contract_version` is unrelated to the job's workflow `version: 2` (standards mode). Both kinds of
guidance can appear in one prompt. Audit columns are left out with their profiles, and the review can show both the
**Tier** and the **PII** columns. Tables and columns may also carry optional `existing_tags`, which standards mode uses.

**Description and comment rules.**
- A table description has the lines `GRAIN:`, `PURPOSE:`, `SOURCE:`, `REFRESH:`, `OWNER:` and `CLASSIFICATION:`, in
  that order, and is at least 30 characters. Use a team name on the `OWNER:` line: an email address there is flagged as
  PII by the checks.
- A column comment is a plain-English definition line, then `TYPE:` (`Dimension`, `Measure`, `Key`, `Flag` or
  `Timestamp`), `VALUES:`, `SYNONYMS:` and `NULL MEANS:`, with optional `UNIT:`, `FORMULA:` and `JOIN:`. It is at
  least 30 characters.

**Tags.**
- Table tags are exactly `classification` (`public|internal|confidential|restricted|pii_scan_required`), `data_domain`,
  `uc_prefix`, `medallion_layer` (`bronze|silver|gold`) and `pii` (`true|false`).
- The model proposes **only** `classification` and the column PII tags. Pi derives `data_domain`, `uc_prefix`,
  `medallion_layer` (from the schema name) and the table `pii` (`true` if and only if some column is PII).
- **Sparse PII column tags.** A column carries either no tags or exactly `pii: "true"` with `pii_type` (`email`,
  `phone`, `ssn`, `name`, `address`, `dob`, `ip_address`, `device_id`, `financial`, `health`, `biometric`,
  `location`), `sensitivity` (`low|medium|high`) and `requires_masking` (`true|false`). `pii: "false"` is never
  emitted. A PII column in a `public` table, or a column with `pii: "false"`, makes the item `corrupt` and retryable.

**Audit columns.** `fw_pipelinerowchecksum`, `fw_ingestdate` and `pipeline_timestamp` (any case) are never sent to the
model, and their approved values are their existing values. The Lighthouse applier assigns their standard definitions.

**The draft rule.** In standards mode the `approved` draft keeps an existing value only if it passes the standards
checks, and otherwise takes the proposal. The review marks such a value as replacing a non-standard one, and
`validate-approved` reports any non-standard approved value. A valid existing PII tag is never dropped. A table with no
proposal gets derived tags with classification `pii_scan_required` (or its existing taxonomy value). A description whose
`CLASSIFICATION:` line conflicts with the tags is withheld (null) and marked. In a table with no proposal, non-standard
existing text is withheld (null) and marked. `validate-approved` checks every non-null value; only the framework audit
columns are exempt (they are locked to their existing values). A null approved value (insufficient evidence, or
withheld) stays allowed; it is counted and listed.

**Notebooks.** A `.ipynb` used as context or as an attachment has its outputs, execution counts, attachments, raw cells
and metadata stripped before sending, so nothing from cell outputs reaches the provider. Standards mode refuses a
`.ipynb` given as `--context` or `--input`.

**Two-pass flow.** The TDD's Pass 1 (reverse-engineering the domain context) needs no new workflow: run `/batch ask`
(or the studio **Goal** tab) over the scoped files, review the output into `<Domain>_context.md`, then use that as
`--context` for Pass 2 above.

**Privacy.** Tables that carry `sample_values` put real data in the request. The preview warns when that happens at
`standard`; use `zdr` for such tables.

### Contract v2: profile evidence (Phase 2)

`tables.jsonl` also accepts **contract v2**, a strict superset of v1. It carries evidence that Databricks has
already computed and obfuscated, so the model can describe a column without seeing its values. The schema
mirrors the Databricks side's `contract/tables.v2.schema.json` field for field (a test checks this).

- **v1 lines are unchanged.** Every v1 line is a valid v2 line, its `input_sha256` is the same, and its prompt
  is byte-identical.
- **Opting in:** `"contract_version": "2"` requires a `profile` on every column.
- **Table-level fields:** `layer` (bronze, silver, gold, other), `domain_prefix`, `object_type`,
  `row_count_band`, `write_cadence`, `grain_candidates`, `upstream_tables`, and sanitised `writer_logic` /
  `view_definition`.
- **Column `profile`:** `disclosure_tier` and `tier_reason` (required), `column_family_id`, `pct_null`,
  `pct_unique`, `is_candidate_key`, `format_masks`, `len_min`/`len_max`, `numeric_sign`, `magnitude_order`,
  `decimal_places`, `join_hints` and `semantic_label`.
- **Tier rules, enforced by the schema:**
  - 0 = reference values may appear in `sample_values`;
  - 1 = shape only;
  - 2 = numeric shape only (no masks or lengths);
  - 3 = a semantic label only.
  - `sample_values` are rejected on any column whose tier is 1–3.

```json
{"table": "c.lighthouse_gold.PNPT_vw_location_data", "existing_description": null, "contract_version": "2",
 "layer": "gold", "object_type": "VIEW", "upstream_tables": ["c.lighthouse_silver.PNPT_location_data"],
 "columns": [{"name": "Sector", "data_type": "STRING", "nullable": true, "existing_comment": null,
              "sample_values": ["Beverages", "Foods"],
              "profile": {"disclosure_tier": 0, "tier_reason": "low-cardinality reference value",
                          "column_family_id": "sector", "pct_null": 0.4}}]}
```

When a table uses any v2 field, its prompt gets extra guidance:
- values were withheld on purpose, so never guess them;
- what each tier and the mask letters mean (`A`, `a`, `9`);
- use layer, grain, lineage and join hints;
- keep `column_family_id` columns consistent with the context's column-family glossary;
- keep profiling statistics out of the comments.

The preview counts v2 tables. The review shows each table's layer and object type, and adds a **Tier** column.

### Provider routing and account privacy

The Batch API accepts only `provider.only` and `provider.allow_fallbacks`. Sync preferences such as `order`,
`sort`, `zdr` and `data_collection` are rejected ([batch quickstart](https://openrouter.ai/docs/batch-quickstart),
checked 2026-10-21). So:

- `routing.allowedProviders` becomes `provider.only` on **every** batch: an allow-list.
  - `routing.allowFallbacks` controls fallback **within** that list.
  - An explicit `--provider` pin must be in the list, or planning is blocked.
- **Zero data retention and data-collection rules cannot be sent with a batch.** Enforce them in the OpenRouter
  account's privacy settings, or with a guardrail on the API key.
  - Set `routing.requireZdr` and/or `routing.requireNoDataCollection` to make them local policy.
  - Planning is then blocked until you attest that the account enforces them, with `routing.accountZdrEnforced` /
    `routing.accountDataCollectionDenied`.
  - The tool cannot verify the account setting. The attestation is yours.
  - OpenRouter publishes its ZDR endpoints at `https://openrouter.ai/api/v1/endpoints/zdr`.

The metadata preview shows the effective pin, the privacy level and the account-privacy policy.

**How `routing.*` relates to [privacy levels](#privacy-levels-and-free-models).** Both apply to every job, on both routes.
- **At `standard` and `no-training`**, `routing.allowedProviders` is the batch pin as described above.
- **On the immediate route** (free models in batch chat), a non-empty allow-list is sent with each request as
  `provider.only`, in list order, in the same `provider` object as the privacy fields: for example
  `{ "only": ["azure"], "zdr": true }`. `allow_fallbacks: false` is added when `routing.allowFallbacks` is false.
  A chat thread's own provider pin must be within the list on either route.
- **At `zdr`**, the job is pinned to the model's ZDR endpoints that the allow-list admits, always without fallbacks.
  - An entry admits a ZDR endpoint tag equal to it, or one whose base provider it names (`azure` admits `azure/eu`).
  - `routing.allowFallbacks` is ignored at this level.
  - If no ZDR endpoint is left, the job is refused: `Privacy level zdr: no ZDR provider for <model> within routing.allowedProviders (…)`.
- **The account requirements can be met by the level:**
  - `routing.requireZdr` is met by `routing.accountZdrEnforced`, or by an effective level of `zdr` (the job is pinned to ZDR endpoints).
  - `routing.requireNoDataCollection` is met by `routing.accountDataCollectionDenied`, or by `no-training` or `zdr`.
    On the batch route, `no-training` already needs the no-training attestation.
  - On the immediate route (free models in batch chat), `no-training` and `zdr` send `data_collection: "deny"` / `zdr: true` per request.
  - Planning checks this with the project level. Job creation checks it again with the effective level, including a
    chat thread's own level or a synthesis' source level.
  - `/batch submit` re-checks a saved preview against the current `routing.*`. A requirement that is no longer met,
    or a stored pin outside the current allow-list, is refused, and the job stays previewed.
- `/batch privacy`, the web privacy panel and the model pickers show the routing policy. At `zdr`, previews show the
  pin as "pinned to ZDR endpoints when the job is created".

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
    result/items/001/   raw.json  result.json  result.md  output.json             (per item; output.json = parsed JSON)
    request/  workflow.yaml  workflow.json  dataset.json        (dataset jobs: definition copy, resolved definition + hashes, provenance)
    exports/                                                     (only from an explicit /batch export)
  artifacts/A-20261019-E1ZF/  manifest.json  events.jsonl  source.md  template.yaml  [rendered.<ext> only without --out]
```

- `submitted-request.json` contains the **exact bytes** POSTed to OpenRouter. `request.sha256` is the hash of those bytes.
- Each item's `request.sha256` hashes its canonical request body (`custom_id` excluded), so a retried item can be shown to carry the identical request.
- Item folders are named by **submission ordinal**, not `custom_id`: Release 1 IDs could contain `:`, which is not a valid Windows file name character. `raw.json` is the provider's entry for that item, extracted from `final-response.json`.
- **Manifest schema 3.** Dataset workflow jobs, and retries of them, are written as `schemaVersion: 3`. They
  add the workflow and dataset identity (`workflow.origin: "project"`, definition and resolved hashes, dataset
  type, path, hash and counts, selection, plan hash), row sources and input hashes on items, and `exports[]`.
  Every other new job is still `schemaVersion: 2`. A Release 2 build therefore reports dataset jobs as unreadable
  instead of retrieving them without schema validation.
- **Manifest schema 2.** Release 2 jobs are `schemaVersion: 2`. They add `kind` (`goal`/`workflow`/`synthesis`), `items[]` (source, status, validation, error, usage, `replaces`), `workflow` and `synthesis`. Release 1 manifests (`schemaVersion: 1`) are read as-is and shown as one-item jobs; they are never upgraded in place. Their stored `custom_id`s are always matched verbatim, never regenerated.
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
  - A lock left by a process that died is taken over once it is older than 2 minutes. Until then the background poller skips that job and `/batch check <id>` reports it as busy.
  - Takeovers are serialised, and the lock is re-read before removal, so two processes that both find the same stale lock cannot both end up holding it.
  - The owner's process ID is deliberately not checked. The same workspace can be reached from different process-ID spaces (WSL and Windows, containers, synced or network folders), where a live owner can look dead. The age timeout is the only takeover rule.
- **Provider status is authoritative.** A job stays `polling` while OpenRouter reports `in_progress`. In live testing, OpenRouter kept reporting `in_progress` for a while after the `finalized_at` time it already recorded for the batch, and the results became retrievable only once the status changed to `completed`. Polling more often does not shorten that, and a recorded finish time on its own does not mean the results can be retrieved yet. The delay varied between runs, so no particular duration should be expected.

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
  "workflows": { "maxRequestsPerBatch": 100, "maxCharactersPerItem": 500000, "maxTotalCharacters": 5000000, "maxSynthesisCharacters": 1000000, "maxRowsPerRun": 1000, "maxDatasetBytes": 20000000 },
  "privacy": { "level": "standard", "accountNoTraining": false, "deleteRemoteBatches": true, "noticeShown": false },
  "routing": { "allowedProviders": [], "allowFallbacks": true, "requireZdr": false, "accountZdrEnforced": false, "requireNoDataCollection": false, "accountDataCollectionDenied": false }
}
```

These are application defaults (local policy), not OpenRouter limits. OpenRouter documents a 200 MB batch
payload limit and no maximum request count. Setting `excludePatterns` replaces the whole list. The
`workflows` section is optional; Release 1 configuration files keep working unchanged. For dataset workflows,
`maxRowsPerRun` caps the selected rows (each row is one request) and `maxDatasetBytes` the dataset file size.
A workflow's own `limits` can only lower these. The `routing` section is described in
[Provider routing and account privacy](#provider-routing-and-account-privacy); with its defaults nothing changes.

The `privacy` section is described in [Privacy levels and free models](#privacy-levels-and-free-models). `/batch privacy attest` also writes `privacy.attestedAt` (an ISO time) next to `accountNoTraining`.

## LLM tools

All tools call the same `BatchService` as the slash commands, so they get the same path, exclusion, secret, limit and duplicate checks.

- `batch_submit_goal` (`prompt`, optional `files`, `model`, `provider` (account alias)) submits a single deferred goal.
- `batch_plan_files` (`prompt`, `files`, optional `model`, `group_size`) builds and saves a map-files plan. It **never submits** and incurs no cost.
- `batch_submit_plan` (`batch_id`) submits a saved plan. It is described to the model as **cost-bearing**, to be used only after the user agrees.
- `batch_get_items` (`batch_id`) is a read-only item inventory.
- `batch_list_workflows` and `batch_validate_workflow` (`name` or `file`) are read-only.
- `batch_plan_dataset` (`workflow`, `input`, optional `ids`, `from_row`, `to_row`, `model`) saves a dataset plan
  as a preview. It runs every check of `/batch run` and **never submits**.
- There is deliberately no export tool. Writing export files is an explicit user command.
- `artifact_list` and `artifact_show` are read-only.
- `artifact_plan_render` (`source`, `format`, optional `out`) runs every check of `/artifact render` and renders
  in memory, but **writes nothing**. It tells the user the command to run.
- There is no artifact-writing tool.
- `batch_check_jobs` (optional `batch_id`) reconciles, then reports from local state.

## Known limitations

- **Cancellation.** OpenRouter documents a `cancelling`/`cancelled` status but **no cancel endpoint** (checked 2026-10-16). `/batch cancel` records the request, tries the OpenAI-compatible `POST /batches/{id}/cancel`, and reports "unsupported" on 404/405. The batch may still complete and be billed; the job then ends `ready`, never falsely `cancelled`.
- **No model-generated summaries.** `--summary` injects a marked excerpt.
- **Legacy jobs are inventoried, not imported.** `/batch import-legacy <jobs.json> --preview` is a read-only report on a pre-Release-1 `jobs.json`. It never writes that file and makes no network call. It shows each record's provider batch ID, status, item counts and problems, and flags duplicate IDs and jobs this project already tracks. It shows no titles, prompts, responses or paths.
  - **Timestamps** are resolved per value. The legacy writer stored `createdAt` in milliseconds and `finalizedAt` in Unix seconds, and the two plausible ranges do not overlap. Anything else stays **UNRESOLVED**.
  - **Import itself is deferred** because the legacy file is global and does not record which project a job belonged to. It also holds no raw provider responses or submitted requests, so records could only become unverifiable history (`legacy-unresolved`), never ready jobs.
- **Scope.** `/batch ask` is one batch with one request. `/batch run map-files` is one batch with one request per file or group. `/batch run <workflow>` is one batch with one request per dataset row. All support only `/v1/chat/completions` and text (no images or URLs). One batch uses one model. Dataset workflows are one prompt per row: no multi-step pipelines, no conditionals, no expressions.
- **Artifacts:**
  - **DOCX is not produced.** It was deferred because the candidate library (`docx`) is about 9 MB, ships `@types/node` 26 as a *runtime* dependency, uses an older `jszip`/`readable-stream` 2 stack, and released six versions in three weeks. HTML and PDF cover the deliverables.
  - **PDF output** uses the non-embedded standard fonts: Windows-1252 text only, with replacements reported.
    There are no images, no clickable links and a simple layout.
  - **Local sources** for `/artifact render` must be Markdown, and templates are not applied to them.
  - **HTML** is only ever rendered from Markdown; raw model HTML is never passed through.
- **Dataset field names** must match `[A-Za-z_][A-Za-z0-9_-]{0,63}`. CSV columns with other names (for example containing spaces) cannot be referenced.
- **JSON Schema** support is draft-07 through Ajv in strict mode. `format` keywords are rejected as unknown, because no format plugin is loaded. Patterns run with JavaScript's regular expression engine, and workflow schemas are trusted local configuration.
- **Model eligibility is decided by OpenRouter.** A model having a normal endpoint does not mean it has a `:batch` endpoint. The extension does not claim eligibility; it preserves the provider's 400/404/422 response and never switches models on its own.
- **Item-level usage** appears only when the upstream provider includes it per item. Otherwise only batch totals are shown.
- **Batch chat reads.** Chat threads are plain files in `.pi/batches/threads/`. They are never put in the live model's context, but the live model's own file tools can read that folder if it is asked to.
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

### Scripting Pi in RPC mode

When we drove Pi from a test script with `pi --mode rpc`, the Pi process exited as soon
as the script closed its standard input, even while a command it had started (for example
a submit or a background poll) was still waiting on the network. The interrupted submit was
then recovered as `submission_unknown`, as designed. Interactive Pi sessions did not show
this. If you script Pi in RPC mode, keep its input open until each command's RPC `response`
has arrived, and a little longer if Pi's own background poller may still be working.

`scripts/pi-rpc.mjs` does this for you. It loads this extension into a real Pi with tools, MCP, skills and
sessions disabled, and sends the given commands:

```
node scripts/pi-rpc.mjs <workspace> "/batch metadata plan --context ctx.md --input tables.jsonl --preview" "/batch list"
```

It only ever sends `/batch` and `/artifact` commands, because any other text reaches Pi's chat model as an
ordinary prompt and may be billed:
- an argument that is not such a command is refused before Pi starts (exit 2);
- if Pi starts an agent turn anyway, the script kills Pi at once (exit 3).

Git Bash rewrites a leading `/batch` into a Windows path (`C:/Program Files/Git/batch …`), which is exactly
that case. Run the script from PowerShell, or set `MSYS_NO_PATHCONV=1` in Git Bash. `PI_LINGER_MS` (default
15000) sets how long to wait after the last command, and `PI_MAX` (default 2500) the characters printed per
message. Commands that reach OpenRouter (`submit`, `check`) are real, paid calls unless the network is blocked.
