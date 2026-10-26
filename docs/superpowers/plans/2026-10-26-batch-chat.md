# Batch Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Claude Code–style named, persistent chat threads with OpenRouter batch models to the Pi extension, displayed in the Pi session but isolated from the live model.

**Architecture:** A thread is a directory under `<storage>/threads/<T-id>/`, holding a locked `thread.json` snapshot and an append-only `transcript.jsonl`. Every chat turn or compaction is an ordinary batch job created by a new `BatchService.createChatJob`, with a `chat` linkage on the manifest (schema v4). `ChatService` (no Pi dependency) owns sending, settling, queueing, compaction and retitling. `ChatSession` (per Pi session) owns chat mode, the input interception, display via `pi.appendEntry`, and the footer. The runtime routes settled chat jobs to `ChatService` and calls `ChatService.tick()` + `ChatSession.sync()` on every poller tick, which is the cross-process and restart-safe path.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Pi extension API `@earendil-works/pi-coding-agent` 0.86, `node:test` + `node:assert/strict`, existing `FakeOpenRouter` fixture.

**Spec:** `docs/superpowers/specs/2026-10-26-batch-chat-design.md`. Read it before starting. Every "My call" in it is a requirement here.

## Global Constraints

- Chat content is displayed **only** with `pi.appendEntry("pi-batch-chat", …)` + `pi.registerEntryRenderer`. Nothing under `src/chat/` may call `sendMessage` or `sendUserMessage`.
- `transcript.jsonl` is append-only. Nothing ever rewrites or deletes it.
- A message whose secret scan finds something is refused **before** it is written anywhere.
- Chat mode is in-memory per session. It is never persisted and is off when Pi starts.
- The input handler takes only `source` `"interactive"` or `"rpc"`. It passes through `"extension"` input and any text starting with `/` with `{ action: "continue" }`.
- One turn in flight per thread. Messages typed while a reply is pending, or after a failed turn, are appended as user entries and sent later as **one** user message, joined with `"\n\n"`.
- A turn's success depends on the reply item (ordinal 1) alone. A failed title item (ordinal 2) never fails the turn.
- Manifest: chat jobs are `kind: "chat"`, `schemaVersion: 4` (`CHAT_MANIFEST_SCHEMA_VERSION`), with `chat: ChatLinkage`. `objective` is `"Chat turn in <T-id>"` or `"Chat compaction in <T-id>"`, never user text.
- Config defaults: `chat.autoCompact` `true`, `chat.autoCompactTokens` `60000`, `chat.keepRecentExchanges` `4`, `chat.retitleAtTurn` `3`, `chat.systemPrompt` (Task 1).
- Thread IDs: `T-YYYYMMDD-XXXX` (same alphabet as job IDs). Provisional title: the first message with whitespace collapsed, cut to 60 chars. Before the first message the title is `"(untitled)"`.
- Footer: `💬 <title> · <model>`, plus `· waiting` when pending, `· compacting` when compacting, and `· N% until compact` once the estimate is ≥ 80% of `autoCompactTokens`. Single line, title cut to 40 chars.
- Project instructions file: `<workspace>/.pi/BATCH_CHAT.md`. It is appended to the system prompt and secret-scanned on every send. A finding blocks the send.
- Token estimate = `Math.ceil(totalCharacters / 4)` across all message contents.
- Windows: run scripted Pi from PowerShell, never Git Bash (see README).

## Review Focus

1. **Model switched while a reply is pending.** The reply must be labelled with the model the job actually used (`job.model`), not the thread's new model. *Test in Task 5.*
2. **Reply cut off by `max_tokens`** (`finishReason: "length"`). The reply is still appended, and the display marks it `(truncated: max_tokens)` instead of looking complete. *Tests in Tasks 5 and 7.*
3. **Two threads with the same title, or a title that looks like an ID suffix.** `resolve` must report ambiguity rather than pick one. *Test in Task 2.*
4. **Whitespace-only or empty input in chat mode.** It is swallowed (`handled`) and nothing is written or sent. *Test in Task 7.*
5. **Thread lock held by another Pi process when the user types.** The user must get a warning that says the message was *not* saved and to retype it. It must never be silently dropped. *Test in Task 5.*

---

## File Structure

| File | Responsibility |
|---|---|
| `src/chat/types.ts` (new) | `ThreadState`, `TranscriptEntry`, `TranscriptEntryInput` |
| `src/chat/store.ts` (new) | `ThreadStore`: thread files, locking, seq allocation, resolve |
| `src/chat/request.ts` (new) | Pure builders: turn/compaction/title messages, boundary, estimate, titles |
| `src/chat/service.ts` (new) | `ChatService`: send, settle, queue, retry, model, rename, compaction, tick |
| `src/chat/session.ts` (new) | `ChatSession`: chat mode, input handling, entry display, footer, notifications |
| `src/chat/render.ts` (new) | Entry renderer for `pi-batch-chat` |
| `src/chat/commands.ts` (new) | `/batch chat …` subcommands and their text formatters |
| `src/ids.ts`, `src/config.ts`, `src/types.ts`, `src/registry.ts` | Thread IDs, `chat.*` config, `ChatLinkage` + schema v4 |
| `src/service.ts` | `createChatJob`, public `knownSecrets`, chat-job guards |
| `src/runtime.ts`, `src/poller.ts`, `index.ts` | Wiring: settle routing, tick hook, input/entry registration |
| `src/commands.ts`, `src/tools.ts`, `src/artifacts/service.ts` | `chat` dispatch, help, exclusion of chat jobs |
| `test/chat-*.test.ts` (new) | One test file per new module |
| `README.md` | "Batch chat" section and command-table rows |

