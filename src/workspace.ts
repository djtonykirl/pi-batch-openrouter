import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactService } from "./artifacts/service.js";
import { ArtifactStore } from "./artifacts/store.js";
import { ChatService } from "./chat/service.js";
import { ThreadStore } from "./chat/store.js";
import { loadConfig, readPrivacyConfig, type BatchConfig, type LoadedConfig } from "./config.js";
import { FileLogger, type Logger } from "./logger.js";
import { fetchCatalogData, ModelCatalog, type CatalogData } from "./models/catalog.js";
import { OpenRouterBatchClient } from "./openrouter/client.js";
import { BatchPoller } from "./poller.js";
import { JobRegistry } from "./registry.js";
import { BatchService } from "./service.js";
import { isChatJob, type JobManifest } from "./types.js";

/**
 * Host-independent wiring of one workspace's batch services, for every host that runs outside Pi (the standalone web
 * UI and the MCP server). Pi's own wiring stays in runtime.ts (it resolves keys and notifies through the Pi session).
 */

/**
 * The API key for `account` outside Pi: that account's own entry in ~/.pi/agent/auth.json, or OPENROUTER_API_KEY
 * only when `account` is the configured default. Never another account's key (that would bill the wrong account);
 * with no key it throws a clear error.
 */
export function resolveStandaloneApiKey(account: string, defaultAccount: string, authFile = path.join(os.homedir(), ".pi", "agent", "auth.json")): string {
  let authError: string | undefined;
  try {
    if (fs.existsSync(authFile)) {
      const auth = JSON.parse(fs.readFileSync(authFile, "utf8")) as Record<string, { key?: string; access?: string } | undefined>;
      const entry = Object.prototype.hasOwnProperty.call(auth, account) ? auth[account] : undefined;
      if (entry?.key) return entry.key;
      if (entry?.access) return entry.access;
    }
  } catch (err) {
    authError = (err as Error).message;
  }
  const isDefault = account === defaultAccount;
  if (isDefault && process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  throw new Error(
    `No API key for account "${account}" in ${authFile}${authError ? ` (unreadable: ${authError})` : ""}` +
      (isDefault ? " and OPENROUTER_API_KEY is not set." : `. OPENROUTER_API_KEY is used only for the default account ("${defaultAccount}").`),
  );
}

/**
 * Wraps a key resolver so the standalone logger can redact every key it has handed out (plus OPENROUTER_API_KEY).
 * `base` defaults to `resolveStandaloneApiKey` with the configured default account.
 */
export function createStandaloneKeyResolver(
  getDefaultAccount: () => string,
  base: (account: string) => Promise<string> = async (account) => resolveStandaloneApiKey(account, getDefaultAccount()),
): { resolve: (account: string) => Promise<string>; secrets: () => string[] } {
  const resolved = new Set<string>();
  return {
    resolve: async (account) => {
      const key = await base(account);
      if (key) resolved.add(key);
      return key;
    },
    secrets: () => [...resolved, ...(process.env.OPENROUTER_API_KEY ? [process.env.OPENROUTER_API_KEY] : [])],
  };
}

export interface WorkspaceServicesOptions {
  /** Key resolver; defaults to `resolveStandaloneApiKey` (auth.json, then OPENROUTER_API_KEY for the default account). */
  resolveApiKey?: (account: string) => Promise<string>;
  /** Custom OpenRouter client factory (used by tests to inject a scripted client). */
  createClient?: (apiKey: string, timeoutMs: number) => OpenRouterBatchClient;
  /** Called after a reconcile settled a job (after chat jobs were applied to their thread). */
  onSettled?: (job: JobManifest) => void;
  /** Called when the poller's badge text changes. */
  onBadge?: (text: string | undefined) => void;
  /** Called after each poller tick (after the chat tick). */
  onTick?: () => void;
}

export interface WorkspaceServices {
  workspaceRoot: string;
  storage: string;
  service: BatchService;
  chat: ChatService;
  chatStore: ThreadStore;
  artifacts: ArtifactService;
  poller: BatchPoller;
  catalog: ModelCatalog;
  logger: Logger;
  getConfig: () => BatchConfig;
  getLoaded: () => LoadedConfig;
  reloadConfig: () => void;
}

/** Builds registry, logger, catalog, batch, artifact and chat services and a poller for one workspace (no timers started). */
export function createWorkspaceServices(workspaceRoot: string, opts: WorkspaceServicesOptions = {}): WorkspaceServices {
  let loaded = loadConfig(workspaceRoot);
  const storage = path.resolve(workspaceRoot, loaded.config.storagePath);
  const registry = new JobRegistry(storage);
  // Every key handed out is redacted from this workspace's log.
  const keys = createStandaloneKeyResolver(() => loaded.config.defaultAccount, opts.resolveApiKey);
  const logger = new FileLogger(path.join(storage, "extension.log"), keys.secrets);

  const catalog = new ModelCatalog({
    file: path.join(storage, "model-catalog.json"),
    logger,
    fetch: async (): Promise<CatalogData> => {
      const apiKey = await keys.resolve(loaded.config.defaultAccount);
      const timeoutMs = loaded.config.polling.requestTimeoutSeconds * 1000;
      const client = opts.createClient ? opts.createClient(apiKey, timeoutMs) : new OpenRouterBatchClient({ apiKey, timeoutMs });
      return fetchCatalogData(client, logger);
    },
  });
  // Privacy decisions read the config files fresh: another process may have raised the level since this snapshot.
  const getPrivacy = () => readPrivacyConfig(workspaceRoot, undefined, loaded.config.privacy);
  const service = new BatchService({
    registry,
    catalog,
    workspaceRoot,
    getConfig: () => loaded.config,
    getPrivacy,
    resolveApiKey: keys.resolve,
    ...(opts.createClient ? { createClient: opts.createClient } : {}),
    logger,
    onSettled: (job) => {
      if (isChatJob(job)) {
        try {
          chat.applySettled(job);
        } catch {
          // logged by ChatService
        }
      }
      opts.onSettled?.(job);
    },
  });
  const artifacts = new ArtifactService({
    batch: service,
    workspaceRoot,
    getConfig: () => loaded.config,
    store: new ArtifactStore(path.join(storage, "artifacts")),
  });
  const chatStore = new ThreadStore(path.join(storage, "threads"));
  const chat = new ChatService({
    store: chatStore,
    batch: service,
    workspaceRoot,
    getConfig: () => loaded.config,
    getPrivacy,
    logger,
  });
  const poller = new BatchPoller(
    () => service,
    () => loaded.config.polling.enabled,
    (text) => opts.onBadge?.(text),
    async () => {
      await chat.tick();
      opts.onTick?.();
    },
  );

  return {
    workspaceRoot,
    storage,
    service,
    chat,
    chatStore,
    artifacts,
    poller,
    catalog,
    logger,
    getConfig: () => loaded.config,
    getLoaded: () => loaded,
    reloadConfig: () => {
      loaded = loadConfig(workspaceRoot);
    },
  };
}
