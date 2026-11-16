---
name: pi-batch
description: >-
  Offload non-urgent, token-heavy code reviews, multi-file audits, and CSV/JSONL dataset runs to the
  OpenRouter Batch API (~50% token discount) via the pi-batch MCP server, check batch job progress,
  read results by name or description, retry failed items, synthesise multi-file results, and export
  reports. Also plans Databricks / Unity Catalog table descriptions and column comments from a
  tables file, and holds asynchronous multi-turn chats with another model. Use whenever the user
  mentions batch jobs, Databricks or UC metadata, asking another model, background/overnight reviews, checking if a
  batch is done, or reading findings from a previous batch run.
---

# Natural-Language OpenRouter Batch (`pi-batch` MCP)

Use the `pi-batch` MCP tools to plan, submit, track, and read asynchronous OpenRouter Batch jobs (~50% lower token cost, completing within minutes to 24h) while keeping the conversation in plain English.

## Conversational Rules

1. **No IDs required from the user:** Never ask the user for a `B-YYYYMMDD-XXXX` ID or item ordinal. Every tool accepting `batch_id` or `job_id` resolves natural descriptions:
   - `"latest"`, `"the latest finished job"`, `"previous"`
   - `"the security audit"`, `"yesterday's review"`, `"the unsubmitted plan"`
   - Any short `name` you gave when planning the job (always pass `name` to `batch_plan_goal`, `batch_plan_files`, and `batch_plan_dataset`).
2. **File names work as item selectors:** When calling `batch_read_result` with `mode: "item"` or `batch_retry_items`, you can pass a file name like `"auth.ts"` or `"src/auth.ts"`.
3. **Plan → Confirm → Submit:** Planning is free and read-only. After calling `batch_plan_*`, `batch_retry_items`, or `batch_plan_synthesis`, summarise the plan in one or two sentences (request count, files/rows, model, warnings) and ask the user whether to submit before calling `batch_submit_plan`.
4. **Advisory results:** Batch output is advisory analysis. Verify findings against current workspace files before editing code, and never modify files unless asked.
5. **Databricks metadata has its own tools:** Any request for Databricks / Unity Catalog table descriptions or column comments goes through `metadata_plan` (or `batch_request`, which routes it there). The generic planners skip the per-table evidence validation, the UC standards and the PII rules.
6. **Chat with another model is asynchronous and budgeted:** `chat_start` records the user's agreement to a model and a number of billed turns; `chat_send` then needs no further confirmation until that budget is used. Only threads started this way are visible; the user's own Pi and web UI chats are not.

## Mapping User Requests to Tools

| When the user says… | What to do |
| --- | --- |
| *"Summarise each markdown file in `docs/`"* or *"Do a deep security audit of `src/` in a batch"* | Call `batch_request` with `request`, optional `files` (files, directories, or globs like `"docs/*.md"`), and `name`, explain the plan, and ask to submit. |
| *"Run the `classify-tickets` workflow over `data/tickets.jsonl`"* | Call `batch_request` (or `batch_plan_dataset`) with `name`, explain the row/request count, and ask to submit. |
| *"Yes, submit it"* / *"Go ahead"* | Call `batch_submit_plan` with `batch_id: "latest"` (or the plan's name). |
| *"Is my batch done?"* / *"Check on my batches"* | Call `batch_check_jobs` (no arguments, or with the job's name/description). If a job is ready, offer to summarise its findings. |
| *"What did the security audit find?"* | Call `batch_read_result` with `batch_id: "the security audit"` (or `"latest"`), `mode: "summary"`, and summarise the findings. |
| *"What did it say about `auth.ts`?"* | Call `batch_read_result` with `batch_id: "latest"`, `mode: "item"`, `item: "auth.ts"`. |
| *"Retry the files that failed and then combine everything"* | Call `batch_retry_items` (`batch_id: "latest"`, `failed: true`) → confirm & submit → once ready, call `batch_plan_synthesis` → confirm & submit. |
| *"Save the report as a PDF in `reports/audit.pdf`"* | Call `artifact_create` with `job_id: "latest"`, `format: "pdf"`, `out: "reports/audit.pdf"`. |
| *"Cancel the running batch"* | Call `batch_cancel` with `batch_id: "latest running"`. |
| *"Write column comments for the tables in `metadata/finance/tables.jsonl`"* / *"Generate UC metadata for the finance tables"* | Call `metadata_plan` with `input`, `context` (the reviewed domain context `.md`) and `name`. If the user did not say which context file, leave `context` out and ask them to choose from the candidates the error lists. For standards-compliant metadata ask for `domain` and `uc_prefix`. Explain the plan (tables, model, standards mode, whether sample values are sent) and ask to submit. Never use `batch_plan_goal`, `batch_plan_files` or `batch_plan_dataset` for this. |
| *"How did the metadata job go?"* / *"Write up the review"* / *"Give me the handoff file"* | Call `metadata_summary`, `metadata_write_review`, or `metadata_write_approved` (needs `out`, a `.jsonl` path) with `batch_id: "latest"`. The handoff is a draft for a human reviewer; after they edit it call `metadata_validate_approved`. Nothing is applied to Databricks. |
| *"Ask another model about this and get back to me"* / *"Discuss the caching design with Gemini over a few turns"* | Agree the model and a number of turns with the user, then call `chat_start` (`title`, `model`, `max_turns`) and `chat_send`. Replies arrive minutes to hours later: say so, and call `chat_read` when the user asks or later in the session. Do not wait in a loop. |
| *"Did it answer yet?"* / *"What did it say?"* | Call `chat_read` (`thread: "latest"` or the thread's title). If a turn failed, `chat_send` with `retry: true`. |
