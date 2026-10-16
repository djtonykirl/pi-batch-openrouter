import { Type } from "typebox";
import type { BatchRuntime } from "./runtime.js";
import { formatIsoShort } from "./time.js";

/**
 * Model-callable tools. They go through exactly the same packaging, exclusion,
 * secret-scanning and duplicate checks as `/batch ask`. They cannot apply
 * results to files; reading a result is done via its artefact path.
 */
export function registerBatchTools(rt: BatchRuntime): void {
  rt.pi.registerTool({
    name: "batch_submit_goal",
    label: "Batch Submit Goal",
    description:
      "Offloads a heavy review/analysis goal to an OpenRouter Batch job (typically ~50% cheaper, results within 24h). " +
      "Returns immediately with a local job ID once OpenRouter accepts it. Files are checked against exclusion rules and scanned for secrets first.",
    promptSnippet: "Use batch_submit_goal to run non-blocking heavy codebase audits, reviews, or long analyses.",
    promptGuidelines: [
      "Call batch_submit_goal only when the user wants work deferred/offloaded to a batch job",
      "Pass relevant workspace files explicitly in `files`; never include credentials",
      "Batch output is advisory: never apply it to files without the user asking",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "Detailed task instructions / objective" }),
      files: Type.Optional(Type.Array(Type.String(), { description: "Workspace-relative text files to include as context" })),
      model: Type.Optional(Type.String({ description: "OpenRouter model slug override (e.g. anthropic/claude-opus-5.5)" })),
      provider: Type.Optional(Type.String({ description: "Pi account/provider alias for the API key (e.g. openrouter, openrouter-work)" })),
      title: Type.Optional(Type.String({ description: "Deprecated; ignored (the prompt is the objective)" })),
    }),
    execute: async (_toolCallId, params, signal) => {
      if (signal?.aborted) throw new Error("Batch submission aborted");
      const service = rt.requireService();
      const prepared = await service.prepare({
        objective: params.prompt,
        files: params.files ?? [],
        contexts: [],
        model: params.model,
        account: params.provider,
        format: "markdown",
        includeInstructions: true,
      });
      // Throws SubmissionBlockedError / DuplicateActiveRequestError -> failed tool result (no secret values in the message).
      const job = await service.createJob(prepared, { previewOnly: false });
      rt.poller.updateBadge();
      if (job.localStatus !== "submitted") throw new Error(`Batch job ${job.localId} ${job.localStatus}: ${job.error?.message ?? "unknown error"}`);
      return {
        content: [
          {
            type: "text",
            text:
              `Batch job accepted by OpenRouter (status: ${job.providerStatus}; queued, not completed).\n` +
              `Local job ID: ${job.localId}\nProvider batch ID: ${job.providerBatchId}\nModel: ${job.model}\n` +
              `Files: ${job.context.fileCount}, characters: ${job.context.characters}\n` +
              `The user can track it with /batch show ${job.localId} and bring the result into this conversation with /batch inject ${job.localId}.`,
          },
        ],
        details: { localId: job.localId, providerBatchId: job.providerBatchId, status: job.localStatus, model: job.model },
      };
    },
  });

  rt.pi.registerTool({
    name: "batch_check_jobs",
    label: "Batch Check Jobs",
    description: "Reports status of deferred OpenRouter batch jobs from local state, reconciling active ones with OpenRouter first.",
    promptSnippet: "Use batch_check_jobs to see if an offloaded batch job has finished.",
    promptGuidelines: ["Call batch_check_jobs when the user asks about batch status or progress"],
    parameters: Type.Object({
      batch_id: Type.Optional(Type.String({ description: "Local job ID (B-YYYYMMDD-XXXX, or unique suffix) or provider batch ID" })),
    }),
    execute: async (_toolCallId, params): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> => {
      const service = rt.requireService();
      await rt.poller.checkNow(true);
      if (params.batch_id) {
        const id = service.registry.resolveId(params.batch_id);
        const job = service.registry.read(id);
        const resultPath = job.localStatus === "ready" || job.localStatus === "partial" ? service.registry.artefact(id, "resultMd") : undefined;
        return {
          content: [
            {
              type: "text",
              text: [
                `Job: ${job.localId}`,
                `Provider batch: ${job.providerBatchId ?? "-"}`,
                `Local status: ${job.localStatus}`,
                `Provider status: ${job.providerStatus ?? "-"}`,
                `Objective: ${job.objective.slice(0, 200)}`,
                job.error ? `Error: [${job.error.code}] ${job.error.message}` : "",
                job.lastPollError ? `Last poll error: ${job.lastPollError.category}: ${job.lastPollError.message}` : "",
                resultPath ? `Result (advisory, read-only): ${resultPath}` : "",
              ]
                .filter(Boolean)
                .join("\n"),
            },
          ],
          details: { localId: job.localId, localStatus: job.localStatus, providerStatus: job.providerStatus, found: true },
        };
      }
      const jobs = service.registry.list().jobs.slice(0, 20);
      const summary = jobs.map((j) => `- ${j.localId} [${j.localStatus}] ${formatIsoShort(j.createdAt)} ${j.objective.replace(/\s+/g, " ").slice(0, 60)}`).join("\n");
      return {
        content: [{ type: "text", text: `Batch jobs (${jobs.length} most recent):\n${summary || "None"}` }],
        details: { totalJobs: jobs.length, found: false },
      };
    },
  });
}
