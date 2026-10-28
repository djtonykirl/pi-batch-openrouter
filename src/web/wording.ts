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
  // chat: a turn that may have reached OpenRouter (SUBMISSION_UNKNOWN_ADVICE)
  [/use \/batch chat retry --force \(a plain retry is refused/g, "use Retry anyway (a plain retry is refused"],
  // chat: other turn failures
  [/Use \/batch chat retry\./g, "Use Retry Turn."],
  [/, then \/batch chat retry\./g, ", then use Retry Turn."],
  [/Do not resubmit before checking \/batch show (\S+?)\./g, "Do not resubmit before checking job $1 (Inspect)."],
];

/** The page's wording of a message: terminal command hints replaced by the matching page controls. */
export function webWording(text: string): string {
  let out = text;
  for (const [pattern, replacement] of WEB_WORDING) out = out.replace(pattern, replacement);
  return out;
}
