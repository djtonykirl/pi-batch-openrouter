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
| `/batch submit <id>` | Submit a job created with `--preview`. |
| `/batch list [--status active\|done\|ready\|failed\|…\|all] [--limit n]` | List jobs from **local** state (no network). |
| `/batch show <id>` | Local status vs provider status, timings, usage/cost (only if reported), errors, artefact path, recent events. |
| `/batch read <id> [--full\|--raw]` | Read the locally retrieved result. `--full` adds per-item status, usage and warnings; `--raw` shows the preserved provider response. |
| `/batch inject <id> [--summary\|--full]` | Add the result to **this conversation's** model context. |
| `/batch check [id]` | Reconcile with OpenRouter now. |
| `/batch cancel <id>` | Request cancellation; history is kept (see limitations). |
| `/batch retry <id> [--model <slug>]` | New job, linked via `parentJobId`, from the exact original request. |
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
    provider/ submission-response.json  latest-status.json  final-response.json   (raw provider bytes)
    result/   result.md  result.json  metadata.json                                 (normalised)
```

- `submitted-request.json` contains the **exact bytes** POSTed to OpenRouter. `request.sha256` is the hash of those bytes.
- Raw provider responses are preserved first and never overwritten. A second retrieval writes `final-response.2.json`.
- All writes go through a temporary file, `fsync`, then rename, so a crash cannot leave a valid-looking partial file.
- There are three distinct identifiers:
  - local ID: `B-YYYYMMDD-XXXX`, allocated by exclusive `mkdir`
  - OpenRouter batch ID: `batch_…`
  - request `custom_id`: `<local ID>:request-001`
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
  - A job left in `retrieving` is retrieved again.
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
  "submission": { "showPreview": true, "requireConfirmation": false }
}
```

These are application defaults, not OpenRouter limits. Setting `excludePatterns` replaces the whole list.

## LLM tools

- `batch_submit_goal` (`prompt`, optional `files`, `model`, `provider` (account alias)) goes through the same exclusion, secret and duplicate checks as `/batch ask`.
- `batch_check_jobs` (optional `batch_id`) reconciles, then reports from local state.

## Known limitations

- **Cancellation.** OpenRouter documents a `cancelling`/`cancelled` status but **no cancel endpoint** (checked 2026-10-16). `/batch cancel` records the request, tries the OpenAI-compatible `POST /batches/{id}/cancel`, and reports "unsupported" on 404/405. The batch may still complete and be billed; the job then ends `ready`, never falsely `cancelled`.
- **No model-generated summaries.** `--summary` injects a marked excerpt.
- **Legacy jobs are not imported.** Jobs recorded by earlier versions in `~/.pi/agent/pi-batch-openrouter/jobs.json` are not shown.
- **Release 1 scope.** One goal is one batch with one request. Only `/v1/chat/completions` is supported, with text files only (no images or URLs).
- **Print mode.** In `pi -p`, Pi has no UI, so command output (`notify`) is not displayed. The state on disk is still correct.

## Development

```
npm install
npm run check   # type-check source and tests
npm test        # compiles to .test-build/ and runs node:test
```

The tests use a scripted fake OpenRouter (`test/lifecycle.test.ts`). No network access or API key is needed.
