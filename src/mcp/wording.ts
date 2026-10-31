/**
 * Service and policy messages are written for the Pi terminal (they name `/batch …` and `/artifact …` commands).
 * The MCP server rewrites those command hints in its tool/resource text and errors so MCP clients (VS Code Copilot,
 * Claude Code, Antigravity) see the corresponding MCP tool names instead of Pi slash commands.
 */
const MCP_WORDING: ReadonlyArray<readonly [RegExp, string]> = [
  // DuplicateActiveRequestError (src/service.ts)
  [/Use \/batch show (\S+)\r?\n\(Use \/batch retry \1 to deliberately run it again\.\)/g, "Check it with batch_check_jobs (batch_id: $1)."],
  // JobNotFoundError (src/registry.ts)
  [/Use \/batch list to see known jobs\./g, "Use batch_list_jobs to see known jobs."],
  // resolveItem (src/items.ts)
  [/\(see \/batch items\)/g, "(see batch_get_items)"],
  // describeItems (src/service.ts)
  [/Details: \/batch item (\S+) <n>/g, 'Details: batch_read_result (batch_id: "$1", mode: "item", item: "<n>")'],
  // describeItem (src/service.ts)
  [/\(batch-level usage only; see \/batch show\)/g, "(batch-level usage only; see batch_check_jobs)"],
  // read (src/service.ts)
  [/Use \/batch check to reconcile now\./g, "Use batch_check_jobs to reconcile now."],
  // multiItemOverview (src/service.ts)
  [/Full results: \/batch read (\S+) --item <n>\s+·\s+all items: \/batch read \1 --items/g, 'Full results: batch_read_result (batch_id: "$1", mode: "item", item: "<n>") or mode: "full"'],
  // readSynthesis (src/service.ts)
  [/Create one with \/batch synthesize (\S+)\./g, 'Plan one with batch_plan_synthesis (batch_id: "$1").'],
  // buildInjection (src/service.ts)
  [
    /Nothing was injected\. Choose explicitly:\r?\n\s+\/batch inject (\S+)(?: --item (\S+))? --summary[^\r\n]*\r?\n\s+\/batch inject \1[^\r\n]*/g,
    'Pass mode: "summary" (bounded excerpt) or mode: "full" (complete result) to batch_read_result.',
  ],
  [/\r?\n\s+\/batch inject \S+ --item <n>\s+one item/g, '\nOr pass mode: "item" with item: "<n>" for one item.'],
  // synthesis refusal (src/service.ts)
  [/Retry them first \(\/batch retry-items (\S+) --failed\) or pass --allow-partial/g, 'Retry the failed items first (batch_retry_items with batch_id: "$1", failed: true) or pass allow_partial: true'],
  // privacy (src/privacy/*.ts, src/openrouter/routing.ts, src/service.ts)
  [/\(run \/batch privacy refresh\)/g, "(refresh the model catalog in Pi or the web UI: /batch privacy refresh)"],
  [/; \/batch privacy refresh retries\)/g, "; /batch privacy refresh in Pi or the web UI retries)"],
  [/\(needs \/batch privacy attest\)/g, "(needs the no-training attestation in Pi or the web UI: /batch privacy attest)"],
  [/\(\/batch privacy attest\)/g, "(attest in Pi or the web UI: /batch privacy attest)"],
  [/consider \/batch privacy zdr/g, "consider setting privacy.level to zdr in .pi/batch.config.json (or /batch privacy zdr in Pi)"],
  // free models outside chat
  [/Free models run only in batch chat \(\/batch chat\); \/batch ask and workflows need a batch model/g, "Free models run only in Batch Chat; batch jobs and workflows need a batch model"],
  // chat job guard (src/service.ts)
  [/use \/batch chat instead\./g, "batch chat jobs are managed only in Pi (/batch chat) or the web UI."],
];

/** Rewrites Pi slash-command hints in `text` to name MCP tools instead. */
export function mcpWording(text: string): string {
  let out = text;
  for (const [pattern, replacement] of MCP_WORDING) out = out.replace(pattern, replacement);
  return out;
}
