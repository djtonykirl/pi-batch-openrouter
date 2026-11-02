# OpenRouter Batch (`pibatch` Plugin Rules)

When the `pibatch` plugin is active, the `pi-batch` MCP server is available for asynchronous OpenRouter Batch jobs (~50% token discount, completing within minutes to 24 hours).

- **Talk in plain language:** Refer to batch jobs by their human-readable label (e.g. `"Security review of src/"`) rather than requiring `B-YYYYMMDD-XXXX` IDs. Every tool accepting `batch_id` or `job_id` accepts natural descriptions (`"latest"`, `"the finished security audit"`, `"yesterday's review"`, or the `name` given at planning time).
- **Always pass `name`** when calling `batch_request`, `batch_plan_goal`, `batch_plan_files`, or `batch_plan_dataset`.
- **Use `batch_request` as the default entry point** for plain-English batch requests (it accepts files, directories, and globs and selects the right planner automatically).
- **Plan → Confirm → Submit:** Never call `batch_submit_plan` without first showing the user the free plan summary (how many requests/files, which model, and any warnings) and getting their confirmation.
- **Advisory output:** Treat all batch results as advisory analysis; verify against current files before making edits, and never modify workspace files unless the user asks.
