import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, type LoadedConfig } from "./config.js";
import { FileLogger, type Logger } from "./logger.js";
import { discoverBatchModels, resolveApiKeyForProvider } from "./models.js";
import { BatchPoller } from "./poller.js";
import { JobRegistry } from "./registry.js";
import { ArtifactService } from "./artifacts/service.js";
import { ArtifactStore } from "./artifacts/store.js";
import { ModelCatalog, type CatalogModel } from "./models/catalog.js";
import { OpenRouterBatchClient } from "./openrouter/client.js";
import type { ZdrEndpoint } from "./privacy/policy.js";
import { BatchService } from "./service.js";
import { isChatJob, type JobManifest } from "./types.js";
import { ChatService } from "./chat/service.js";
import { CHAT_ENTRY_TYPE, ChatSession, type ChatEntryData } from "./chat/session.js";
import { ThreadStore } from "./chat/store.js";
import { BatchWebServer } from "./web/server.js";

export const INJECTED_MESSAGE_TYPE = "pi-batch-result";
const STATUS_KEY = "pi-batch";
/** Separate from STATUS_KEY so the job badge and the chat footer do not overwrite each other. */
const CHAT_STATUS_KEY = "pi-batch-chat";

/**
 * Session-scoped wiring. Rebinds to each session's cwd (project storage),
 * owns the poller, and routes notifications to the active UI.
 */
export class BatchRuntime {
  public ctx: ExtensionContext | null = null;
  public loaded: LoadedConfig = loadConfig();
  public service: BatchService | null = null;
  public artifacts: ArtifactService | null = null;
  public chat: ChatService | null = null;
  /** Session model catalog (shared by the service, chat and web); null with no workspace. Kept across config reloads. */
  public catalog: ModelCatalog | null = null;
  public chatSession: ChatSession | null = null;
  public webServer: BatchWebServer | null = null;
  private chatStore: ThreadStore | null = null;
  public readonly poller: BatchPoller;
  private logger: Logger | null = null;
  private apiKeyCache = new Map<string, string>();
  private catalogFile: string | null = null;

