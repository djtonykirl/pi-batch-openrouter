import * as path from "node:path";
import assert from "node:assert/strict";
import { ArtifactService, type Renderers } from "../../src/artifacts/service.js";
import { ArtifactStore } from "../../src/artifacts/store.js";
import type { BatchConfig } from "../../src/config.js";
import type { BatchService } from "../../src/service.js";
import type { JobManifest } from "../../src/types.js";
import { tempWorkspace, writeFiles } from "../helpers.js";
import { FakeOpenRouter, accepted, makeConfig, makeService } from "./fake-openrouter.js";
import { completed, successItem } from "./openrouter.js";
import { FINDINGS_TEMPLATE, REPORT_TEMPLATE } from "./artifact-templates.js";

export { FINDINGS_TEMPLATE, REPORT_TEMPLATE };

export const SYNTHESIS_TEXT = "## Consolidated findings\n\n- Retry logic is duplicated in **two** modules.\n- `client.ts` lacks a timeout.\n\nOpen question: is the registry shared across processes?\n";

export function artifactsFor(root: string, service: BatchService, cfg: BatchConfig = makeConfig(), renderers?: Renderers): ArtifactService {
  return new ArtifactService({ batch: service, workspaceRoot: root, getConfig: () => cfg, store: new ArtifactStore(path.join(root, ".pi", "batches", "artifacts")), ...(renderers ? { renderers } : {}) });
}

export function artifactWorkspace(extra: Record<string, string> = {}): string {
  const root = tempWorkspace("pi batch art-");
  writeFiles(root, {
    "src/a.ts": "export const a = 1;\n",
    "src/b.ts": "export const b = 2;\n",
    ".pi/artifact-templates/report.yaml": REPORT_TEMPLATE,
    ".pi/artifact-templates/findings-report.yaml": FINDINGS_TEMPLATE,
    ...extra,
  });
  return root;
}

/** A ready two-file map-files job and a ready synthesis of it, through the real service and a fake OpenRouter. */
export async function readyJobWithSynthesis(service: BatchService, fake: FakeOpenRouter, synthesisText = SYNTHESIS_TEXT): Promise<{ job: JobManifest; synthesis: JobManifest }> {
  fake.submitReplies = [accepted("batch_map")];
  const job = await service.createWorkflowJob(await service.planMapFiles({ objective: "Review", files: ["src/a.ts", "src/b.ts"], contexts: [], format: "markdown", includeInstructions: true }), { previewOnly: false });
  const [c1, c2] = job.customIds;
  fake.getReplies = [{ status: 200, body: completed([successItem(c2!, "B review: fine."), successItem(c1!, "A review: one issue.")], { id: "batch_map" }) }];
  await service.reconcile(job.localId, { force: true });
  assert.equal(service.registry.read(job.localId).localStatus, "ready");
  fake.submitReplies = [accepted("batch_syn")];
  const syn = await service.createSynthesisJob(await service.prepareSynthesis(job.localId, { allowPartial: false }), { previewOnly: false });
  fake.getReplies = [{ status: 200, body: completed([successItem(syn.customIds[0]!, synthesisText)], { id: "batch_syn" }) }];
  await service.reconcile(syn.localId, { force: true });
  assert.equal(service.registry.read(syn.localId).localStatus, "ready");
  return { job: service.registry.read(job.localId), synthesis: service.registry.read(syn.localId) };
}

export { FakeOpenRouter, makeService };