Run one test file with: `npx tsc -p tsconfig.test.json && node --test .test-build/test/<name>.test.js`. Run everything with `npm test`, and type-check with `npm run check`.

---

### Task 1: Foundations: config, thread IDs, chat types, manifest v4

**Files:**
- Modify: `src/config.ts` (interface, `DEFAULT_CONFIG`, `SCHEMA`), `src/ids.ts`, `src/types.ts`, `src/registry.ts:201` (schemaVersion check)
- Create: `src/chat/types.ts`
- Test: `test/chat-foundations.test.ts`

**Interfaces:**
- Produces:
  - `BatchConfig.chat: { autoCompact: boolean; autoCompactTokens: number; keepRecentExchanges: number; retitleAtTurn: number; systemPrompt: string }`
  - `THREAD_ID_PATTERN: RegExp`, `newThreadId(now?: Date): string`, `isThreadId(v: string): boolean` in `src/ids.ts`
  - In `src/types.ts`: `JobKind` gains `"chat"`; `CHAT_MANIFEST_SCHEMA_VERSION = 4`; `ManifestSchemaVersion = 1|2|3|4`; `interface ChatLinkage { threadId: string; purpose: "turn" | "compact"; throughSeq: number; titleItem: boolean }`; `JobManifest.chat?: ChatLinkage`; `isChatJob(job: Pick<JobManifest,"kind">): boolean`
  - In `src/chat/types.ts`:
    ```ts
    export interface ThreadState {
      schemaVersion: 1; id: string; title: string; titleLocked: boolean; retitled: boolean;
      model: string; account: string; providerPin?: ProviderPin;
      createdAt: string; updatedAt: string; nextSeq: number;
      pending?: { throughSeq: number; claimedAt: string; jobId?: string };
      compacting?: { throughSeq: number; claimedAt: string; jobId?: string; instructions?: string };
      lastFailure?: { purpose: "turn" | "compact"; jobId?: string; message: string; at: string };
      summary?: { text: string; throughSeq: number; jobId: string };
    }
    export type TranscriptEntry = { seq: number; at: string } & (
      | { type: "user"; text: string }
      | { type: "assistant"; text: string; model: string; jobId: string; finishReason?: string }
      | { type: "model"; from: string; to: string }
      | { type: "title"; title: string; source: "auto" | "manual" }
      | { type: "compaction"; summary: string; throughSeq: number; jobId: string; model: string; instructions?: string }
      | { type: "failure"; purpose: "turn" | "compact"; jobId?: string; message: string }
      | { type: "status"; text: string }
    );
    export type TranscriptEntryInput = TranscriptEntry extends infer E ? (E extends unknown ? Omit<E, "seq" | "at"> : never) : never;
    ```

- [ ] **Step 1: Write the failing tests** in `test/chat-foundations.test.ts`:
  - `chat config defaults`: `DEFAULT_CONFIG.chat` deep-equals `{ autoCompact: true, autoCompactTokens: 60000, keepRecentExchanges: 4, retitleAtTurn: 3, systemPrompt: <non-empty string> }`.
  - `chat config validation`: `validateConfig({ chat: { autoCompactTokens: -1, keepRecentExchanges: 2 } })` keeps `keepRecentExchanges === 2`, reverts `autoCompactTokens` to `60000`, and reports an error mentioning `autoCompactTokens`.
  - `thread ids`: `newThreadId(new Date("2026-10-26T10:00:00Z"))` matches `/^T-20261026-[0-9A-HJKMNP-TV-Z]{4}$/`; `isThreadId("B-20261026-ABCD") === false`.
  - `registry reads schema v4 manifests`: write a manifest via `registry.create` with `schemaVersion: 4, kind: "chat"`. `registry.read` returns it, and `isChatJob` is true.
- [ ] **Step 2: Run** `npx tsc -p tsconfig.test.json && node --test .test-build/test/chat-foundations.test.js`. Expected: compile errors or FAIL (no `chat` config, no `newThreadId`).
- [ ] **Step 3: Implement.** Config: add `chat` to the interface, `DEFAULT_CONFIG` and `SCHEMA` (`autoCompact: bool`, `autoCompactTokens: posInt()`, `keepRecentExchanges: posInt(100)`, `retitleAtTurn: posInt(1000)`, `systemPrompt: str`). The default `systemPrompt` is `"You are a helpful, knowledgeable assistant in an ongoing conversation. Answer clearly and directly. Use Markdown where it helps."` `newThreadId` mirrors `newLocalJobId` with prefix `T-`. In `registry.read`, accept `schemaVersion === 4`.
- [ ] **Step 4: Run** the same command. Expected: PASS. Then `npm run check`. Expected: no errors.
- [ ] **Step 5: Commit** `feat(chat): add chat config, thread ids and chat job manifest v4`.

