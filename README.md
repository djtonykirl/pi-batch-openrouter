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
  "workflows": { "maxRequestsPerBatch": 100, "maxCharactersPerItem": 500000, "maxTotalCharacters": 5000000, "maxSynthesisCharacters": 1000000, "maxRowsPerRun": 1000, "maxDatasetBytes": 20000000 }
}
```

These are application defaults (local policy), not OpenRouter limits. OpenRouter documents a 200 MB batch
payload limit and no maximum request count. Setting `excludePatterns` replaces the whole list. The
`workflows` section is optional; Release 1 configuration files keep working unchanged. For dataset workflows,
`maxRowsPerRun` caps the selected rows (each row is one request) and `maxDatasetBytes` the dataset file size.
A workflow's own `limits` can only lower these.

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
- `batch_check_jobs` (optional `batch_id`) reconciles, then reports from local state.

## Known limitations

- **Cancellation.** OpenRouter documents a `cancelling`/`cancelled` status but **no cancel endpoint** (checked 2026-10-16). `/batch cancel` records the request, tries the OpenAI-compatible `POST /batches/{id}/cancel`, and reports "unsupported" on 404/405. The batch may still complete and be billed; the job then ends `ready`, never falsely `cancelled`.
- **No model-generated summaries.** `--summary` injects a marked excerpt.
- **Legacy jobs are inventoried, not imported.** `/batch import-legacy <jobs.json> --preview` is a read-only report on a pre-Release-1 `jobs.json`. It never writes that file and makes no network call. It shows each record's provider batch ID, status, item counts and problems, and flags duplicate IDs and jobs this project already tracks. It shows no titles, prompts, responses or paths.
  - **Timestamps** are resolved per value. The legacy writer stored `createdAt` in milliseconds and `finalizedAt` in Unix seconds, and the two plausible ranges do not overlap. Anything else stays **UNRESOLVED**.
  - **Import itself is deferred** because the legacy file is global and does not record which project a job belonged to. It also holds no raw provider responses or submitted requests, so records could only become unverifiable history (`legacy-unresolved`), never ready jobs.
- **Scope.** `/batch ask` is one batch with one request. `/batch run map-files` is one batch with one request per file or group. `/batch run <workflow>` is one batch with one request per dataset row. All support only `/v1/chat/completions` and text (no images or URLs). One batch uses one model. Dataset workflows are one prompt per row: no multi-step pipelines, no conditionals, no expressions.
- **Dataset field names** must match `[A-Za-z_][A-Za-z0-9_-]{0,63}`. CSV columns with other names (for example containing spaces) cannot be referenced.
- **JSON Schema** support is draft-07 through Ajv in strict mode. `format` keywords are rejected as unknown, because no format plugin is loaded. Patterns run with JavaScript's regular expression engine, and workflow schemas are trusted local configuration.
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

### Scripting Pi in RPC mode

When we drove Pi from a test script with `pi --mode rpc`, the Pi process exited as soon
as the script closed its standard input, even while a command it had started (for example
a submit or a background poll) was still waiting on the network. The interrupted submit was
then recovered as `submission_unknown`, as designed. Interactive Pi sessions did not show
this. If you script Pi in RPC mode, keep its input open until each command's RPC `response`
has arrived, and a little longer if Pi's own background poller may still be working.
