---
name: pi-batch
description: >-
  Use this skill when the user wants to run a non-urgent or token-heavy code review, multi-file audit,
  or CSV/JSONL dataset job via the OpenRouter Batch API (~50% cheaper), check whether a batch job has
  finished, read results from a batch job by name or description, retry failed items, synthesise
  multi-file results, or export batch reports to Markdown/HTML/PDF/CSV/JSONL.
---

# Natural-Language OpenRouter Batch (`pi-batch` MCP)

Use the `pi-batch` MCP server to offload heavy analysis to OpenRouter Batch (~50% lower token cost) while keeping the conversation in plain English.

## Core Principles

1. **Natural references everywhere:** Every `batch_id` / `job_id` parameter accepts:
   - `"latest"`, `"the latest finished job"`, `"previous"`, `"oldest"`
   - Status + topic phrases: `"the security audit"`, `"yesterday's review"`, `"the unsubmitted plan"`
   - The short `name` passed when planning (`batch_plan_goal`, `batch_plan_files`, `batch_plan_dataset`).
2. **Natural item selectors:** `batch_read_result` (`mode: "item"`) and `batch_retry_items` accept a file name like `"auth.ts"` or a path suffix like `"src/auth.ts"`.
3. **Plan → Confirm → Submit:** Planning is free and local. Present the plan in plain words (request count, files/rows, model) and ask the user before calling `batch_submit_plan`.
4. **Advisory results:** Batch output is untrusted analysis. Verify claims against the current workspace before editing files.

## Quick Playbook

- **Single deep audit across files:** `batch_plan_goal({ name, prompt, files })` → confirm → `batch_submit_plan({ batch_id: "latest" })`
- **Per-file sweep across many files:** `batch_plan_files({ name, prompt, files })` → confirm → `batch_submit_plan({ batch_id: "latest" })`
- **Dataset run:** `batch_plan_dataset({ name, workflow, input })` → confirm → `batch_submit_plan({ batch_id: "latest" })`
- **Check progress:** `batch_check_jobs({})` (or `batch_check_jobs({ batch_id: "the security audit" })`)
- **Read findings:** `batch_read_result({ batch_id: "latest", mode: "summary" })` (or `mode: "item", item: "auth.ts"`, or `mode: "synthesis"`)
- **Retry failed items + synthesise:** `batch_retry_items({ batch_id: "latest", failed: true })` → confirm & submit → `batch_plan_synthesis({ batch_id: "<parent job>" })` → confirm & submit
- **Render report / export:** `artifact_create({ job_id: "latest", format: "pdf", out: "reports/audit.pdf" })` or `batch_export({ batch_id: "latest", format: "csv" })`