---

### Task 2: ThreadStore

**Files:**
- Create: `src/chat/store.ts`
- Test: `test/chat-store.test.ts`

**Interfaces:**
- Consumes: Task 1 types, `atomicWriteJson`, `appendJsonl`, `readJsonl`, `acquireLock` from `src/fsutil.ts`, `newThreadId`, `isThreadId`.
- Produces:
  ```ts
  export class ThreadNotFoundError extends Error { constructor(public readonly input: string) }
  export class ThreadBusyError extends Error {}           // lock not acquired within waitMs
  export class ThreadStore {
    constructor(public readonly root: string)              // <storage>/threads
    create(init: { model: string; account: string; providerPin?: ProviderPin }): ThreadState
    read(id: string): ThreadState
    list(): ThreadState[]                                  // updatedAt desc
    resolve(input: string): string                         // id, unique id suffix (case-insensitive), or exact title (case-insensitive)
    update<T>(id: string, fn: (t: ThreadState, append: (e: TranscriptEntryInput) => TranscriptEntry) => T, waitMs?: number): T
    transcript(id: string): { entries: TranscriptEntry[]; malformedLines: number }
  }
  ```
  `update` takes `threads/<id>/thread.lock` (default `waitMs` 3000; throws `ThreadBusyError` on timeout). It reads fresh, runs `fn`, appends each entry to `transcript.jsonl` with `seq = nextSeq++` and `at = nowIso()`, sets `updatedAt`, and writes `thread.json` atomically. Entries are appended before the snapshot is written.

- [ ] **Step 1: Write the failing tests:**
  - `create then read round-trips`: `title === "(untitled)"`, `titleLocked === false`, `nextSeq === 1`, `isThreadId(id)`.
  - `update allocates sequential seqs and never rewrites`: two `update` calls appending a `user` then an `assistant` entry give `seq` 1 and 2. The `transcript.jsonl` byte content after call 1 is a prefix of its content after call 2.
  - `list orders by updatedAt desc`.
  - `resolve`: full ID; a unique 4-char suffix in lower case; an exact title in different case. A **duplicate title across two threads throws an error containing "ambiguous"**. A title equal to another thread's ID suffix also throws "ambiguous" (Review Focus 3). An unknown input throws `ThreadNotFoundError`.
  - `update throws ThreadBusyError while another holder has the lock`: hold `acquireLock(<thread.lock>)`, then call `update(id, fn, 100)` and assert it throws `ThreadBusyError` and `fn` never ran.
  - `transcript counts malformed lines`: append a garbage line by hand, then `malformedLines === 1` and the valid entries are still returned.
- [ ] **Step 2: Run** `npx tsc -p tsconfig.test.json && node --test .test-build/test/chat-store.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `ThreadStore` in `src/chat/store.ts`, following `JobRegistry`'s style (`src/registry.ts`).
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(chat): add thread store with locked updates and append-only transcript`.

---

### Task 3: Request builders

**Files:**
- Create: `src/chat/request.ts`
- Test: `test/chat-request.test.ts`

**Interfaces:**
- Consumes: Task 1 types, `ChatMessage` from `src/openrouter/types.ts`.
- Produces:
  ```ts
  export interface ChatPrompt { systemPrompt: string; projectInstructions?: string }
  export function buildTurnMessages(thread: ThreadState, entries: TranscriptEntry[], throughSeq: number, prompt: ChatPrompt): ChatMessage[]
  export function compactionBoundary(thread: ThreadState, entries: TranscriptEntry[], keepRecentExchanges: number): number | undefined
  export function buildCompactionMessages(thread: ThreadState, entries: TranscriptEntry[], boundary: number, prompt: ChatPrompt, instructions?: string): ChatMessage[]
  export function buildTitleMessages(thread: ThreadState, entries: TranscriptEntry[], throughSeq: number): ChatMessage[]
  export function estimateTokens(messages: ChatMessage[]): number
  export function provisionalTitle(text: string): string
  export function cleanTitle(raw: string): string | undefined
  ```
