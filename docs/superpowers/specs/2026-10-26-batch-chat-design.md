# Batch chat: design

Status: draft for review · 2026-10-26

## Intent

Let the user hold ongoing, low-cost conversations with OpenRouter batch models from inside Pi. Each conversation is a
standalone named thread, not a follow-up to `/batch ask`. Batch replies take minutes to hours, so this is chat with a
delay. The user sends a message, carries on working, and the reply shows up in their Pi session when it is ready.

The batch conversation is kept **apart from the live Pi model**. Replies are shown on screen, but the live model
(Claude, etc.) never sees them and they never enter its context.

## Goals

- **Chat mode.** The user switches a Pi session into chat mode on a named thread. Whatever they type goes to that
  thread's batch model instead of the live model, until they switch back.
- **Threads that persist across sessions**, one per topic, stored per project, and modelled on Claude Code
  conversations: titled automatically, renameable, and continued or resumed from a picker. A thread can be picked up
  from any later Pi session in the same project.
- **Feels like Claude Code.** Command names and behaviours follow Claude Code wherever a counterpart exists (see the
  Commands table), because that's the harness the user knows best.
- **One continuous thread.** Each turn sends the thread's full history (or its compacted form, below), so the model
  sees the whole conversation.
- **Same model by default, switchable mid-thread.** A thread keeps its model until the user switches. A switch applies
  from the next message on, and the history carries over unchanged. Each reply records and shows the model that wrote it.
- **One message in flight per thread.** Messages typed while a reply is pending wait. They are sent once the reply arrives.
- **Compaction, manual and automatic**, so long threads stay within cost and context limits without losing the original
  record.

## Non-goals (v1)

- Attaching files or directories to a chat message. `/batch ask` remains the way to send file context. *(My call;
  easy to add later by reusing `buildContextPackage`.)*
