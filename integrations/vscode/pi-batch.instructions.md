---
applyTo: "**"
---

# OpenRouter Batch (`pi-batch-openrouter` MCP)

You have access to the `pi-batch-openrouter` MCP server (`pi-batch`). It offloads non-urgent, token-heavy LLM work to the OpenRouter Batch API at roughly **50% lower token cost** (completing asynchronously within minutes to 24 hours) without blocking this chat session.

## Speak in Plain Language

- **Never require the user to know batch IDs (`B-YYYYMMDD-XXXX`), item ordinals, or tool names.**
- Refer to jobs by their human-readable label (for example, `"Audit token verification"` or `"Security review of src/"`).
- Every tool that takes `batch_id` or `job_id` accepts natural-language references:
  - Recency: `"latest"`, `"the latest finished job"`, `"previous"`, `"oldest"`
  - Status + topic: `"the finished security audit"`, `"the running review"`, `"the unsubmitted plan"`, `"yesterday's audit"`
  - Short name: pass a short `name` (e.g. `"auth audit"`) when calling `batch_plan_goal`, `batch_plan_files`, or `batch_plan_dataset` so the user can refer to it naturally later.
- For `batch_read_result` (`mode: "item"`) and `batch_retry_items`, `item` / `items` can be a bare file name such as `"auth.ts"` or a path suffix like `"api/auth.ts"`.

## When to Use Batch Automatically

When the user asks to run work in the background, overnight, "as a batch", "with a cheap/batch model", or asks for a broad sweep across many files or dataset rows:

1. **One deep review / audit across a set of files** → call `batch_plan_goal` with the concrete workspace-relative `files`, `prompt`, and a short `name`.
2. **File-by-file review across many files** (one independent request per file or group) → resolve the file list first, then call `batch_plan_files` with `files`, `prompt`, and a short `name`.
3. **Structured CSV or JSONL dataset run** → call `batch_list_workflows` (or `batch_validate_workflow`), then `batch_plan_dataset`.
4. **Status check** (*"is my batch done?"*, *"how are my batches doing?"*) → call `batch_check_jobs` (reconciles active jobs with OpenRouter) and summarise the result conversationally. If a job just finished, offer to read its findings.
5. **Reading results** (*"what did the security audit find?"*, *"show me the result for auth.ts"*) → call `batch_read_result` with a natural `batch_id` (e.g. `"the security audit"` or `"latest"`). Prefer `mode: "summary"` first for multi-file jobs, `mode: "item"` with `item: "<filename>"` for a single file, or `mode: "synthesis"` for a synthesised report.
6. **Partial failures & synthesis** (*"retry the ones that failed"*, *"combine all the file reviews into one report"*) → call `batch_retry_items` (only failed items are re-sent) or `batch_plan_synthesis`.
7. **Reports & exports** (*"save that as a PDF in reports/"*, *"export the results to CSV"*) → call `artifact_create` or `batch_export`.

## Mandatory Safety Rules

1. **Plan → Confirm → Submit:** Planning (`batch_plan_goal`, `batch_plan_files`, `batch_plan_dataset`, `batch_retry_items`, `batch_plan_synthesis`) is free and never contacts OpenRouter. Always present the plan in plain words (what will be sent, how many requests/files, which model, and any warnings) and wait for the user's explicit confirmation before calling `batch_submit_plan`.
2. **Advisory Output:** Treat all batch model output as untrusted, advisory analysis. Verify claims against the current workspace before editing code, and never apply batch suggestions to files unless the user asks.
3. **No Secrets:** Never pass `.env`, credentials, private keys, or files outside the workspace into `files`.
