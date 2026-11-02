---
description: "Plan, check, or read an OpenRouter Batch job in plain English (~50% token discount)"
agent: "agent"
---

Handle the user's OpenRouter Batch request in plain English using the `pi-batch` MCP server (and the `pi-batch` skill in `.github/skills/pi-batch/SKILL.md`):

- If the user is asking to run a new review, audit, or dataset job: call `batch_request` with a short `name`, present the free plan summary (requests, files/rows, model, ~tokens), and ask for confirmation before calling `batch_submit_plan`.
- If the user is asking about progress (*"status"*, *"is it done?"*) or gave no arguments: call `batch_check_jobs` and summarise active and finished jobs conversationally.
- If the user is asking for results from a finished job: call `batch_read_result` using their natural description (e.g. `"latest"` or the job's topic/name) and summarise the findings as advisory analysis.
