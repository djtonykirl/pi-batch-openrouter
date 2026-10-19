/** Artifact template fixtures (data only). */

export const REPORT_TEMPLATE = `schemaVersion: 1
name: report
description: Wraps a synthesis or result in a report
input:
  type: text
body: |
  # Architecture review

  {{content}}

  ---
  Generated from validated batch results.
`;

export const FINDINGS_TEMPLATE = `schemaVersion: 1
name: findings-report
input:
  type: json
  schema:
    type: object
    additionalProperties: false
    required: [title, executiveSummary, findings, risks, openQuestions]
    properties:
      title: { type: string }
      executiveSummary: { type: string }
      findings: { type: array, items: { type: string } }
      risks:
        type: array
        items:
          type: object
          additionalProperties: false
          required: [risk, severity]
          properties:
            risk: { type: string }
            severity: { enum: [low, medium, high] }
      openQuestions: { type: array, items: { type: string } }
body: |
  # {{title}}

  ## Executive summary

  {{executiveSummary}}

  ## Findings

  {{findings}}

  ## Risks

  {{risks}}

  ## Open questions

  {{openQuestions}}
`;
