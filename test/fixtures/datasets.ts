import { tempWorkspace, writeFiles } from "../helpers.js";

export const CLASSIFY_YAML = `schemaVersion: 1
name: classify-tickets
description: Classify support tickets
model:
  default: openai/gpt-oss-20b
input:
  type: csv
  idField: ticket_id
  fields:
    - title
    - description
request:
  prompt: |
    Classify this ticket.

    Title:
    {{title}}

    Description:
    {{description}}
output:
  type: json
  schema:
    type: object
    additionalProperties: false
    required: [category, rationale]
    properties:
      category: { type: string, enum: [billing, bug, other] }
      rationale: { type: string }
synthesis:
  enabled: true
limits:
  maxRequests: 10
  maxCharactersPerItem: 100000
`;

export const TICKETS_CSV =
  "ticket_id,title,description,customer_email\r\n" +
  'T-1001,Refund not received,"I was charged twice, please refund.",a@example.invalid\r\n' +
  'T-1002,App crashes,"Crash on start: ""NullPointer"" in {{title}}",b@example.invalid\r\n' +
  "T-1003,Question,How do I export data?,c@example.invalid\r\n";

export function datasetWorkspace(extra: Record<string, string> = {}): string {
  const root = tempWorkspace("pi batch ds-");
  writeFiles(root, { ".pi/batch-workflows/classify-tickets.yaml": CLASSIFY_YAML, "data/tickets.csv": TICKETS_CSV, ...extra });
  return root;
}
