# Delete Chats and Batches Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user delete chats and batch jobs (one, several, or all old finished ones) with one confirmation for the exact list shown.

**Architecture:** A new `src/cleanup.ts` holds a `CleanupService` with a read-only `plan` and an `apply` that deletes exactly the planned list, rechecking each item under its lock. Low-level removal lives in `JobRegistry.removeJob` and `ThreadStore.removeThread` (rename to `.deleting-<id>`, then remove). Slash commands and two MCP tools call the service.

**Tech Stack:** TypeScript, node:test (`npm test`), existing `acquireLock`/registry/thread store, TypeBox tool specs.

**Spec:** `docs/superpowers/specs/2026-11-25-delete-chats-and-batches-design.md`

## Global Constraints

- Local only by default; no network call without `--remote`.
- Never delete a job in `ACTIVE_STATUSES` (`src/state.ts`), nor a thread with `pending` or `compacting`.
- `clean` default cutoff is `7d`; `0` is allowed.
- Plans live in memory for 10 minutes; an unknown or expired `planId` is an error telling the user to re-plan.
- Do not delete `metadata/` drafts, `artifacts/`, or anything outside job and thread folders.
- Windows: removal retries on `EBUSY`/`EPERM`. No shell-outs for removal; use `fs.rmSync`.
- Repo line endings are LF (`.gitattributes`); keep new files LF.
- Existing tests keep passing (`npm test`, `npm run check`).

## Review Focus

- A job whose manifest is unreadable or corrupt: listed under `skipped` with its reason, never deleted blindly.
- A chat job whose thread is already gone, or a thread whose jobs are partly gone: delete what exists, no error.
- The same job reached twice (named directly and as a retry of another target): deleted once, listed once.
- A job that becomes active between plan and apply: skipped and reported, the rest still deleted.
- A leftover `.deleting-*` folder after a crash is invisible to listings and swept by the next `clean`.

---

### Task 1: Robust removal primitives

**Files:**
- Create: `src/removal.ts`
- Modify: `src/registry.ts` (add `removeJob`, `sweepDeleting`), `src/chat/store.ts` (add `removeThread`; make `list` skip `.deleting-*`)
- Test: `test/removal.test.ts`

**Interfaces:**
- Produces: `removeDirRobust(dir: string): Promise<void>` (retries `EBUSY`/`EPERM`/`ENOTEMPTY` up to 5 times, 100 ms apart); `dirSizeBytes(dir: string): number`; `JobRegistry.removeJob(localId: string, opts?: { force?: boolean }): Promise<void>`; `JobRegistry.sweepDeleting(): number` (folders removed); `ThreadStore.removeThread(id: string): Promise<void>`.

- [ ] **Step 1: Write failing tests** in `test/removal.test.ts`: (a) `removeJob` deletes the folder and `registry.list().jobs` no longer contains it; (b) `removeJob` on an `ACTIVE_STATUSES` job rejects with `/active/` and leaves the folder; (c) a pre-made `.deleting-B-…` folder is not returned by `registry.list()`, and `sweepDeleting()` returns 1 and removes it; (d) `removeThread` removes the thread folder and `store.list()` omits it, and on a thread with `pending` rejects with `/in use/`; (e) `dirSizeBytes` sums nested file sizes.
- [ ] **Step 2: Run** `npm test` and confirm these fail (functions undefined).
- [ ] **Step 3: Implement** the primitives. `removeJob`: take `this.lock(localId)`, re-`read` the manifest and throw if `ACTIVE_STATUSES.has(localStatus)`, release the lock, `fs.renameSync` the folder to `.deleting-<localId>` in the same root, then `removeDirRobust`. With `force: true` (used only by `CleanupService` for an explicit ref to a corrupt job) skip the manifest read. `removeThread`: same pattern with the thread lock and `ThreadState.pending/compacting`; leave the existing `remove` untouched. `JobRegistry.list` already ignores names that fail `isLocalJobId`; confirm `ThreadStore.list` ignores names failing `isThreadId` and add the filter if not.
- [ ] **Step 4: Run** `npm test` and `npm run check`; expect PASS.
- [ ] **Step 5: Commit** `feat(cleanup): robust removal primitives for jobs and threads`.