  constructor(public readonly pi: ExtensionAPI) {
    this.poller = new BatchPoller(
      () => this.service,
      () => this.loaded.config.polling.enabled,
      (text) => {
        if (this.ctx?.hasUI) this.ctx.ui.setStatus(STATUS_KEY, text);
        this.webServer?.broadcast({ type: "badge", text });
      },
      async () => {
        if (!this.chat) return;
        try {
          await this.chat.tick();
        } catch (err) {
          this.logger?.log("warn", "chat_tick_failed", { message: (err as Error).message });
        }
        this.chatSession?.sync();
        this.webServer?.broadcast({ type: "tick" });
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
      this.chat = null;
      this.chatStore = null;
      this.catalog = null;
      this.catalogFile = null;
      return;
    }
    const storage = path.resolve(this.cwd, this.loaded.config.storagePath);
    const registry = new JobRegistry(storage);
    this.logger = new FileLogger(path.join(storage, "extension.log"), () => [...this.apiKeyCache.values(), process.env.OPENROUTER_API_KEY ?? ""]);
    const catalogFile = path.join(storage, "model-catalog.json");
    if (!this.catalog || this.catalogFile !== catalogFile) {
      this.catalogFile = catalogFile;
      this.catalog = new ModelCatalog({ file: catalogFile, logger: this.logger, fetch: () => this.fetchCatalog() });
    }
    this.service = new BatchService({
      registry,
      catalog: this.catalog,
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
    this.chatStore = new ThreadStore(path.join(storage, "threads"));
    this.chat = new ChatService({
      store: this.chatStore,
      batch: this.service,
      workspaceRoot: this.cwd,
      getConfig: () => this.loaded.config,
      logger: this.logger,
    });
    if (this.loaded.errors.length > 0) {
      this.logger.log("warn", "config_errors", { errors: this.loaded.errors });
    }
  }

  /** Both endpoints are public; the key is only sent as the client requires one. Without a key the load fails and the catalog stays stale (fail-safe). */
  private async fetchCatalog(): Promise<{ models: CatalogModel[]; zdr: ZdrEndpoint[] }> {
    const apiKey = await this.resolveApiKey(this.loaded.config.defaultAccount);
    const client = new OpenRouterBatchClient({ apiKey, timeoutMs: this.loaded.config.polling.requestTimeoutSeconds * 1000 });
    const [models, zdr] = await Promise.all([client.listModels(), client.listZdrEndpoints()]);
    return { models: models.models, zdr: zdr.endpoints };
  }

  public requireArtifacts(): ArtifactService {
    if (!this.artifacts) throw new Error("No active Pi session/workspace; artifact storage is unavailable.");
    return this.artifacts;
  }

  public requireChatStore(): ThreadStore {
    if (!this.chatStore) throw new Error("No active Pi session/workspace; chat storage is unavailable.");
    return this.chatStore;
  }

  public requireChat(): ChatService {
    if (!this.chat) throw new Error("No active Pi session/workspace; chat storage is unavailable.");
    return this.chat;
  }

  public requireChatSession(): ChatSession {
    if (!this.chatSession) throw new Error("No active Pi session/workspace; chat is unavailable.");
    return this.chatSession;
  }

  /** Builds a fresh ChatSession (chat mode off) for the bound session; entries already in the Pi session are not shown twice. */
  public startChatSession(): void {
    this.chatSession = null;
    const ctx = this.ctx;
    if (!ctx || !this.chat || !this.chatStore) return;
    const alreadyShown: { threadId: string; seq: number }[] = [];
    for (const e of ctx.sessionManager.getEntries()) {
      if (e.type !== "custom" || e.customType !== CHAT_ENTRY_TYPE) continue;
      const d = e.data as Partial<ChatEntryData> | undefined;
      if (d && typeof d.threadId === "string" && typeof d.seq === "number") alreadyShown.push({ threadId: d.threadId, seq: d.seq });
    }
    this.chatSession = new ChatSession(
      {
        chat: this.chat,
        store: this.chatStore,
        appendEntry: (data) => this.pi.appendEntry(CHAT_ENTRY_TYPE, data),
        setStatus: (text) => {
          if (ctx.hasUI) ctx.ui.setStatus(CHAT_STATUS_KEY, text);
        },
        notify: (message, level) => this.notify(message, level),
        getConfig: () => this.loaded.config,
      },
      alreadyShown,
    );
  }

  public requireService(): BatchService {
    if (!this.service) throw new Error("No active Pi session/workspace; batch storage is unavailable.");
    return this.service;
  }

  public ensureWebServer(): BatchWebServer {
    if (this.webServer) return this.webServer;
    if (!this.cwd || !this.service || !this.chat || !this.chatStore || !this.artifacts) {
      throw new Error("No active Pi session/workspace; web UI is unavailable.");
    }
    this.webServer = new BatchWebServer({
      workspaceRoot: this.cwd,
      service: this.service,
      chat: this.chat,
      chatStore: this.chatStore,
      artifacts: this.artifacts,
      poller: this.poller,
      getConfig: () => this.loaded.config,
      reloadConfig: () => {
        this.loaded = loadConfig(this.cwd);
      },
      getKnownModels: () => (this.ctx ? discoverBatchModels(this.ctx).map((m) => m.modelId) : []),
      resolveApiKey: (account) => this.resolveApiKey(account),
    });
    return this.webServer;
  }

  /**
   * A running web server holds the previous session's service, chat and storage; on a new session it is stopped
   * rather than left serving stale state. Returns true when one was stopped (the caller tells the user).
   */
  public async stopWebServerForSessionChange(): Promise<boolean> {
    if (!this.webServer) return false;
    await this.stopWebServer();
    return true;
  }

  public async stopWebServer(): Promise<void> {
    if (!this.webServer) return;
    const srv = this.webServer;
    this.webServer = null;
    await srv.stop();
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
    this.webServer?.broadcast({ type: "settled", localId: job.localId, status: job.localStatus });
    if (isChatJob(job)) {
      // Chat replies are shown by the chat session, not announced as batch results.
      try {
        this.chat?.applySettled(job);
      } catch (err) {
        this.logger?.log("warn", "chat_apply_settled_failed", { localId: job.localId, message: (err as Error).message });
      }
      this.chatSession?.sync();
      this.poller.updateBadge();
      return;
    }
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