- Rules the tests pin:
  - **Turn messages:** one `system` message = `systemPrompt`, plus `"\n\n## Project instructions\n\n" + projectInstructions` if given, plus `"\n\n## Summary of the earlier conversation\n\n" + summary.text` if `thread.summary`. Then the entries with `summary.throughSeq < seq <= throughSeq`, using only `user` and `assistant`. Consecutive `user` entries are merged into one `user` message joined with `"\n\n"`.
  - **Exchange:** a maximal run of user entries followed by one assistant entry. `compactionBoundary` returns the seq of the assistant entry ending the last exchange that falls *before* the most recent `keepRecentExchanges` exchanges (counting only exchanges after `summary.throughSeq`). If there is none, it returns `undefined`.
  - **Compaction messages:** a system message telling the model to summarise faithfully (decisions, facts, open questions, the user's stated preferences), plus `"\n\nFocus: " + instructions` when given. Then one user message with the previous summary (if any) and a plain transcript of the entries in `(summary.throughSeq, boundary]`, each labelled `User:` / `Assistant (<model>):`. Exact wording is the implementer's.
  - **Title messages:** a single user message asking for a title of at most 60 characters, with only the title in the reply, built from the summary (if any) plus the user/assistant entries up to `throughSeq`.
  - `provisionalTitle`: collapse whitespace, trim, cut to 60 chars. `cleanTitle`: first non-empty line, strip surrounding quotes, `#`, `*` and the prefix `Title:`, trim, cut to 60. Return `undefined` if the result is empty.
- [ ] **Step 1: Write the failing tests:**
  - `turn messages merge queued user entries`: entries user(1) assistant(2) user(3) user(4), `throughSeq` 4. Messages are `[system, user(1), assistant(2), user("t3\n\nt4")]`.
  - `turn messages include project instructions and summary`: `thread.summary = { text: "S", throughSeq: 2 }`. The system content contains `"## Project instructions"` and `"## Summary of the earlier conversation\n\nS"`, and entries 1 and 2 are absent.
  - `turn messages skip model/title/status/failure entries`.
  - `compactionBoundary`: 6 exchanges with `keep` 4 gives the seq of the 2nd exchange's assistant entry. 4 exchanges with `keep` 4 gives `undefined`. With a summary through exchange 2 and 8 exchanges in total, it counts only exchanges 3 to 8.
  - `compaction messages carry focus instructions`: `instructions = "API decisions"` puts `"Focus: API decisions"` in the system content.
  - `estimateTokens`: two messages of 10 and 3 characters give `4`.
  - `provisionalTitle` of a 100-character multi-line string has length 60 and contains no newline. `cleanTitle('  "Title: Auth redesign"\nmore')` gives `"Auth redesign"`. `cleanTitle("  \n ")` gives `undefined`.
- [ ] **Step 2: Run** `npx tsc -p tsconfig.test.json && node --test .test-build/test/chat-request.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** the functions in `src/chat/request.ts`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(chat): add request builders for turns, compaction and titles`.

---

### Task 4: `createChatJob` and chat-job guards in BatchService

**Files:**
- Modify: `src/service.ts` (new public method beside `createSynthesisJob`; `knownSecrets` becomes public; guards in `buildInjection`, `retry`, `retryItems`, `prepareSynthesis`, `exportResults`), `src/artifacts/service.ts:122-123` (guard after `registry.read`)
- Test: `test/chat-job.test.ts`

**Interfaces:**
- Consumes: Task 1 `ChatLinkage`, `CHAT_MANIFEST_SCHEMA_VERSION`, `isChatJob`.
- Produces:
  ```ts
  // BatchService
  public async knownSecrets(account: string): Promise<string[]>
  public async createChatJob(input: {
    threadId: string; purpose: "turn" | "compact"; throughSeq: number;
    model: string; account: string; pin?: ProviderPin;
    main: ChatMessage[];            // item 1: the reply or the summary
    title?: ChatMessage[];          // item 2, optional
  }): Promise<JobManifest>         // persisted via persistJob (kind "chat", schemaVersion 4), then submit(…, { skipDuplicateCheck: true })
  export class ChatJobError extends Error {}   // thrown by the guards
  ```
  Item sources: `{ kind: "goal", label: "chat-reply" | "chat-summary" | "chat-title" }`. `objective` follows Global Constraints. The guard message is `"<id> is a batch chat job; use /batch chat instead."`

- [ ] **Step 1: Write the failing tests** (pattern: `test/lifecycle.test.ts` with `FakeOpenRouter`, `makeService`, `accepted`, `completed`, `successItem`, `failedItem`):
  - `createChatJob submits a 2-item chat job`: `job.kind === "chat"`, `job.schemaVersion === 4`, `job.chat` deep-equals `{ threadId, purpose: "turn", throughSeq: 3, titleItem: true }`, `job.requestCount === 2`, and `job.objective === "Chat turn in <threadId>"`. The posted body's `requests[0].body.messages` equals `main`.
  - `chat job with a failed title item settles partial but the reply item is completed`: reconcile with `completed([successItem(cid0, "hi"), failedItem(cid1)])`. The status is `"partial"` and `items[0].status === "completed"`.
  - `guards refuse chat jobs`: `buildInjection`, `retry`, `retryItems`, `prepareSynthesis` and `exportResults` each reject with `ChatJobError` for a chat job ID.
- [ ] **Step 2: Run** `npx tsc -p tsconfig.test.json && node --test .test-build/test/chat-job.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `createChatJob` with `persistJob`, mirroring `createSynthesisJob`. Add `private assertNotChat(job)` and call it at the top of each guarded method and in `ArtifactService` after `registry.read(jobId)`.
- [ ] **Step 4: Run** the same command, then `npm test`. Expected: PASS, with no regressions.
- [ ] **Step 5: Commit** `feat(chat): add chat job creation and refuse chat jobs in inject/retry/synthesis/export/artifact`.

---

### Task 5: ChatService: turns, settling, queueing, retry, model, rename, retitle

**Files:**
- Create: `src/chat/service.ts`
- Test: `test/chat-service.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4 (`ThreadStore`, request builders, `BatchService.createChatJob`, `knownSecrets`, `jobItems`/`itemText` from `src/items.ts`, `scanForSecrets`/`formatSecretFindings`, `normalizeBatchModelSlug`).
- Produces:
  ```ts
  export class ChatBlockedError extends Error {}   // secret found; message says it was not saved
  export interface ChatServiceDeps { store: ThreadStore; batch: BatchService; workspaceRoot: string; getConfig: () => BatchConfig; logger?: Logger }
  export class ChatService {
    constructor(deps: ChatServiceDeps)
    newThread(): ThreadState                                       // config.defaultModel/defaultAccount
    mostRecent(): ThreadState | undefined
    send(threadId: string, text: string): Promise<{ queued: boolean; jobId?: string }>
    applySettled(job: JobManifest): void                           // idempotent; no-op unless job.chat and thread.pending/compacting.jobId === job.localId
    tick(): Promise<void>                                          // apply terminal jobs, expire stale claims (>120 s with no jobId), send unsent user entries, run auto-compaction
    retry(threadId: string): Promise<string>                       // returns new jobId; throws if no lastFailure
    setModel(threadId: string, slug: string): void                 // appends { type: "model" }
    rename(threadId: string, title: string | { auto: true }): void // manual sets titleLocked; { auto: true } unlocks
    nextRequestEstimate(threadId: string): { tokens: number; summaryTokens: number; recentTokens: number; limit: number }
    compact(threadId: string, instructions?: string): Promise<string>  // Task 6
  }
  ```
- Behaviour (each line is pinned by a test below):
  - `send`: ignore empty or whitespace-only text (return `{ queued: true }` with no write; the session also filters). Scan `text`, and `.pi/BATCH_CHAT.md` if present, with `knownSecrets(thread.account)`. Any finding (when `config.security.scanSecrets && blockOnSecret`) throws `ChatBlockedError`, and nothing is written. Otherwise `store.update`: append `user`, set the provisional title if the title is `"(untitled)"`, and, if neither `pending` nor `lastFailure` is set, claim `pending = { throughSeq: seq, claimedAt }`. Outside the lock: `createChatJob` with the reply messages, plus title messages when `!titleLocked && !retitled && assistantCount + 1 === retitleAtTurn`. Then `update` to set `pending.jobId`. If creation fails, `update` clears `pending`, sets `lastFailure` and appends a `failure` entry.
  - A `ThreadBusyError` from `store.update` propagates. The session turns it into the "not saved, retype" warning.
  - `applySettled` for a turn: if item 1 is usable, append `assistant` with `model: job.model`, `jobId` and `finishReason`. If item 2 is usable and `cleanTitle` succeeds and the title is not locked, set `title`, `retitled = true`, and append `{ type: "title", source: "auto" }`. Otherwise append `failure`, set `lastFailure`, and clear `pending`. Terminal statuses other than ready/partial (failed, expired, cancelled, corrupt) count as failure.
  - After a successful reply, if user entries with `seq > throughSeq` exist, send them immediately as the next turn (from `applySettled`'s caller, `tick`, or directly via a fire-and-forget `void this.sendUnsent(id)`).
  - `retry`: clear `lastFailure` and send every unsent user entry (`seq >` the last assistant seq) as one turn.
- [ ] **Step 1: Write the failing tests.** Use helper `setup()` → `{ root, fake, batch: makeService(root, fake), chat: new ChatService({ store: new ThreadStore(join(root, ".pi/batches/threads")), batch, workspaceRoot: root, getConfig }) }`.
  - `send submits a turn and settle appends the reply`: `send` gives `{ queued: false, jobId }`. Reconcile the job to ready with `successItem(cid0, "Hello!")`, then `applySettled(job)`. The transcript is `[user, assistant("Hello!")]`, `pending` is undefined, and the title is the provisional title of the message.
  - `secret in message is refused before anything is written`: `send(id, "key sk-or-v1-" + "a".repeat(64))` rejects `ChatBlockedError`. The transcript is empty, and `fake.requests.length` is unchanged.
  - `secret in .pi/BATCH_CHAT.md blocks the send`.
  - `BATCH_CHAT.md content reaches the system prompt`.
  - `messages typed while pending are combined into the next turn`: send A, then B and C while pending. Only one job is posted. Settle A. The next posted job's last user message is `"B\n\nC"`.
  - `model switch while pending labels the reply with the job's model` (Review Focus 1): send with model X, `setModel(id, "y/model")`, settle. The assistant entry has `model === X`, and the next turn's job model is `y/model`.
  - `truncated reply is kept with finishReason` (Review Focus 2): a success item with `finish_reason: "length"` gives an assistant entry with `finishReason === "length"`.
  - `failed turn keeps the user message and blocks auto-send until retry`: settle failed. A `failure` entry exists and `lastFailure` is set. A further `send` queues without posting. `retry` posts one job containing both user messages.
  - `retitle rides along on the 3rd turn and a manual rename locks it`: turns 1–2 post 1 item each, and turn 3 posts 2 items. Settling a title item `"Auth redesign"` sets the title and appends a `title` entry. On a second thread, `rename(id, "Mine")` before turn 3 means turn 3 posts 1 item.
  - `failed title item does not fail the turn`: the reply is appended, the title is unchanged and there is no `failure` entry.
  - `applySettled is idempotent and cross-instance`: settle via a **second** `ChatService` instance on the same root (simulating another Pi process). The thread updates once, and calling `applySettled` again appends nothing.
  - `restart recovery`: a job settles while no `ChatService` instance is alive. A fresh instance's `tick()` appends the reply.
  - `stale claim expires`: a thread with `pending` and no `jobId`, `claimedAt` 121 s ago. `tick()` clears it and records `lastFailure`.
  - `ThreadBusyError surfaces and nothing is written` (Review Focus 5): hold the thread lock; `send` rejects `ThreadBusyError`, and the transcript is unchanged.
- [ ] **Step 2: Run** `npx tsc -p tsconfig.test.json && node --test .test-build/test/chat-service.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `ChatService` in `src/chat/service.ts`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(chat): add chat service for turns, queueing, retry, model switch and retitling`.

---

### Task 6: Compaction (manual and automatic)

**Files:**
- Modify: `src/chat/service.ts`
- Test: `test/chat-compaction.test.ts`

**Interfaces:**
- Consumes: Task 3 `compactionBoundary`, `buildCompactionMessages`, `buildTitleMessages`, `estimateTokens`, and Task 5 internals.
- Produces: `ChatService.compact(threadId, instructions?): Promise<string>` (the job ID). It throws `Error("Nothing to compact yet …")` when the boundary is undefined and `Error("Already compacting …")` when `compacting` is set.
- Behaviour:
  - `compact` claims `compacting = { throughSeq: boundary, claimedAt, instructions }` and calls `createChatJob({ purpose: "compact", main: buildCompactionMessages(…), title: !titleLocked ? buildTitleMessages(…) : undefined })`.
  - Settle success: adopt `summary = { text, throughSeq, jobId }` **only if** `!thread.summary || thread.summary.throughSeq < throughSeq`. Append a `compaction` entry (with the summary text) either way, and apply the title as in Task 5. Clear `compacting`.
  - Settle failure: append `failure` (purpose `compact`), clear `compacting`, and leave `summary` unchanged. There is no automatic retry until after the next reply.
  - Auto: after a turn's reply is appended, if `config.chat.autoCompact && !compacting && nextRequestEstimate().tokens > autoCompactTokens && boundary !== undefined`, start `compact(id)`.
  - Sending while compacting is unaffected (uses the current summary).
- [ ] **Step 1: Write the failing tests:**
  - `manual compaction adopts the summary and later turns send it`: 6 exchanges with `keep` 4. `compact(id, "API decisions")` posts a system message containing `"Focus: API decisions"`. Settle with `"SUMMARY"`. Then `thread.summary.throughSeq` is the 2nd exchange's assistant seq, and the next turn's system message contains `"SUMMARY"` but not exchange 1's text. `transcript.jsonl` still contains exchange 1 (never rewritten).
  - `nothing to compact`: 2 exchanges, so `compact` throws "Nothing to compact".
  - `auto compaction triggers after a reply over the limit`: `autoCompactTokens = 50`, with long messages. After the settle that crosses the limit, a compaction job is posted.
  - `message sent during compaction goes out at once with the full history`: while `compacting` is set, `send` posts a turn immediately whose messages include exchange 1.
  - `compaction failure leaves the thread unchanged`: settle failed. `summary` is undefined, a `failure` entry with purpose `"compact"` exists, and `compacting` is cleared.
  - `stale compaction result is not adopted`: an existing summary covers seq 10 and a compaction job for seq 6 settles. The summary still covers 10.
- [ ] **Step 2: Run** `npx tsc -p tsconfig.test.json && node --test .test-build/test/chat-compaction.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** compaction in `ChatService`.
- [ ] **Step 4: Run** the same command, then `node --test .test-build/test/chat-service.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(chat): add manual and automatic thread compaction`.

---

### Task 7: ChatSession and the entry renderer

**Files:**
- Create: `src/chat/session.ts`, `src/chat/render.ts`
- Test: `test/chat-session.test.ts`

**Interfaces:**
- Consumes: `ChatService`, `ThreadStore`, Task 1 types.
- Produces:
  ```ts
  export const CHAT_ENTRY_TYPE = "pi-batch-chat";
  export interface ChatEntryData { threadId: string; seq?: number; role: "user" | "assistant" | "status"; text: string; model?: string; title: string; truncated?: boolean }
  export interface ChatSessionDeps {
    chat: ChatService; store: ThreadStore;
    appendEntry: (data: ChatEntryData) => void;          // index.ts binds to pi.appendEntry(CHAT_ENTRY_TYPE, data)
    setStatus: (text: string | undefined) => void;
    notify: (message: string, level: "info" | "warning" | "error") => void;
    getConfig: () => BatchConfig;
  }
  export class ChatSession {
    constructor(deps: ChatSessionDeps, alreadyShown: Iterable<{ threadId: string; seq: number }>)
    get activeThreadId(): string | undefined
    enter(threadId: string): void        // display resume view, set footer
    leave(): void                        // clear footer
    handleInput(text: string, source: "interactive" | "rpc" | "extension"): Promise<"handled" | "continue">
    sync(): void                         // display unseen entries of the active thread; notify "💬 reply in <title>" for new assistant entries in other threads; refresh footer
    footerText(): string | undefined
  }
  export function renderChatEntry(data: ChatEntryData, expanded: boolean, theme: Theme): Component   // in render.ts
  ```
- Behaviour:
  - Display mapping: `user` gives role `user` ("You → <title>"). `assistant` gives role `assistant` ("<model> → you"), with `truncated` when `finishReason === "length"`. `model`, `title`, `compaction`, `failure` and `status` give role `status`, with one-line text such as `"Model → y/model"`, `"Retitled: …"`, `"Compacted (through #N)"`, `"⚠ Turn failed: … — /batch chat retry"`.
  - `enter`: show a status entry `"Resumed: <title>"`. If `summary` is set, show a status entry `"Compacted earlier conversation (through #N)"`. Then show every entry with `seq > summary.throughSeq` not already shown.
  - The "shown" set is keyed `threadId:seq` and seeded from `alreadyShown` (rebuilt from session entries by `index.ts`). The other-thread notification baseline is each thread's max assistant seq at construction, so pre-existing replies don't notify.
  - `handleInput`: return `"continue"` if no active thread, `source === "extension"`, or the trimmed text starts with `"/"`. Return `"handled"` with no write for empty or whitespace text. Otherwise call `chat.send`, then `sync()`, and return `"handled"`. On `ChatBlockedError` or `ThreadBusyError`, show a warning that includes `"not saved"` and return `"handled"`.
  - Footer per Global Constraints.
  - Renderer: header in a distinct colour (`theme.fg("accent")` for assistant, `"muted"`/`"dim"` for user and status). Collapsed to 8 lines unless `expanded`, as `index.ts`'s injected-result renderer does. The truncated marker is `"(truncated: max_tokens)"`.
- [ ] **Step 1: Write the failing tests** (fake deps record `appendEntry`/`setStatus`/`notify` calls; real `ChatService` on `FakeOpenRouter`):
  - `input routing`: with no active thread, the result is `"continue"`. With an active thread: `"/batch list"` gives `"continue"`; source `"extension"` gives `"continue"`; `"   "` gives `"handled"` with zero `appendEntry` calls and an empty transcript (Review Focus 4); `"hello"` gives `"handled"` with one `user` entry displayed.
  - `secret input warns "not saved" and writes nothing`.
  - `enter shows summary marker and only entries after the summary`.
  - `sync displays a reply once`: settle a reply, then `sync()` twice. Exactly one `assistant` display.
  - `entries already shown in a previous session are not re-displayed` (`alreadyShown` seeded).
  - `reply in another thread notifies instead of displaying`.
  - `truncated assistant display`: `finishReason "length"` sets `truncated: true`.
  - `footer`: shows `"💬 <title> · <model>"`, appends `"· waiting"` while pending, appends `"· 85% until compact"` at an 85% estimate, and stays a single line with a 40-char cap for a 100-char title.
  - `leave clears the footer`.
  - `isolation (structural)`: read every file under `src/chat/` and assert none contains `sendMessage` or `sendUserMessage`.
- [ ] **Step 2: Run** `npx tsc -p tsconfig.test.json && node --test .test-build/test/chat-session.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `ChatSession` and `renderChatEntry`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(chat): add chat session (mode, input, display, footer) and entry renderer`.

---

### Task 8: Runtime wiring and tool exclusion

**Files:**
- Modify: `src/runtime.ts` (construct `ThreadStore` at `<storage>/threads` and `ChatService` in `reloadConfig`; route `onSettled`; own `chatSession`), `src/poller.ts` (`onTick?: () => Promise<void>` constructor arg, awaited after each `runPass`, errors caught and logged), `index.ts` (register `input` handler, entry renderer, rebuild `ChatSession` on `session_start`, `leave` on `session_shutdown`), `src/tools.ts` (`batch_check_jobs` and `batch_get_items` skip chat jobs)
- Test: `test/chat-wiring.test.ts`

**Interfaces:**
- Consumes: Tasks 5–7.
- Produces: `BatchRuntime.chat: ChatService | null`, `BatchRuntime.chatSession: ChatSession | null`, `BatchRuntime.requireChat(): ChatService`, `BatchRuntime.requireChatSession(): ChatSession`. `export function visibleToModel(jobs: JobManifest[]): JobManifest[]` in `src/tools.ts` (filters `isChatJob`).
- Behaviour:
  - `onSettled(job)`: if `isChatJob(job)`, call `chat.applySettled(job)`, then `chatSession?.sync()` and `poller.updateBadge()`, and **return** without the generic notification.
  - The poller `onTick` calls `chat.tick()` then `chatSession?.sync()`.
  - `session_start`: build `ChatSession` with `alreadyShown` from `ctx.sessionManager.getEntries()` filtered to `type === "custom" && customType === CHAT_ENTRY_TYPE`, mapping `data.threadId`/`data.seq`. Chat mode always starts off.
  - `pi.on("input", (e) => …)`: map the `handleInput` result to `{ action: "handled" }` or `{ action: "continue" }`.
- [ ] **Step 1: Write the failing tests:**
  - `visibleToModel drops chat jobs and keeps others`.
  - `poller onTick runs after a pass and a throwing onTick does not stop scheduling`: construct `BatchPoller` with a stub service and an `onTick` that throws, call `checkNow()`, and assert it resolves.
  - `badge still counts active chat jobs` (`badgeText` is unchanged for a chat job in `submitted`).
- [ ] **Step 2: Run** `npx tsc -p tsconfig.test.json && node --test .test-build/test/chat-wiring.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** the wiring.
- [ ] **Step 4: Run** `npm test` and `npm run check`. Expected: all PASS, no type errors.
- [ ] **Step 5: Commit** `feat(chat): wire chat service and session into runtime, poller and Pi events`.

---

### Task 9: `/batch chat` commands

**Files:**
- Create: `src/chat/commands.ts`
- Modify: `src/commands.ts` (`case "chat": return cmdChat(rt, rest, ctx)`; add `chat` to `SUBCOMMANDS` with `nonTerminal: true`; add the chat lines to `HELP`; export `showText`)
- Test: `test/chat-commands.test.ts`

**Interfaces:**
- Consumes: `rt.requireChat()`, `rt.requireChatSession()`, `discoverBatchModels(ctx)` from `src/models.ts`, `showText`, `parseArgs`, `writeFileAtomicExclusive`, `isInside`.
- Produces:
  ```ts
  export async function cmdChat(rt: BatchRuntime, rest: string[], ctx: ExtensionCommandContext): Promise<void>
  export function formatContext(e: ReturnType<ChatService["nextRequestEstimate"]>): string
  export function formatCost(jobs: JobManifest[]): string          // sums only reported usage; says "not reported" otherwise
  export function exportMarkdown(thread: ThreadState, entries: TranscriptEntry[]): string
  export const CHAT_HELP: string
  ```
- Subcommands (spec table, verbatim semantics):
  - `""` → `newThread` + `enter`.
  - `continue` → `mostRecent` + `enter`. With none: `"No chat threads yet. Start one with /batch chat."`
  - `resume [thread]` → `ctx.ui.select` over `list()`, labelled `"<title> · <relative time> · <n> msgs · <model>[ · waiting|compacting]"`, or `store.resolve(arg)`.
  - `clear` → same as `""`.
  - `rename <title>` / `rename --auto`.
  - `model [slug]` → with no slug, `ctx.ui.select` over the distinct models in this project's threads plus `config.defaultModel` plus `discoverBatchModels(ctx)` slugs plus `"Type a slug…"` (→ `ctx.ui.input`).
  - `compact [instructions…]` (the rest is joined as instructions).
  - `context` → `showText(formatContext(...))`.
  - `cost` → `formatCost(registry jobs with chat.threadId === active)`.
  - `export [file] [--overwrite]` → with a file (workspace-relative, must be `isInside` the workspace), write via `writeFileAtomicExclusive`; otherwise `showText`.
  - `off`, `retry`, `help`.
  - Commands that need a thread (`rename`, `model`, `compact`, `context`, `cost`, `export`, `retry`) throw `"Not in chat mode. Use /batch chat continue or /batch chat resume."` when there is no active thread.
- [ ] **Step 1: Write the failing tests** for the pure parts:
  - `formatContext` includes the token estimate, summary vs recent split, and `"% of auto-compact limit"`.
  - `formatCost` sums `usage.cost` and `totalTokens` across jobs, and prints `"not reported"` when no job has usage.
  - `exportMarkdown` includes the title heading, `"### You"` and `"### <model>"` sections, a compaction marker containing the summary text, model-switch and retitle lines, and the `(truncated: max_tokens)` marker for `finishReason "length"`.
  - `CHAT_HELP` mentions every subcommand: `continue resume clear rename model compact context cost export off retry help`.
- [ ] **Step 2: Run** `npx tsc -p tsconfig.test.json && node --test .test-build/test/chat-commands.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `src/chat/commands.ts` and the `src/commands.ts` dispatch, autocomplete and help.
- [ ] **Step 4: Run** `npm test` and `npm run check`. Expected: all PASS.
- [ ] **Step 5: Commit** `feat(chat): add /batch chat commands`.

---

### Task 10: Documentation and manual validation

**Files:**
- Modify: `README.md` (command-table rows for `/batch chat …`; a new "Batch chat" section covering isolation, queueing, compaction, retitling, `.pi/BATCH_CHAT.md`, `chat.*` config keys with defaults, chat jobs refused by inject/retry/synthesize/export/artifact; a "Known limitations" bullet saying the live model's own file tools can read `.pi/batches/threads/`)

- [ ] **Step 1: Write the README changes** in the existing style (tables, short paragraphs, no marketing).
- [ ] **Step 2: Manual check in an interactive Pi session, launched from PowerShell** (the RPC driver deliberately refuses plain text, so chat input can't be scripted with it). In a scratch workspace with `/batch model` set to a cheap batch-capable model:
  1. `/batch chat`, type `hello`. Expected: a "You →" entry, and the footer shows `· waiting`.
  2. `/batch chat off`, then ask the live model "what did I just say to the batch model?". Expected: it does not know.
  3. Close Pi, reopen it, wait for the reply, then `/batch chat continue`. Expected: the reply is shown once.
  4. `/batch chat context`, `/batch chat cost`, `/batch chat export chat.md`. Expected: sensible output, and the file is written.
  Record the results in the commit message body.
- [ ] **Step 3: Run** `npm test` and `npm run check`. Expected: all PASS.
- [ ] **Step 4: Commit** `docs: document batch chat`.