### Task 2: CleanupService (plan and apply)

**Files:**
- Create: `src/cleanup.ts`
- Test: `test/cleanup.test.ts`

**Interfaces:**
- Consumes: Task 1 primitives; `JobRegistry.list/resolveId`; `ThreadStore.list/resolve`; `ChatLinkage.threadId`; `JobManifest.parentJobId`, `synthesis.sourceJobId`; `ACTIVE_STATUSES`.
- Produces:
```ts
export interface CleanupItem { kind: "job" | "thread"; id: string; label: string; status: string; ageDays: number; bytes: number; viaClosure?: string }
export interface CleanupPlan { planId: string; items: CleanupItem[]; skipped: Array<{ kind: "job" | "thread"; id: string; reason: string }>; totalBytes: number; remote: boolean }
export interface CleanupResult { deleted: CleanupItem[]; skipped: CleanupPlan["skipped"]; freedBytes: number; remote: Array<{ id: string; ok: boolean; error?: string }> }
export type CleanupTarget = { refs: string[] } | { olderThanMs: number; include: "all" | "jobs" | "chats" };
export class CleanupService {
  constructor(deps: { registry: JobRegistry; threads: ThreadStore; now?: () => Date; remoteDelete?: (job: JobManifest) => Promise<void> });
  plan(target: CleanupTarget, opts?: { remote?: boolean }): CleanupPlan;
  apply(planId: string): Promise<CleanupResult>;
}
export function parseOlderThan(text: string): number; // "7d", "12h", "0" -> ms; throws on anything else
```

- [ ] **Step 1: Write failing tests** (use the existing registry and thread fixtures): `plan` is read-only (folders unchanged afterwards); a chat ref yields the thread plus every job whose `chat.threadId` matches; a source job ref pulls in its retries and syntheses (`viaClosure` set) while a retry alone leaves the source out; an active job and a thread with `pending` appear in `skipped`, not `items`; a job named twice appears once; `olderThanMs` excludes younger items; a corrupt-manifest job is in `skipped` with a reason; `apply` with an unknown or expired id throws `/re-plan/`; a job that becomes active between `plan` and `apply` is skipped and reported while the rest are deleted; `apply` removes threads after their jobs; `parseOlderThan("7d") === 604800000`, `"12h"` works, `"0" === 0`, and `"soon"` throws.
- [ ] **Step 2: Run** and confirm failure.
- [ ] **Step 3: Implement** `CleanupService`. Plans sit in a `Map<planId, { plan, createdAt }>` expiring after 10 minutes (use the injected `now`). Refs resolve with `registry.resolveId` then `threads.resolve`; an unresolvable ref throws naming it. `apply` re-reads each item's status immediately before `removeJob`/`removeThread` and turns the "active"/"in use" errors into `skipped` entries. `freedBytes` sums `bytes` of deleted items. Call `registry.sweepDeleting()` at the start of every filter-based (`clean`) plan. Remote step: only when `plan.remote`, only for deleted jobs with `providerBatchId` that are not `neverReachedOpenRouter` (`src/privacy/policy.ts`); failures go into `remote[]` and never throw.
- [ ] **Step 4: Run** `npm test` and `npm run check`; expect PASS.
- [ ] **Step 5: Commit** `feat(cleanup): CleanupService with plan and apply`.

### Task 3: Wire the service and add slash commands

**Files:**
- Modify: `src/runtime.ts` and `src/workspace.ts` (construct `CleanupService` beside `ChatService`), `src/commands.ts` (help text near line 103; `case "delete"` and `case "clean"` in the dispatcher near line 271; handlers `cmdDelete`, `cmdClean`), `src/cleanup.ts` (add the two formatters)
- Test: `test/cleanup-commands.test.ts`

**Interfaces:**
- Consumes: `CleanupService`; `ctx.ui.confirm(title, body)` as used at `src/commands.ts:340`.
- Produces: `formatPlan(plan: CleanupPlan): string` and `formatResult(r: CleanupResult): string` exported from `src/cleanup.ts` (reused by Task 4).

