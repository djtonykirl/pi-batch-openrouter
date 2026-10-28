/**
 * Messages are written for the terminal (they name /batch commands and flags). The web page has buttons instead, so
 * the web server rewrites the known command hints in what it sends to the page, in this one place. Messages stay
 * unchanged everywhere else (CLI output, stored transcripts, documents such as review.md).
 */
const WEB_WORDING: ReadonlyArray<readonly [RegExp, string]> = [
  // metadata approved handoff refusal (src/metadata/outputs.ts)
  [
    /Retry them \(\/batch retry-items \S+ --failed\), or pass --allow-partial to include them/g,
    "Retry the failed items (Retry Failed Items button on this job), or tick Allow partial to include them",
  ],
  // synthesis refusal (src/service.ts)
  [/Retry them first \(\/batch retry-items \S+ --failed\) or pass --allow-partial/g, "Retry the failed items first (Retry Failed Items button on the source job) or allow partial results"],
  // chat: a turn that may have reached OpenRouter (SUBMISSION_UNKNOWN_ADVICE)
  [/use \/batch chat retry --force \(a plain retry is refused/g, "use Retry anyway (a plain retry is refused"],
  // chat: other turn failures
  [/Use \/batch chat retry\./g, "Use Retry Turn."],
  [/, then \/batch chat retry\./g, ", then use Retry Turn."],
  [/Do not resubmit before checking \/batch show (\S+?)\./g, "Do not resubmit before checking job $1 (Inspect)."],
  // privacy: catalog refresh, attestation and level (src/privacy/*.ts, src/openrouter/routing.ts, src/service.ts)
  [/\(run \/batch privacy refresh\)/g, "(use Refresh models)"],
  [/; \/batch privacy refresh retries\)/g, "; Refresh models retries)"],
  [/\(needs \/batch privacy attest\)/g, "(needs the no-training attestation in Workspace & Settings)"],
  [/\(\/batch privacy attest\)/g, "(attest in Workspace & Settings)"],
  [/consider \/batch privacy zdr/g, "consider setting the privacy level to zdr in Workspace & Settings"],
  // free models outside chat (IMMEDIATE_CHAT_ONLY)
  [/Free models run only in batch chat \(\/batch chat\); \/batch ask and workflows need a batch model/g, "Free models run only in Batch Chat; batch jobs and workflows need a batch model"],
];

/** The page's wording of a message: terminal command hints replaced by the matching page controls. */
export function webWording(text: string): string {
  let out = text;
  for (const [pattern, replacement] of WEB_WORDING) out = out.replace(pattern, replacement);
  return out;
}

/** Keys whose string (or string-array) values are messages for the page (plus privacy.reason and catalog.text). */
const MESSAGE_KEYS = new Set(["error", "warning", "notice", "blocked", "defaultModelRefusal", "warnings", "blockers"]);

/**
 * A JSON payload with webWording applied to its message fields (by key name, at any depth). Other strings, such as
 * transcript text, model output and file contents, are left exactly as they are.
 */
export function webWordingPayload(value: unknown, parentKey = ""): unknown {
  if (Array.isArray(value)) return value.map((v) => (typeof v === "string" ? (MESSAGE_KEYS.has(parentKey) ? webWording(v) : v) : webWordingPayload(v, parentKey)));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const isMessage = MESSAGE_KEYS.has(k) || (k === "text" && parentKey === "catalog") || (k === "reason" && parentKey === "privacy");
    out[k] = typeof v === "string" ? (isMessage ? webWording(v) : v) : webWordingPayload(v, k);
  }
  return out;
}
