/**
 * Artifact formats and the file-extension policy.
 *
 * Every artifact file is written by a trusted local renderer in this process;
 * nothing is executed and no external program or service is involved.
 *
 *   markdown  UTF-8 Markdown (.md, .markdown)
 *   html      self-contained HTML from Markdown (.html, .htm): raw HTML escaped,
 *             no scripts, no remote resources (Content-Security-Policy as well)
 *   pdf       PDF laid out locally by pdfkit from Markdown (.pdf)
 *   text      the source content itself, unchanged, as a non-executable text file
 *             (.txt, .md, .json, .csv, .yaml, .yml, .sql)
 *
 * Extensions are an ALLOWLIST: anything else is refused, including every
 * executable or script type (.ps1, .sh, .bat, .cmd, .exe, .dll, .com, .msi,
 * .js, .py, …). Generated code is not materialised as an artifact in this release.
 */

export const ARTIFACT_FORMATS = ["markdown", "html", "pdf", "text"] as const;
export type ArtifactFormat = (typeof ARTIFACT_FORMATS)[number];

export const FORMAT_EXTENSIONS: Record<ArtifactFormat, readonly string[]> = {
  markdown: [".md", ".markdown"],
  html: [".html", ".htm"],
  pdf: [".pdf"],
  text: [".txt", ".md", ".json", ".csv", ".yaml", ".yml", ".sql"],
};

/** Default extension for an internal (no --out) destination. */
export const DEFAULT_EXTENSION: Record<ArtifactFormat, string> = { markdown: ".md", html: ".html", pdf: ".pdf", text: ".txt" };

/** Never valid for any artifact, named so refusals can say why. */
const EXECUTABLE = new Set([
  ".ps1", ".psm1", ".psd1", ".sh", ".bash", ".zsh", ".bat", ".cmd", ".exe", ".dll", ".com", ".msi", ".scr", ".vbs", ".vbe",
  ".js", ".mjs", ".cjs", ".jse", ".wsf", ".wsh", ".hta", ".py", ".pyw", ".rb", ".pl", ".php", ".jar", ".lnk", ".reg", ".app", ".so", ".dylib",
  ".docm", ".xlsm", ".pptm",
]);

export function isArtifactFormat(v: string): v is ArtifactFormat {
  return (ARTIFACT_FORMATS as readonly string[]).includes(v);
}

export function extensionOf(p: string): string {
  const base = p.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

/** Problems with writing `format` to a file named `p` (empty = OK). */
export function extensionProblem(format: ArtifactFormat, p: string): string | undefined {
  const ext = extensionOf(p);
  if (EXECUTABLE.has(ext)) return `${ext} files are executable or scriptable and are never written as artifacts`;
  if (!ext) return `the output path needs a file extension (${FORMAT_EXTENSIONS[format].join(", ")} for ${format})`;
  if (!FORMAT_EXTENSIONS[format].includes(ext)) return `${ext} is not allowed for ${format} artifacts (allowed: ${FORMAT_EXTENSIONS[format].join(", ")})`;
  return undefined;
}