- [ ] **Step 1: Write failing tests**: `/batch delete <ref>` prints the plan, asks once via `confirm`, deletes on yes and nothing on no; `--yes` skips `confirm`; `/batch clean` defaults to 7 days and lists only older finished items; `/batch clean --older-than 0 --chats` limits to threads; a bad `--older-than` value shows the usage error; the result ends with a totals line `N deleted, M skipped, X freed`.
- [ ] **Step 2: Run** and confirm failure.
- [ ] **Step 3: Implement** the handlers and formatters (per item: id, label, status, age, size; totals; skipped with reasons). Parse `--yes`, `--remote`, `--older-than <v>`, `--chats`, `--jobs` with the helpers in `src/args.ts`. Add both commands to the help text.
- [ ] **Step 4: Run** `npm test` and `npm run check`; expect PASS.
- [ ] **Step 5: Commit** `feat(cleanup): /batch delete and /batch clean`.

### Task 4: MCP tools

**Files:**
- Modify: `src/tools.ts` (add `cleanup_plan` and `cleanup_apply` specs beside `batch_cancel`, `hosts: ["mcp"]`), `src/mcp/server.ts` (confirmation gate for `cleanup_apply`, mirroring `checkSubmitElicitation` at line 241)
- Test: `test/mcp-cleanup.test.ts`

**Interfaces:**
- Consumes: `CleanupService`, `formatPlan`, `formatResult`.
- Produces: tool `cleanup_plan` with params `{ refs?: string[]; older_than?: string; include?: "all" | "jobs" | "chats"; remote?: boolean }` (`readOnlyHint: true`) returning text plus `details.planId`; tool `cleanup_apply` with params `{ plan_id: string }` (`destructiveHint: true`).

- [ ] **Step 1: Write failing tests**: `cleanup_plan` deletes nothing and returns a `planId`; `cleanup_apply` with that id deletes the listed items; with no `refs` and no `older_than` it plans a 7 day clean; an unknown `plan_id` returns the re-plan error; when the client supports elicitation the gate asks once and a decline deletes nothing.
- [ ] **Step 2: Run** and confirm failure.
- [ ] **Step 3: Implement** the two specs and the gate. The descriptions say the user must have seen and agreed to the list before `cleanup_apply`; add the guideline "Never call cleanup_apply without showing the user the plan first".
- [ ] **Step 4: Run** `npm test` and `npm run check`; expect PASS.
- [ ] **Step 5: Commit** `feat(cleanup): cleanup_plan and cleanup_apply MCP tools`.

### Task 5: Remote deletion, docs, final verification

**Files:**
- Modify: `src/runtime.ts` and `src/workspace.ts` (pass `remoteDelete`, reusing the DELETE call and API-key lookup behind `remoteDeletion` in `src/service.ts`), `README.md` (new "Deleting chats and batches" section: commands, defaults, what is and is not deleted, `--remote`)
- Test: extend `test/cleanup.test.ts`

**Interfaces:**
- Consumes: the `remoteDelete` dependency of `CleanupService`.

- [ ] **Step 1: Write failing tests**: with `remote: true` a finished job with a `providerBatchId` calls `remoteDelete` once, and local deletion stands when it throws (`remote[]` shows `ok: false`); a job that never reached OpenRouter is not sent; without `remote` nothing is called.
- [ ] **Step 2: Run** and confirm failure.
- [ ] **Step 3: Implement** the wiring with no new HTTP code. A missing API key becomes an `ok: false` entry carrying the reason.
- [ ] **Step 4: Verify** `npm run check`, then `npm test` (expect all pass), then manually in a scratch workspace: create two finished jobs, run `/batch clean --older-than 0`, and confirm the list, a single confirmation, and that only those folders vanish.
- [ ] **Step 5: Commit** `feat(cleanup): opt-in remote delete and docs`.

---

## Self-review

- Spec coverage: plan/apply, closure, refusals, both commands, `--yes`, two MCP tools with gate, `--remote`, rename-then-remove with sweep, README and the test list are mapped across Tasks 1 to 5. The web UI is a stated non-goal.
- Names are consistent across tasks: `CleanupService.plan/apply`, `removeJob`, `removeThread`, `sweepDeleting`, `formatPlan`, `formatResult`, `parseOlderThan`.
