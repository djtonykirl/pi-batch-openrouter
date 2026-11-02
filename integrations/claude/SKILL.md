---
name: pi-batch
description: >-
  Offload non-urgent, token-heavy code reviews, multi-file audits, and CSV/JSONL dataset runs to the
  OpenRouter Batch API (~50% token discount) via the pi-batch MCP server, check batch job progress,
  read results by name or description, retry failed items, synthesise multi-file results, and export
  reports. Use whenever the user mentions batch jobs, background/overnight reviews, checking if a
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

## Mapping User Requests to Tools

| When the user says… | What to do |
| --- | --- |
| *"Do a deep security/architecture audit of `src/` in a batch"* | Find the relevant files, call `batch_plan_goal` with `name`, explain the plan, and ask to submit. |
| *"Review every file in `src/api/` for error handling as a batch"* | Expand the file list, call `batch_plan_files` with `name`, explain the plan, and ask to submit. |
| *"Run the `classify-tickets` workflow over `data/tickets.jsonl`"* | Call `batch_plan_dataset` with `name`, explain the row/request count, and ask to submit. |
| *"Yes, submit it"* / *"Go ahead"* | Call `batch_submit_plan` with `batch_id: "latest"` (or the plan's name). |
| *"Is my batch done?"* / *"Check on my batches"* | Call `batch_check_jobs` (no arguments, or with the job's name/description). If a job is ready, offer to summarise its findings. |
| *"What did the security audit find?"* | Call `batch_read_result` with `batch_id: "the security audit"` (or `"latest"`), `mode: "summary"`, and summarise the findings. |
| *"What did it say about `auth.ts`?"* | Call `batch_read_result` with `batch_id: "latest"`, `mode: "item"`, `item: "auth.ts"`. |
| *"Retry the files that failed and then combine everything"* | Call `batch_retry_items` (`batch_id: "latest"`, `failed: true`) → confirm & submit → once ready, call `batch_plan_synthesis` → confirm & submit. |
| *"Save the report as a PDF in `reports/audit.pdf`"* | Call `artifact_create` with `job_id: "latest"`, `format: "pdf"`, `out: "reports/audit.pdf"`. |
| *"Cancel the running batch"* | Call `batch_cancel` with `batch_id: "latest running"`. |
