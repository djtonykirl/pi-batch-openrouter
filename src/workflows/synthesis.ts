import { heading } from "../context/package.js";
import type { ItemSource } from "../types.js";

/**
 * Deterministic synthesis package. Coverage facts (expected / included /
 * missing) are written by this code from durable state — the synthesis model
 * is told about missing evidence, but the rendered result never relies on the
 * model to mention it (see `renderCoverage`).
 */
export const SYNTHESIS_OBJECTIVE = "Produce a consolidated analysis of the component reviews.";

export const SYNTHESIS_REQUIREMENTS = [
  "Separate common findings from file-specific findings.",
  "Preserve material disagreement.",
  "Report missing evidence.",
  "Do not imply complete repository coverage.",
  "Identify duplicated or cross-cutting concerns.",
  "Distinguish direct evidence from interpretation.",
  "Include unresolved questions.",
  "Do not invent findings for missing inputs.",
];

export interface SynthesisInputItem {
  sourceOrdinal: number;
  source: ItemSource;
  sourceLabel: string;
  customId: string;
  jobId: string;
  text: string;
}

export interface SynthesisUnusable {
  sourceOrdinal: number;
  sourceLabel: string;
  status: string;
  reason: string;
}

export interface CoverageFacts {
  sourceJobId: string;
  expected: number;
  included: number;
  failed: number;
  corrupt: number;
  missing: number;
  noResult: number;
  allowPartial: boolean;
  unusable: SynthesisUnusable[];
}

export function coverageFacts(sourceJobId: string, expected: number, included: number, unusable: SynthesisUnusable[], allowPartial: boolean): CoverageFacts {
  const count = (s: string) => unusable.filter((u) => u.status === s).length;
  return {
    sourceJobId,
    expected,
    included,
    failed: count("failed"),
    corrupt: count("corrupt"),
    missing: count("missing"),
    noResult: unusable.length - count("failed") - count("corrupt") - count("missing"),
    allowPartial,
    unusable,
  };
}

/** The coverage block, shared by the prompt and by every rendering of the synthesis result. */
export function renderCoverage(c: CoverageFacts): string {
  const lines = [
    `Source job: ${c.sourceJobId}`,
    `Expected items: ${c.expected}`,
    `Included items: ${c.included}`,
    `Failed items: ${c.failed}`,
    `Corrupt items: ${c.corrupt}`,
    `Missing items: ${c.missing}`,
    ...(c.noResult ? [`Items without a result: ${c.noResult}`] : []),
    `Partial synthesis explicitly allowed: ${c.allowPartial ? "yes" : "no"}`,
  ];
  if (c.unusable.length > 0) {
    lines.push("", "Missing or unusable sources:", ...c.unusable.map((u) => `- ${u.sourceLabel} (item ${u.sourceOrdinal}): ${u.reason}`));
    lines.push("", "Conclusions may be incomplete: the sources above were not analysed.");
  }
  return lines.join("\n");
}

export function renderSynthesisPrompt(input: { sourceObjective: string; coverage: CoverageFacts; items: readonly SynthesisInputItem[] }): string {
  const parts: string[] = [
    heading("SYNTHESIS OBJECTIVE"),
    "",
    SYNTHESIS_OBJECTIVE,
    "",
    "The component reviews below were produced for this original objective:",
    "",
    input.sourceObjective.trim(),
    "",
    heading("COVERAGE"),
    "",
    renderCoverage(input.coverage),
    "",
  ];
  for (const it of input.items) {
    const body = it.text.endsWith("\n") ? it.text.slice(0, -1) : it.text;
    parts.push(
      heading(`ITEM RESULT ${String(it.sourceOrdinal).padStart(3, "0")}`),
      "",
      `Source: ${it.sourceLabel}`,
      `Custom ID: ${it.customId}${it.jobId !== input.coverage.sourceJobId ? ` (from retry job ${it.jobId})` : ""}`,
      "Validation: valid",
      "",
      body,
      "",
      "END ITEM RESULT",
      "",
    );
  }
  parts.push(heading("SYNTHESIS REQUIREMENTS"), "", ...SYNTHESIS_REQUIREMENTS.map((r) => `- ${r}`), "");
  return parts.join("\n");
}
