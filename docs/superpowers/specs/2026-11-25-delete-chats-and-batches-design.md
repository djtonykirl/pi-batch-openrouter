# Delete chats and batches: design

## Intent
Pi never removes anything. Batch jobs (`<storage>/B-…`) and chat threads (`<storage>/threads/…`) pile up, and every chat
turn adds a job. The owner wants to tidy that clutter: delete one chat or batch easily, and clear out old finished ones
in one go. Privacy erasure is not the driver (the existing strict-level remote deletion covers that).

## Goals
- Delete a chat, a batch job, or a set of old finished ones, from the slash command and from MCP.
- One confirmation for the whole list: the exact list is shown first, one yes executes that same list.
- Never delete work in flight; never leave a dangling half-job or a broken link.

## Non-goals
- No soft delete, trash or undo (it recreates the clutter).
- No tick-list selection. No web-page UI in this change.
- Does not delete written outputs outside the job folders (`metadata/…` drafts, `artifacts/`), nor the OpenRouter copy
  unless `--remote` is given.

## Anti-goals
Deleting a running job or a chat mid-turn; deleting something the user did not see in the list; leaving a chat whose
jobs are gone (or the reverse).

## Approach (chosen: A, service layer with a plan step)
Considered: (A) service-layer delete with a plan step; (B) thin command that `rm -rf`s folders, rejected because it
ignores locks, in-flight work and links; (C) soft delete to a trash folder, rejected as it adds restore/purge machinery
and a second pile of clutter. A was picked by the owner.

## Design
**Plan, then apply.** `planDeletion(targets | filter)` is read-only and returns `{ planId, items[], skipped[] }`:
each item is a job or thread with its label, status, age and size on disk; `skipped` names what was refused and why.
`applyDeletion(planId)` deletes exactly that list, rechecking each item under its lock; anything that became active
since the plan is skipped and reported, never deleted. Plans live in memory for 10 minutes; a lost plan means re-plan.

**What a target pulls in (the closure, all shown in the plan):**
- a chat thread: the thread and every job whose `chat.threadId` is that thread;
- a job: itself, its linked retry jobs, and synthesis jobs built from it (retries and syntheses are meaningless
  without the source). Deleting a retry or synthesis alone leaves the source untouched.

**Refusals (never deleted):** any job in `ACTIVE_STATUSES`; a thread with `pending` or `compacting`, or any active
job; jobs younger than the age filter (clean only).

**Surfaces**
- `/batch delete <job-or-chat…> [--remote] [--yes]`: same natural references as `show`/`cancel`. Prints the plan;
  asks once; `--yes` skips the question.
- `/batch clean [--older-than 7d] [--chats|--jobs] [--remote] [--yes]`: all finished jobs and idle chats older than
  the cutoff. Default cutoff is 7 days (my call: a safe default for an unattended bulk command); `0` is allowed.
- MCP: `cleanup_plan` (read-only, returns the list and a `plan_id`) and `cleanup_apply` (takes `plan_id`, uses the
  same elicitation gate as `batch_submit_plan`). Only these two tools; targets and filters are arguments.
- `--remote` (opt-in): after the local delete, a best-effort DELETE of the provider batch for jobs that reached
  OpenRouter and are finished. A failure is reported and never blocks or undoes the local delete. It reuses the
  existing remote-deletion client call.

**How a delete happens (my call).** Under the job/thread lock, re-read status, rename the folder to
`.deleting-<id>`, then remove it (retrying on `EBUSY`/`EPERM`, which is common on Windows). `registry.list` and
`threads` listing skip `.deleting-*`, so a crash mid-removal leaves nothing half-visible; a leftover folder is swept
by the next `clean`. A chat is removed before its jobs (if it cannot be, its jobs stay with it), and a job whose chat is gone can be deleted on its own.

**Output.** The plan shows, per item: id, short label, status, age, size; totals; and what is skipped. The result says
how many were deleted, how many skipped, how much space was freed.

## Constraints
- Local only by default; no network call without `--remote`.
- Windows, Git Bash and PowerShell: folder removal must tolerate locked files.
- Existing tests keep passing; the poller and chat service must tolerate a job vanishing (chat service already fails a
  turn whose job no longer exists; the builder verifies the poller does the same without error noise).

## Left to the builder
Exact output formatting; the size calculation; the `7d` duration parser (reuse an existing one if present); help text
and README section; whether the dashboard list needs a refresh hook after deletion.

## Tests
Plan is read-only; closure for chat and for source job; active job and busy thread refused; age filter; race (job
becomes active between plan and apply is skipped); `.deleting-*` skipped by listings and swept; apply with unknown or
expired plan id; `--remote` failure does not block; MCP plan/apply round trip.
