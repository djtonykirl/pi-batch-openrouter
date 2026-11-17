---
applyTo: "**"
---

# OpenRouter Batch (`pi-batch` MCP)

- For deferred/background reviews, multi-file sweeps, dataset runs, Databricks / Unity Catalog metadata proposals, asynchronous multi-turn model chats, or batch status/result questions, activate the **`pi-batch`** skill (`.github/skills/pi-batch/SKILL.md`).
- Speak in plain language: refer to jobs by their human-readable label or description (`"latest"`, `"the security audit"`) rather than `B-YYYYMMDD-XXXX` IDs.
- For Databricks / Unity Catalog table descriptions and column comments use `metadata_plan` (never the generic planners), then `metadata_summary`, `metadata_write_review`, `metadata_write_approved`, and `metadata_validate_approved`. Nothing is applied to Databricks.
- For a multi-turn conversation with another model whose answers can wait, agree the model and number of turns with the user, then use `chat_start`, `chat_send` and `chat_read`.
- Always plan first (`batch_request`), show the plan summary, and wait for explicit user confirmation before calling `batch_submit_plan`. Treat batch output as advisory analysis.