- Tools or function calling. Batch is text-only `/v1/chat/completions`, as everywhere else in the extension.
- Sharing chat content with the live model. There is no "inject" for chat replies.
- Branching or forking threads (Claude Code's `--fork-session`), editing earlier messages, or regenerating a past reply.
- Claude Code features that rely on live tools or streaming: plan mode, permissions, interrupting with Esc, hooks.
- Making batch models selectable as ordinary Pi models through `pi.registerProvider`. This was rejected because Pi's
  agent loop would block for hours per turn.
- Cost dashboards. Existing per-job usage reporting is enough.

## Anti-goals

- **The live model seeing or acting on chat content.** That would be a privacy and confusion failure even if
  everything else worked.
- **Uncertainty about where typing goes.** If the user can't tell whether a message is going to the live model or the
  batch model, the feature has failed.
- **Losing conversation history.** Compaction must never destroy the original transcript, and a failed turn must never
  silently drop the user's message.
- **Waiting twice.** Compaction must never hold up a message the user has sent.

## Constraints from the existing extension

- Batch latency is minutes to 24 h, with no guarantee. The design must work entirely asynchronously and survive Pi
  restarts. The existing durable job registry and poller already give this.
- Each chat turn is an ordinary single-request batch job, created through the existing `persistJob` → `submit` →
  `reconcile` path. It therefore gets the same artefacts, secret scan, provenance, retry and `/batch show` support.
- Pi's extension API provides what is needed (verified against `@earendil-works/pi-coding-agent` types):
  - `pi.on("input", …)` returns `{ action: "handled" }` to take typed text away from the live model while chat mode is on.
  - `pi.appendEntry(customType, data)` adds a session entry that is **never sent to the LLM**, and
    `pi.registerEntryRenderer` displays it. Chat is displayed this way. `pi.sendMessage` is deliberately **not** used.
    Custom messages reach the live model through Pi's own session compaction and branch summarisation, which bypass the
    `context` event, and through mid-run delivery. Entries avoid all three.
  - `ctx.ui.setStatus` provides the footer marker (see `STATUS_KEY` in `src/runtime.ts`).
  - Pi runs extension commands (`/batch …`) before the `input` event fires, so they never reach the chat handler.
- The Git Bash path-mangling issue documented in the README applies to scripted testing of `/batch chat` as well. Use
  PowerShell.

## How it behaves

### Commands

The command set deliberately mirrors Claude Code, which the user knows best. The Claude Code equivalent is listed
against each command.

| Command | Claude Code equivalent | Behaviour |
|---|---|---|
| `/batch chat` | `claude` | Start a **new** thread and enter chat mode on it. It uses the project's default batch model (`/batch model`) and account. |
| `/batch chat continue` | `claude --continue` | Enter chat mode on the most recently active thread. |
| `/batch chat resume [thread]` | `/resume`, `claude --resume` | With no argument, open a picker of this project's threads: title, relative last activity, message count, model, and pending/compacting state, newest first. With an argument, go straight to that thread. |
| `/batch chat clear` | `/clear` | Start a fresh thread. The previous one stays resumable. |
| `/batch chat rename <title>` | `/rename` | Rename the current thread. |
| `/batch chat model [slug]` | `/model` | With a slug, change the model from the next message on. With no slug, open a picker of models used in this project plus the default, with an option to type a slug. |
| `/batch chat compact [instructions]` | `/compact [instructions]` | Compact the thread now. Optional instructions steer what the summary focuses on (see Compaction). |
| `/batch chat context` | `/context` | Show the estimated size of the next request, how much is summary versus recent messages, and the distance to the auto-compact limit. |
| `/batch chat cost` | `/cost` | Show usage and cost totals for the thread, counting only what the provider reported, as elsewhere. |
| `/batch chat export [file]` | `/export` | Write the full transcript to Markdown, including compaction markers and the model per reply. With no file, show it instead. |
| `/batch chat off` | (none) | Leave chat mode. Typing goes to the live model again. |
| `/batch chat retry` | (none) | Resubmit the last turn if it failed. |
| `/batch chat help` | `/help` | List the chat commands. |

**Thread identity** follows the job-ID convention: a stable ID (e.g. `T-20261026-K3M9`) used as the directory name, plus a
**title**. As in Claude Code, the title is generated automatically and can be changed with `rename`:

- **Provisional title:** the first ~60 characters of the first message, set immediately with no model call.
- **Auto-retitle as the purpose becomes clearer.** At set points, the chat turn's batch carries a second, small request:
  "Suggest a short title (≤ 60 chars) for this conversation", given the summary plus recent messages. Because a batch
  can hold several requests (as `map-files` already uses), this adds **no extra round-trip** and is billed at the batch
  rate. The title request is a separate item, so the reply the user sees is never altered.
  - **When:** with the 3rd turn, then with every compaction (whose input already covers the whole thread). *(My call;
    builder may tune via `chat.retitleAtTurn`.)*
  - **Shown** as a status line in the thread ("Retitled: …"), and in the footer and picker from then on.
  - **A manual `rename` locks the title.** Auto-retitling stops for that thread, so the user's choice is never
    overwritten. `rename --auto` unlocks it. *(My call.)*
  - **Failure is silent apart from a log line.** A failed or empty title item never affects the turn. The turn's
    success is judged on the reply item alone. Anywhere a `[thread]` is accepted, a unique ID suffix (as with
jobs) or an exact title both work. *(My call.)*

**Project instructions (the CLAUDE.md equivalent).** If `.pi/BATCH_CHAT.md` exists, its contents are added to the system
prompt of every chat turn and compaction in this project. It goes through the same secret scan as a message, and a
finding blocks sends until the file is fixed. *(My call on the filename.)*

### Chat mode

- Chat mode belongs to the session. It is **not** restored when Pi restarts, so a fresh session always starts out
  talking to the live model. *(My call, in service of the "uncertainty about where typing goes" anti-goal.)*
- While chat mode is on, a footer status shows `💬 <title> · <model>`, plus `· waiting` while a reply is pending.
  This is the minimum needed for the user to know where their typing goes. Like Claude Code's "context left until
  auto-compact" warning, it adds `· N% until compact` once the thread is past 80% of the auto-compact limit.
- Slash commands still work in chat mode. Only plain text goes to the thread. Extension commands never reach the
  `input` handler, and the handler passes any other input starting with `/` through with `{ action: "continue" }`.
- The handler takes input whose `source` is `interactive` or `rpc`. RPC is included so the existing RPC driver
  (`scripts/pi-rpc.mjs`) can exercise chat. Input from other extensions (`source: "extension"`) passes through
  untouched. *(My call.)*
- On entering a thread (`continue` / `resume`), the thread is shown as Claude Code shows a resumed conversation: a
  "compacted" marker if there is a summary, then every message since, each collapsed to a few lines and expandable.

### A turn

1. The user types text. The `input` handler takes it and runs the secret scan on **that message alone, before anything is
   saved**. If the scan finds something, the message is refused with the usual findings. It is not written to the
   thread or the queue, and the user can retype it. This keeps secrets off disk and stops one blocked message from
   poisoning every later request. *(My call.)*
2. Once the scan passes, the message is appended to the thread (or the queue, if a reply is pending) and displayed
   ("You → <thread>").
3. If no reply is pending, the extension builds the request (system prompt + summary if any + messages since the
   summary + the new user message) and creates and submits a one-request job. There is **no per-message confirmation
   dialog**, because entering chat mode is the consent. *(My call. The existing `/batch ask` flow confirms every
   submission; per-message confirms would make chat unusable.)*
4. When the job settles `ready`, the reply is appended to the thread with its model, job ID and usage, and shown in the
   transcript as "<model> → you" in a distinct style. This happens **whether or not the session is still in chat mode**,
   since the user wants replies to appear in their Pi session.
5. If the user typed more messages while waiting, they are sent as **one** combined user turn as soon as the reply lands,
   joined in order with a blank line between them. *(My call. It keeps the history alternating user/assistant, which some
   providers require.)* Whichever Pi process settles the reply sends the queue, even if that session isn't in chat mode
   or Pi was closed in between. The user already chose to send those messages, and the queue lives in `thread.json` so it
   is never stranded. *(My call.)*
6. If the job fails or comes back corrupt, the turn is marked failed and shown with the error and `/batch chat retry`.
   The user's message stays in the thread. Queued messages stay queued until a retry succeeds.

### Replies when Pi is closed, or in another session

- Jobs are reconciled by the existing poller in whichever Pi session is open in that project. Chat jobs are recognised
  in the settle path (`BatchService.onSettled` → `BatchRuntime.onSettled`) and appended to their thread there.
- A reply that settles while no session is open is appended on the next reconcile. If the user isn't in that thread,
  they get a one-line notification ("💬 reply in <thread>"), and it is shown when they enter the thread.
- Whether to also display such a reply inline in an unrelated session's transcript: show it inline only if that session
  is in chat mode on that thread. Otherwise just notify. *(My call, to avoid surprise walls of text.)*
- **Several Pi processes on one project.** `onSettled` fires only in the process that settled the job, so display can't
  rely on it. Instead, a session in chat mode checks its thread's `transcript.jsonl` on each poller tick and displays
  any entries it hasn't shown yet, tracked by entry ID. The settling process only appends to the thread. Whichever
  session is in chat mode on that thread does the displaying, whether or not it settled the job. *(My call.)*

### Display and isolation

- Chat is displayed with `pi.appendEntry("pi-batch-chat", …)` and a matching `registerEntryRenderer`. A `role` field says
  whether an entry is the user's message, a reply, or a status line. Entries are never sent to the LLM, so no `context`
  filter is needed, and Pi's own compaction can't pass chat content to the live model.
- The extension's live-model tools (`src/tools.ts`: `batch_check_jobs`, `batch_get_items`, `artifact_*`) **exclude chat
  jobs**, so the live model can't reach chat content through the extension. *(My call.)*
- **Out of scope:** the live model's general file-read tool could open `.pi/batches/threads/*` if asked to. Isolation
  means the extension never hands chat content to the live model. It does not mean protecting the files on disk.
  *(My call.)*
- The thread files are the source of truth. Entries in the Pi session are display copies only.

### Model switching

- The thread stores a current model. `/batch chat model <slug>` changes it, with the same `:batch` suffix normalisation
  as elsewhere (`normalizeBatchModelSlug`).
- Each assistant message records `model`. Each reply's header shows it, so a thread with switches is readable later.
- A switch is recorded in the thread as an event, not as a message sent to the model.
- Model eligibility is decided by OpenRouter, as elsewhere. If the new model has no batch endpoint, the turn fails with
  the provider's error and the user can switch back.

### Compaction

- **The compacted form.** A thread may hold one `summary` covering messages 1…N. A request then sends: system prompt,
  the summary (as a clearly marked context message), and messages N+1… The full transcript is never changed or deleted.
- **Manual.** `/batch chat compact [instructions]` submits a compaction job. The job contains everything except the most
  recent exchanges, with an instruction to summarise faithfully: decisions, facts, open questions, and the user's stated
  preferences. As with Claude Code's `/compact`, the user's optional instructions are appended to steer the focus. It is a one-request batch job using the thread's current model.
- **Automatic.** After a reply lands, if the estimated size of the next request (characters ÷ 4, as an estimate) is over
  `chat.autoCompactTokens`, a compaction job starts in the background.
- **Never waits twice.** While compaction is running, the thread shows "compacting". Any message sent in the meantime goes
  out at once with the current (uncompacted) history. When the compaction job lands, its summary is adopted only if it
  still covers a prefix of the thread, and it takes effect from the next request.
- **Failure.** A failed compaction leaves the thread as it was and shows a warning. Auto-compaction does not retry in a
  loop. It tries again only after the next reply. *(My call.)*
- Compaction re-summarises incrementally. A new compaction's input is the previous summary plus the messages since,
  minus the kept recent exchanges.

### New config keys (`chat.*`)

Defaults are my calls, and the builder may tune them:

| Key | Default | Meaning |
|---|---|---|
| `chat.autoCompact` | `true` | Enable automatic compaction. |
| `chat.autoCompactTokens` | `60000` | Estimated request size that triggers automatic compaction. |
| `chat.keepRecentExchanges` | `4` | Exchanges left out of compaction and always sent verbatim. |
| `chat.systemPrompt` | short neutral assistant prompt | System prompt for chat turns. |

## Storage (shape, not schema)

Under the existing storage root (`.pi/batches/` by default):

```
.pi/batches/threads/<thread-id>/
  thread.json        # atomic snapshot: id, title, model, account, providerPin?, createdAt, updatedAt,
                     #   pendingJobId?, compactingJobId?, queued[], summary? {text, coversThrough, jobId}
  transcript.jsonl   # append-only: user / assistant / model-switch / compaction / failure events,
                     #   each with timestamp; assistant entries carry model, jobId, usage
```

- Writes use the existing atomic-write helpers (`src/fsutil.ts`). Thread updates take a file lock, like jobs, because two
  Pi processes on the same project may both reconcile.
- Each chat job's manifest records which thread and turn it belongs to, so the settle path can find the thread and
  `/batch show` can say "chat turn in <thread>".
- How chat jobs are told apart in the manifest (`kind: "chat"` / `"chat-compact"`, or a `chat` linkage field like
  `synthesis`) is left to the builder. **Constraint:** an older build reading a chat job must not mishandle it. Follow the
  precedent of `DATASET_MANIFEST_SCHEMA_VERSION` (bump the schema version for the jobs only newer builds understand).

## Interaction with existing commands

- Chat jobs appear in `/batch list`, `/batch show`, `/batch view` and the footer badge like any job. *(The builder may
  choose to label them or filter them out of the default list, but must not hide them entirely.)*
- `/batch inject` must refuse chat jobs, since injecting would break isolation. The same applies to `/batch artifact`
  and the extension's LLM tools (see Display and isolation).
- `/batch retry <id>` on a chat job should go through `/batch chat retry` semantics, so the thread stays consistent, or
  refuse with a pointer to it.
- `/batch cancel` on a pending chat job marks the turn failed in the thread.

## Testing expectations

Follow the existing pattern (`test/*.test.ts` with `test/fixtures/fake-openrouter.ts`):

- Isolation: chat is written only as session entries (never `sendMessage`), and the extension's LLM tools, `/batch inject`
  and `/batch artifact` exclude or refuse chat jobs.
- The secret scan refuses a message before anything is written to the thread or queue.
- A turn's lifecycle covers submit → settle → append → display, including settling after a simulated restart and
  settling in a different process from the one displaying (the transcript-watch path).
- Queued messages are combined into one turn after a reply.
- Model switches record the right model per reply.
- Thread lookup by ID suffix or title, provisional titles, auto-retitle riding along as a second item (a failed title item
  doesn't fail the turn, and a manual rename locks the title), `continue` choosing the most recent thread, and `clear` leaving
  the old thread resumable.
- `.pi/BATCH_CHAT.md` is included in the system prompt, and a secret in it blocks sends.
- Compaction: manual (with and without instructions), automatic trigger, message sent during compaction (no wait, summary applied afterwards),
  compaction failure (thread unchanged), and that the transcript is never rewritten.
- `/batch inject` refuses chat jobs.

## Left to the builder

- Module layout. A `src/chat/` folder alongside `src/workflows/` is suggested.
- The exact manifest representation of chat jobs, within the compatibility constraint above.
- The picker UI, using whatever Pi TUI component fits (see `src/dashboard.ts` for existing TUI usage).
- Wording of the system and compaction prompts.
- Renderer styling, within "visibly distinct from live-model messages, labelled with the model".
- README documentation, in the existing style.
