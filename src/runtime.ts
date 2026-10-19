import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, type LoadedConfig } from "./config.js";
import { FileLogger, type Logger } from "./logger.js";
import { resolveApiKeyForProvider } from "./models.js";
import { BatchPoller } from "./poller.js";
import { JobRegistry } from "./registry.js";
import { ArtifactService } from "./artifacts/service.js";
import { ArtifactStore } from "./artifacts/store.js";
import { BatchService } from "./service.js";
import type { JobManifest } from "./types.js";

export const INJECTED_MESSAGE_TYPE = "pi-batch-result";
const STATUS_KEY = "pi-batch";

/**
 * Session-scoped wiring. Rebinds to each session's cwd (project storage),
 * owns the poller, and routes notifications to the active UI.
 */
export class BatchRuntime {
  public ctx: ExtensionContext | null = null;
  public loaded: LoadedConfig = loadConfig();
  public service: BatchService | null = null;
  public artifacts: ArtifactService | null = null;
  public readonly poller: BatchPoller;
  private logger: Logger | null = null;
  private apiKeyCache = new Map<string, string>();

  constructor(public readonly pi: ExtensionAPI) {
    this.poller = new BatchPoller(
      () => this.service,
      () => this.loaded.config.polling.enabled,
      (text) => {
        if (this.ctx?.hasUI) this.ctx.ui.setStatus(STATUS_KEY, text);
      },
    );
  }

  public get cwd(): string | undefined {
    return this.ctx?.cwd;
  }

  public bind(ctx: ExtensionContext): void {
    this.ctx = ctx;
    this.apiKeyCache.clear();
    this.reloadConfig();
  }

  public reloadConfig(): void {
    this.loaded = loadConfig(this.cwd);
    if (!this.cwd) {
      this.service = null;
      this.artifacts = null;
      return;
    }
    const storage = path.resolve(this.cwd, this.loaded.config.storagePath);
    const registry = new JobRegistry(storage);
    this.logger = new FileLogger(path.join(storage, "extension.log"), () => [...this.apiKeyCache.values(), process.env.OPENROUTER_API_KEY ?? ""]);
    this.service = new BatchService({
      registry,
      workspaceRoot: this.cwd,
      getConfig: () => this.loaded.config,
      resolveApiKey: (account) => this.resolveApiKey(account),
      logger: this.logger,
      onSettled: (job) => this.onSettled(job),
    });
    this.artifacts = new ArtifactService({
      batch: this.service,
      workspaceRoot: this.cwd,
      getConfig: () => this.loaded.config,
      store: new ArtifactStore(path.join(storage, "artifacts")),
    });
    if (this.loaded.errors.length > 0) {
      this.logger.log("warn", "config_errors", { errors: this.loaded.errors });
    }
  }

  public requireArtifacts(): ArtifactService {
    if (!this.artifacts) throw new Error("No active Pi session/workspace; artifact storage is unavailable.");
    return this.artifacts;
  }

  public requireService(): BatchService {
    if (!this.service) throw new Error("No active Pi session/workspace; batch storage is unavailable.");
    return this.service;
  }

  public async resolveApiKey(account: string): Promise<string> {
    if (!this.ctx) return process.env.OPENROUTER_API_KEY ?? "";
    const key = await resolveApiKeyForProvider(this.ctx, account);
    if (key) this.apiKeyCache.set(account, key); // only so the logger can redact it
    return key;
  }

  public notify(message: string, level: "info" | "warning" | "error" = "info"): void {
    if (this.ctx?.hasUI) this.ctx.ui.notify(message, level);
  }

  private onSettled(job: JobManifest): void {
    this.poller.updateBadge();
    if (!this.loaded.config.notifyOnComplete) return;
    const objective = job.objective.replace(/\s+/g, " ").slice(0, 60);
    const multi = job.requestCount > 1;
    const available = this.artifacts?.availableDefault(job);
    const artifactHint = available ? `\nArtifact available (not generated): /batch artifact ${job.localId}   → ${available.format} ${available.filename}` : "";
    if (job.localStatus === "ready") {
      this.notify(
        `📦 Batch ${job.localId} ready${multi ? ` (${job.requestCount}/${job.requestCount} items)` : ""}: ${objective}\n/batch read ${job.localId}  ·  /batch inject ${job.localId}${multi ? `  ·  /batch items ${job.localId}` : ""}${artifactHint}`,
        "info",
      );
    } else if (job.localStatus === "partial") {
      this.notify(`📦 Batch ${job.localId} partial (${job.error?.message ?? "some requests failed"})\n/batch items ${job.localId}  ·  /batch retry-items ${job.localId} --failed`, "warning");
    } else {
      this.notify(`📦 Batch ${job.localId} ${job.localStatus}${job.error ? `: ${job.error.message}` : ""}\n/batch show ${job.localId}`, "warning");
    }
  }
}
