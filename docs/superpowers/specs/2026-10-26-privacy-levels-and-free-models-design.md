# Privacy levels and free models: design

Status: draft for review · 2026-10-26 · builds on `2026-10-26-batch-chat-design.md` (branch `batch-chat`, PR #1)

## Intent

Let the user choose **how private** each conversation and job is, with "free" treated only as a price label, not as the selling point. Three privacy levels map directly onto OpenRouter's own controls:

| Level | Meaning | OpenRouter control |
|---|---|---|
| `standard` | The provider may store your data and may train on it (OpenRouter's default) | none (`provider.data_collection: "allow"` is the default) |
| `no-training` | Only providers that don't collect your data | `provider.data_collection: "deny"` |
| `zdr` | Only providers with a zero-data-retention policy | `provider.zdr: true` |

The user also gets **free models** (`:free` IDs and zero-priced endpoints) inside batch-chat threads, sent through a new **immediate route** (a normal chat completion) because free models are not batch models. The privacy level filters free models exactly as it filters every other model, so "free" can never quietly lower privacy.

The guiding principle: **the extension may only make privacy stricter than the account, never looser, and it never claims a guarantee it can't enforce.**

## Facts this design rests on (OpenRouter docs, checked 2026-10-26)

- **ZDR** ([features/zdr](https://openrouter.ai/docs/guides/features/zdr)):
  - `provider.zdr: true` restricts routing to ZDR endpoints. It is ORed with the account and guardrail settings, so a request-level `false` can't override them.
  - `GET /api/v1/endpoints/zdr` lists ZDR endpoints and updates automatically.
  - Endpoints with an unclear policy are treated as retaining and training.
- **Provider logging** ([privacy/provider-logging](https://openrouter.ai/docs/guides/privacy/provider-logging)):
  - Providers are classified by training and retention policy, shown as structured data on each endpoint.
  - The account has separate training settings for paid and free models.
  - Region-locked routing (`eu.openrouter.ai` / `us.openrouter.ai`) is available on Business and Enterprise plans.
- **Data collection** ([privacy/data-collection](https://openrouter.ai/docs/guides/privacy/data-collection)):
  - OpenRouter does not store prompts or responses by default. It keeps metadata only.
  - Two opt-in account settings change this: "Private Input & Output Logging" and "OpenRouter Use of Inputs/Outputs" (a 1% discount).
  - A small anonymous sample of inputs is categorised by a ZDR model.
- **Provider selection** ([routing/provider-selection](https://openrouter.ai/docs/guides/routing/provider-selection)): `provider.data_collection: "allow" | "deny"` (default `allow`). The `provider` object also accepts `zdr`, `only`, `ignore`, `order`, `allow_fallbacks`, `require_parameters`, `quantizations`, `sort`, `max_price` and more.
- **Batch** ([batch quickstart](https://openrouter.ai/docs/batch-quickstart)):
  - `provider` accepts only `only` and `allow_fallbacks`. `order`, `sort` and "other sync preferences" return 400.
  - `data_collection` and `zdr` aren't mentioned, so this design assumes they are rejected.
  - Your account's data policy applies when choosing a batch provider.
  - OpenRouter deletes batch requests and results 30 days after submission. A finished batch can be deleted earlier, which also deletes provider-side files for most providers. Anthropic and Sail Research keep none.
  - Batch-eligible models are listed at `openrouter.ai/models?variant=batch`. No listing API is documented.
- **Endpoints API** (`GET /api/v1/models/{author}/{slug}/endpoints`):
  - Exposes `pricing` (with `"0"` values) and `tag`/`provider_name`.
  - No per-endpoint training or retention field is documented.
  - So **the ZDR list is the only machine-readable policy source**. "No training" can be enforced per request on the immediate route, but cannot be verified per endpoint.

## Goals

1. A **privacy level** per project (`privacy.level`, default `standard`), which a thread can raise but never lower.
2. **Every request the extension sends** honours the level. This covers chat turns, compaction, titles, `/batch ask`, map-files, dataset and metadata workflows, synthesis and retries, on both the batch and immediate routes.
3. **Free models** are available in batch-chat threads through the immediate route, subject to the level.
4. **A model picker that labels each model** `batch`, `free`, `ZDR`, and shows `no-training` where it can be known. At a strict level it shows only models that can satisfy that level. The picker is in both Pi and the web UI.
4a. **A fresh model catalog every session** (the model list, prices, free status and the ZDR list), so the labels and enforcement reflect OpenRouter as it is now.
4b. **The web UI does everything the commands do:** project level, attestation, thread level, labelled picker and per-job privacy status. All enforcement happens on the server.
5. **Honest status:** the footer and `/batch chat context` show the effective level. A one-time notice points to the account settings that only the user can control.
6. **Shorter OpenRouter-side retention for batch:** at `no-training` and `zdr`, finished batches are deleted at OpenRouter once their results are saved locally.

## Non-goals (v1)

- Free or immediate-route requests for `/batch ask` and multi-request workflows. These need a rate-paced queue: a later project.
- Reading or changing the user's OpenRouter account privacy settings. No API is documented, so the extension can only point to them.
- Region-locked routing (`eu.`/`us.openrouter.ai`). It's a Business/Enterprise feature; a `baseUrl` setting is a cheap later addition.
- Encrypting the local thread or job files under `.pi/batches/`. Privacy levels cover OpenRouter and providers, not the user's disk.
- Server tools and plugins (web search and similar), which have their own policies. The extension doesn't use them.

## Anti-goals

- **A label that overstates privacy.** For example, showing 🔒 ZDR on a batch job whose provider wasn't pinned to a ZDR endpoint, or implying OpenRouter never holds batch data.
- **Silently falling back to a less private route or provider** when nothing satisfies the level. Refuse instead, and say why.
- **A free model being chosen** that lowers the thread's privacy level without an explicit user action.
- **Losing local results** because a remote batch was deleted before the raw response was saved.

## Constraints

- All the batch-chat guarantees still hold: isolation from the live model, an append-only transcript, the secret scan before saving or sending, one turn in flight per thread, and the conversation-order ruling.
- Existing `standard`-level request bytes stay byte-identical, because duplicate detection hashes them.
- Batch request bodies may carry only `provider.only` and `provider.allow_fallbacks`. The privacy code must never add `data_collection` or `zdr` to a batch body (see "Probe" below).
- The immediate route reuses the job model: each turn is still a job manifest (`kind: "chat"`) that goes through the same reconcile and settle path. ChatService stays unaware of which route a turn took.

## How it behaves

### The privacy level

- **Config:** `privacy.level: "standard" | "no-training" | "zdr"`, set per project (and globally via the existing cascade).
- **Commands:** `/batch privacy [level]` shows or sets the level, following the existing `/batch model` / `--global` conventions. `/batch chat privacy <level>` raises it for the current thread.
- **Threads:**
  - A thread stores `privacyLevel`. The effective level is the stricter of the thread's and the project's.
  - Lowering a thread below the project level is refused, with "lower the project level first".
  - Raising a thread's level appends a `status` entry to its transcript.
- **Jobs:** every job manifest records the effective level and how it was enforced, under `privacy: { level, route, enforcement }`. `/batch show` displays it.

### Enforcement by route

| Level | Immediate route (chat completions) | Batch route |
|---|---|---|
| `standard` | nothing added | nothing added (bytes unchanged) |
| `no-training` | `provider.data_collection: "deny"` | Cannot be expressed per request. Allowed only when the user has **attested** that their account disables training for the relevant model group (`privacy.accountNoTraining: true`, set by `/batch privacy attest`). Otherwise batch models are refused at this level, with a pointer to openrouter.ai/settings/privacy. |
| `zdr` | `provider.zdr: true` | `provider.only` = the providers whose endpoint for this model is in the ZDR list, plus `allow_fallbacks: false`. If there are none, the model is refused at this level. |

- **Delete after retrieval:** at `no-training` and `zdr`, a finished batch is deleted at OpenRouter once its raw final response has been saved locally.
  - The raw response is already saved once and never overwritten (`finalResponseFile`), so nothing local is lost.
  - Failures are logged and retried on later ticks. They never affect the job's local status.
  - Config: `privacy.deleteRemoteBatches` (default `true` at those levels; ignored at `standard` unless set).
- **ZDR list:** fetched from `GET /api/v1/endpoints/zdr` as part of the session model catalog (see "Model catalog" below). Batch requests at `zdr` are pinned from the catalog's current ZDR list. They never go out unpinned.
- **Provider names:** the builder must confirm which ZDR-list field matches the slugs that `provider.only` accepts (see "Left to the builder").

### Probe (one-off, run by the user)

- `scripts/privacy-probe.mjs` submits one minimal batch (a single 1-token request to a cheap batch model) that carries `provider.data_collection` and then `provider.zdr`. It reports whether each is accepted or rejected with a 400.
- It's guarded like `scripts/pi-rpc.mjs`: explicit confirmation, a printed cost note, and no Pi involved.
- If OpenRouter turns out to accept either field on batch, a follow-up switches the batch route to send it *in addition to* pinning. The design doesn't depend on the result.

### Free models and the immediate route

- **Routing rule:** the route is decided by the model ID.
  - A `:free` suffix, or a model with no batch variant chosen from the picker's free section, uses the immediate route.
  - Everything else uses batch, as today.
  - The thread stores `route` alongside `model`.
- **Immediate turn:** the extension still creates the chat job manifest first, so claiming, adopting and settling stay identical. It then calls `POST /api/v1/chat/completions` (no streaming), saves the response in the same normalised form batch results use, and marks the job finished through the existing retrieval path.
  - To ChatService, the turn simply settled quickly.
  - A title item on the immediate route is a second call made after the reply. Its failure never affects the turn.
- **Rate limits:** a 429 does not fail the turn.
  - The job stays in flight with `nextPollAt` set from `Retry-After` (or a backoff), and the poller retries it.
  - A 429 that is clearly a daily limit (per its message, or repeated failures past a ceiling) fails the turn. The error says "free-model daily limit reached; try later or switch model", and the user's messages stay queued.
- **Cost display:** immediate-route usage is reported as usual. Free models show "free" in the footer and in `/batch chat cost`.
- **Compaction:** follows the thread's route and level.

### Model catalog: fresh every session

Model availability, prices and ZDR status change often, so the catalog is **loaded fresh at the start of every session**, never carried over silently from an earlier one.

- **What the catalog holds:**
  - the model list from `GET /api/v1/models` (IDs, pricing, so free is pricing all zero or a `:free` suffix, and context length);
  - the ZDR endpoint list from `GET /api/v1/endpoints/zdr`;
  - the batch models discovered as today.
- **When it loads:**
  - on every Pi `session_start`;
  - on web server start, including standalone `npm run web`;
  - on a web workspace switch;
  - on demand with `/batch privacy refresh`, `/batch chat model --refresh` or the web UI's "Refresh models" button.
- **Non-blocking:** loading runs in the background and never delays session start or typing.
  - Until it finishes, the picker shows "loading models…".
  - A send that needs the catalog (any `zdr` batch request, or a free-model route decision) waits for the current load, up to the request timeout.
- **If the fresh load fails:**
  - The last successful catalog, stored on disk with its timestamp, is used for *display*, labelled "model list from <time>, refresh failed".
  - **For enforcement at `zdr`, a catalog older than the current session is not trusted:** `zdr` batch requests are refused until a refresh succeeds, with a message saying so. The fail-safe direction is to refuse, never to send unpinned.
  - `standard` and `no-training` are unaffected, because they don't depend on the ZDR list.
- **One catalog per project** is shared by the Pi session and the web server, via the runtime. It is never fetched twice concurrently.

### The model picker (`/batch chat model`, web UI)

- **Sources:** the session's model catalog (above): batch models, free models and the ZDR list.
- **Labels:** `[batch]`, `[free]`, `[ZDR]`. At `no-training` a batch model is shown as allowed only when the user has attested (see above).
- **Filtering by level:**
  - At `zdr`, only models with at least one ZDR endpoint are offered.
  - At `no-training`, immediate-route models are always offered; the request carries `deny`. If no provider qualifies, OpenRouter returns a "no endpoints" error, which is shown as "no provider for this model meets no-training".
  - Batch models are offered only with the attestation.
- **Typed slugs** go through the same check, and refusals explain which level blocked them.

### Status and notices

- **Footer:** 🔒 `zdr` / `no-train` / nothing for `standard`, plus `· free` on free models.
- **One-time notice per project** when the level is first raised above `standard`. It says that OpenRouter's own logging and "use of inputs/outputs" account settings, and the training settings for free and paid models, are controlled at openrouter.ai/settings/privacy, and that the extension cannot check them. It is recorded so it isn't shown again.
- **Batch honesty line in `/batch chat context` and `/batch show`:** "Batch jobs are held at OpenRouter until finished; deleted after retrieval" (when deletion is on) or "kept up to 30 days" (when off).

### Web UI (`/batch web`, `npm run web`)

The web UI gets the same capabilities as the commands, and **all enforcement lives on the server**. The browser only displays and requests; the server never trusts a level, route or model the page sends without re-checking it.

- **Project privacy level:**
  - A level selector (`standard` / `no-training` / `zdr`) in the workspace settings area shows the current level and where it comes from (project or global).
  - Changing it calls a new authenticated endpoint that applies the same rules as `/batch privacy`.
  - The first raise above `standard` shows the one-time account-settings notice, with a link to openrouter.ai/settings/privacy.
- **The no-training confirmation for batch:**
  - A checkbox-and-confirm control next to the level: "My OpenRouter account disables training for these model groups".
  - It is recorded through the same setting `/batch privacy attest` writes, with the time and a short note that the extension cannot verify it.
- **Thread privacy:**
  - The chat header shows the thread's effective level as a 🔒 `zdr` / `no-train` badge, plus `free` for free models.
  - A control raises the thread's level. Lowering below the project level is disabled, with a tooltip saying why.
- **Model picker:**
  - The same filtered, labelled list as the command: `[batch]` `[free]` `[ZDR]`.
  - Sections for "Batch (cheaper, slower)" and "Immediate (free)".
  - It shows "loading models…" or "model list from <time>, refresh failed" from the catalog state, and has a "Refresh models" button.
  - Models blocked by the level are hidden. With a "Show blocked" toggle they are listed but disabled, with the reason ("no ZDR provider for this model").
- **Refusals and failures:** server refusals appear inline in the chat or job view with their full reason, as chat status lines do in Pi. These cover level checks, the catalog being unavailable, the daily-limit 429 and the 429 back-off notice.
- **Jobs view:**
  - Each job shows its `privacy.level`, `route` and enforcement, such as "pinned to ZDR providers: …" or "no-training: account attested".
  - It shows the remote-deletion state: "deleted at OpenRouter <time>" / "deletion pending" / "kept up to 30 days".
- **Server API:**
  - New endpoints for level get and set, attestation, thread level raise, catalog state and catalog refresh.
  - They use the existing session-cookie authentication, Host and Origin checks and CSRF protection.
  - Model and route choices posted by the page are validated against the catalog and level on the server before any job is created.
- **Standalone mode** (`npm run web`) uses the same catalog and privacy code. Its account-key rules stay as fixed in PR #1, so the requested account's key is used and nothing else.

## Interaction with existing code (shape, not code)

- **`ProviderPin` / `buildSubmitBody`:**
  - Batch gains computed `only` + `allow_fallbacks` from the privacy layer. A user's explicit `--provider` pin must also pass the level check, or it is refused.
  - The immediate route builds its own body with `data_collection`/`zdr`.
- **`OpenRouterBatchClient`:**
  - Gains `deleteBatch(id)`. The builder confirms the exact path, likely `DELETE /api/v1/batches/{id}`.
  - Gains `listZdrEndpoints()`.
  - A small `OpenRouterChatClient` (or an extra method) handles chat completions and models listing, reusing timeouts, key resolution and log redaction.
- **Settle path:** immediate-route jobs reuse `finishRetrieval` with a synthetic one-item result, so `jobItems`/`itemText` and ChatService are untouched.
- **Manifest:** add `privacy` and `route` fields to chat and other jobs. Writing them does not need a schema bump if older builds ignore unknown fields. The builder confirms; otherwise follow the v4 precedent.

## Testing expectations

- **Per level and route:**
  - The exact body produced at `standard` is byte-identical to today's (snapshot test).
  - At `no-training` and `zdr`, immediate bodies carry the right field.
  - At `zdr`, batch bodies are pinned from the ZDR list.
  - A refusal occurs when no ZDR provider exists, when the ZDR list is unavailable, and when `no-training` is set on batch without the attestation.
- **Delete after retrieval:** it happens only after the raw response is saved; a delete failure is retried and never changes local status.
- **Immediate route:**
  - A turn settles through the normal path.
  - A 429 with `Retry-After` reschedules without a failure entry; a daily-limit 429 fails with queued messages kept.
  - A failed title call doesn't fail the turn.
- **Thread level:** a thread can raise its level but not lower it below the project's; the effective level shows in the footer.
- **Picker:** it filters and labels for each level.
- **Catalog:**
  - It loads on session start and on web server start, without blocking either.
  - Concurrent loads are deduplicated.
  - When a load fails, the display falls back to the last catalog with its timestamp, and `zdr` batch sends are refused until a refresh succeeds.
  - A manual refresh replaces the catalog.
- **Web server:**
  - Each new endpoint enforces authentication, Host/Origin and CSRF checks.
  - A model or route posted by the page that the level forbids is refused on the server even if the UI allowed it.
  - The thread level can't be lowered through the API.
- **Isolation:** no `sendMessage` under `src/chat/`, `src/web/` or the new privacy code.

## Left to the builder

- Module layout (suggested `src/privacy/` and `src/models/catalog.ts`), and the on-disk format of the last-known catalog.
- How a ZDR-list entry maps to a `provider.only` slug (`tag` vs a provider slug field), confirmed against a live response.
- The exact delete-batch endpoint and response handling.
- How to tell a free-model daily-limit 429 from a per-minute one, using the response body or headers.
- Wording of notices and refusals, and the web UI placement of the level selector and labels.
