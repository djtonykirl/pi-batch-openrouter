---
applyTo: "**"
---

# OpenRouter Batch (`pi-batch` MCP)

- For deferred/background reviews, multi-file sweeps, dataset runs, or batch status/result questions, activate the **`pi-batch`** skill (`.github/skills/pi-batch/SKILL.md`).
- Speak in plain language: refer to jobs by their human-readable label or description (`"latest"`, `"the security audit"`) rather than `B-YYYYMMDD-XXXX` IDs.
- Always plan first (`batch_request`), show the plan summary, and wait for explicit user confirmation before calling `batch_submit_plan`. Treat batch output as advisory analysis.
