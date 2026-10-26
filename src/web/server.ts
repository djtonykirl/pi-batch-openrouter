import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactService } from "../artifacts/service.js";
import { ArtifactStore } from "../artifacts/store.js";
import { prepareAttachments, type AttachmentRequestInput, type UploadedFileInput } from "../attachments.js";
import { exportMarkdown, formatCost } from "../chat/commands.js";
import { conversationOrder } from "../chat/request.js";
import { ChatService, PROJECT_INSTRUCTIONS_FILE } from "../chat/service.js";
import { ThreadStore } from "../chat/store.js";
import { loadConfig, saveConfigUpdate, type BatchConfig } from "../config.js";
import { IgnoreMatcher, hardDenyMatcher } from "../context/ignore.js";
import { buildContextPackage, gitCheckIgnore, toPosix } from "../context/package.js";
import { formatSecretFindings, scanForSecrets } from "../context/secrets.js";
import { atomicWriteFile, isInside, sha256Hex, writeFileAtomicExclusive } from "../fsutil.js";
import { jobItems, sourceLabel } from "../items.js";
import { FileLogger } from "../logger.js";
import { badgeText, BatchPoller } from "../poller.js";
import { JobRegistry } from "../registry.js";
import { BatchService } from "../service.js";
import { isChatJob, type JobManifest } from "../types.js";
import { discoverWorkflows } from "../workflows/definition.js";
import { renderWebUiHtml } from "./ui.js";

export interface WebServerDeps {
  workspaceRoot: string;
  service: BatchService;
  chat: ChatService;
  chatStore: ThreadStore;
  artifacts: ArtifactService;
  poller: BatchPoller;
  getConfig: () => BatchConfig;
  reloadConfig?: () => void;
  getKnownModels?: () => string[];
}

export interface WorkspaceEntryInfo {
  relPath: string;
  kind: "file" | "directory";
  bytes?: number;
  selectable: boolean;
  excludedLayer?: string;
  rule?: string;
}

const DEFAULT_FALLBACK_MODELS = [
  "anthropic/claude-opus-5.5",
  "anthropic/claude-sonnet-4.5",
  "openai/gpt-5-mini",
  "openai/gpt-4o",
  "deepseek/deepseek-r1",
];

function resolveStandaloneApiKey(provider: string): string {
  try {
    const authFile = path.join(os.homedir(), ".pi", "agent", "auth.json");
    if (fs.existsSync(authFile)) {
      const auth = JSON.parse(fs.readFileSync(authFile, "utf8")) as Record<string, { key?: string; access?: string }>;
      const entry = auth[provider] || auth["openrouter"];
      if (entry?.key) return entry.key;
      if (entry?.access) return entry.access;
    }
  } catch {
    // fallback to env
  }
  return process.env.OPENROUTER_API_KEY ?? "";
}

/**
 * Enumerates workspace files & directories up to a bounded limit and classifies each
 * using the same exclusion precedence as `buildContextPackage`.
 */
export function inspectWorkspaceFiles(workspaceRoot: string, config: BatchConfig, maxEntries = 600): WorkspaceEntryInfo[] {
  const rootReal = fs.realpathSync.native(path.resolve(workspaceRoot));
  const readIgnore = (rel: string): IgnoreMatcher | null => {
    const p = path.resolve(rootReal, rel);
    return fs.existsSync(p) ? IgnoreMatcher.fromText(fs.readFileSync(p, "utf8")) : null;
  };
  const batchIgnore = readIgnore(config.context.batchIgnoreFile);
  const configured = new IgnoreMatcher(config.context.excludePatterns);
  const gitignoreFallback = readIgnore(".gitignore");

  const entries: WorkspaceEntryInfo[] = [];
  const fileRelPaths: string[] = [];

  const checkDirExclusion = (relPath: string): { layer: string; rule: string } | null => {
    const hard = hardDenyMatcher.match(relPath, true);
    if (hard) return { layer: "hard-deny", rule: hard.pattern };
    const bi = batchIgnore?.match(relPath, true);
    if (bi) return { layer: "batchignore", rule: bi.pattern };
    const cm = configured.match(relPath, true);
    if (cm) return { layer: "config", rule: cm.pattern };
    return null;
  };

  const walk = (dirReal: string, dirRel: string, depth: number): void => {
    if (entries.length >= maxEntries || depth > 6) return;
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(dirReal, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const item of items) {
      if (entries.length >= maxEntries) break;
      if (item.name === ".git") continue;
      const abs = path.join(dirReal, item.name);
      const rel = dirRel ? `${dirRel}/${item.name}` : item.name;
      if (item.isSymbolicLink()) {
        entries.push({ relPath: rel, kind: "file", selectable: false, excludedLayer: "symlink", rule: "symbolic link" });
        continue;
      }
      if (item.isDirectory()) {
        const ex = checkDirExclusion(rel);
        if (ex) {
          entries.push({ relPath: rel + "/", kind: "directory", selectable: false, excludedLayer: ex.layer, rule: ex.rule });
          continue;
        }
        entries.push({ relPath: rel, kind: "directory", selectable: true });
        walk(abs, rel, depth + 1);
      } else if (item.isFile()) {
        let size = 0;
        try {
          size = fs.statSync(abs).size;
        } catch {
          continue;
        }
        fileRelPaths.push(rel);
        entries.push({ relPath: rel, kind: "file", bytes: size, selectable: true });
      }
    }
  };

  walk(rootReal, "", 0);

  const gitIgnoredSet = config.context.respectGitignore ? gitCheckIgnore(rootReal, fileRelPaths) : new Set<string>();
  for (const e of entries) {
    if (e.kind !== "file" || !e.selectable) continue;
    const hard = hardDenyMatcher.match(e.relPath, false);
    if (hard) {
      e.selectable = false;
      e.excludedLayer = "hard-deny";
      e.rule = hard.pattern;
      continue;
    }
    const bi = batchIgnore?.match(e.relPath, false);
    if (bi) {
      e.selectable = false;
      e.excludedLayer = "batchignore";
      e.rule = bi.pattern;
      continue;
    }
    if (config.context.respectGitignore) {
      const gi = gitIgnoredSet ? (gitIgnoredSet.has(e.relPath) ? "(git check-ignore)" : null) : (gitignoreFallback?.match(e.relPath)?.pattern ?? null);
      if (gi) {
        e.selectable = false;
        e.excludedLayer = "gitignore";
        e.rule = gi;
        continue;
      }
    }
    const cm = configured.match(e.relPath, false);
    if (cm) {
      e.selectable = false;
      e.excludedLayer = "config";
      e.rule = cm.pattern;
      continue;
    }
    if ((e.bytes ?? 0) > config.context.maxFileBytes) {
      e.selectable = false;
      e.excludedLayer = "too-large";
      e.rule = `> ${config.context.maxFileBytes} B`;
    }
  }

  return entries;
}

export class BatchWebServer {
  public readonly csrfToken = crypto.randomBytes(24).toString("hex");
  private server: http.Server | null = null;
  private portNumber: number | null = null;
  private readonly sseClients = new Set<http.ServerResponse>();
  private fsWatcher: fs.FSWatcher | null = null;
  private readonly recentWorkspaces = new Set<string>();
  private resolveApiKeyFn: (account: string) => Promise<string> = async (account: string) => resolveStandaloneApiKey(account);

  constructor(private deps: WebServerDeps) {
    this.recentWorkspaces.add(toPosix(path.resolve(deps.workspaceRoot)));
  }

  private static buildWorkspaceDeps(
    workspaceRoot: string,
    resolveKey: (account: string) => Promise<string>,
    getServer: () => BatchWebServer | null,
    getKnownModels?: () => string[],
  ): WebServerDeps {
    let loaded = loadConfig(workspaceRoot);
    const storage = path.resolve(workspaceRoot, loaded.config.storagePath);
    const registry = new JobRegistry(storage);
    const logger = new FileLogger(path.join(storage, "extension.log"), () => [process.env.OPENROUTER_API_KEY ?? ""]);

    const service = new BatchService({
      registry,
      workspaceRoot,
      getConfig: () => loaded.config,
      resolveApiKey: resolveKey,
      logger,
      onSettled: (job) => {
        if (isChatJob(job)) {
          try {
            chat.applySettled(job);
          } catch {
            // logged by ChatService
          }
        }
        getServer()?.broadcast({ type: "settled", localId: job.localId, status: job.localStatus });
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
      logger,
    });
    const poller = new BatchPoller(
      () => service,
      () => loaded.config.polling.enabled,
      () => getServer()?.broadcast({ type: "badge" }),
      async () => {
        await chat.tick();
        getServer()?.broadcast({ type: "tick" });
      },
    );

    return {
      workspaceRoot,
      service,
      chat,
      chatStore,
      artifacts,
      poller,
      getConfig: () => loaded.config,
      reloadConfig: () => {
        loaded = loadConfig(workspaceRoot);
      },
      getKnownModels,
    };
  }

  /** Creates a standalone `BatchWebServer` bound to `workspaceRoot` without requiring a Pi session. */
  public static createStandalone(workspaceRoot: string, opts?: { resolveApiKey?: (account: string) => Promise<string> }): BatchWebServer {
    const resolveKey = opts?.resolveApiKey ?? (async (account: string) => resolveStandaloneApiKey(account));
    let webServer: BatchWebServer | null = null;
    const deps = BatchWebServer.buildWorkspaceDeps(path.resolve(workspaceRoot), resolveKey, () => webServer);
    webServer = new BatchWebServer(deps);
    webServer.resolveApiKeyFn = resolveKey;
    return webServer;
  }

  /** Hot-swaps the active workspace folder (`workspaceRoot`) and reinitializes registries, stores, and watchers. */
  public switchWorkspace(newWorkspaceRoot: string): string {
    if (!newWorkspaceRoot || !newWorkspaceRoot.trim()) {
      throw new Error("Workspace path cannot be empty.");
    }
    const resolved = path.resolve(newWorkspaceRoot.trim());
    if (!fs.existsSync(resolved)) {
      throw new Error(`Directory does not exist: ${resolved}`);
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch (err) {
      throw new Error(`Cannot access directory ${resolved}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Path is not a directory: ${resolved}`);
    }
    const realRoot = fs.realpathSync.native(resolved);
    if (this.fsWatcher) {
      this.fsWatcher.close();
      this.fsWatcher = null;
    }
    try {
      this.deps.poller.stop();
    } catch {}

    const prevKnownModels = this.deps.getKnownModels;
    this.deps = BatchWebServer.buildWorkspaceDeps(realRoot, this.resolveApiKeyFn, () => this, prevKnownModels);
    const posixRoot = toPosix(realRoot);
    this.recentWorkspaces.add(posixRoot);

    try {
      this.deps.service.registry.ensureRoot();
      this.fsWatcher = fs.watch(this.deps.service.registry.root, { persistent: false }, () => {
        this.broadcast({ type: "fs_change" });
      });
    } catch {
      // fs.watch is optional
    }
    this.deps.poller.start();
    this.broadcast({ type: "workspace_changed", workspaceRoot: posixRoot });
    return posixRoot;
  }

  public get url(): string | null {
    return this.portNumber ? `http://127.0.0.1:${this.portNumber}` : null;
  }

  public get isRunning(): boolean {
    return this.server !== null && this.portNumber !== null;
  }

  public async start(port = 0, host = "127.0.0.1"): Promise<string> {
    if (this.server && this.portNumber) return this.url!;
    const srv = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      srv.once("error", reject);
      srv.listen(port, host, () => {
        srv.removeListener("error", reject);
        resolve();
      });
    });
    const addr = srv.address();
    this.portNumber = typeof addr === "object" && addr ? addr.port : port;
    this.server = srv;

    try {
      this.deps.service.registry.ensureRoot();
      this.fsWatcher = fs.watch(this.deps.service.registry.root, { persistent: false }, () => {
        this.broadcast({ type: "fs_change" });
      });
    } catch {
      // fs.watch is optional
    }
    return this.url!;
  }

  public async stop(): Promise<void> {
    if (this.fsWatcher) {
      this.fsWatcher.close();
      this.fsWatcher = null;
    }
    for (const client of this.sseClients) {
      try {
        client.end();
      } catch {}
    }
    this.sseClients.clear();
    if (!this.server) return;
    const srv = this.server;
    this.server = null;
    this.portNumber = null;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }

  public broadcast(event: Record<string, unknown>): void {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.write(line);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const method = req.method ?? "GET";
      const parsedUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
      const pathname = parsedUrl.pathname;

      // Serve UI
      if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        const html = renderWebUiHtml({
          csrfToken: this.csrfToken,
          workspaceRoot: toPosix(this.deps.workspaceRoot),
        });
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Frame-Options": "DENY",
        });
        res.end(html);
        return;
      }

      // SSE stream
      if (method === "GET" && pathname === "/api/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);
        this.sseClients.add(res);
        req.on("close", () => this.sseClients.delete(res));
        return;
      }

      // Enforce CSRF token on mutating API calls
      if (pathname.startsWith("/api/") && method !== "GET" && method !== "HEAD") {
        const token = req.headers["x-batch-token"];
        if (token !== this.csrfToken) {
          this.sendJson(res, 403, { error: "Forbidden: invalid or missing X-Batch-Token" });
          return;
        }
      }

      // ---------------- API Routes ----------------
      if (method === "GET" && pathname === "/api/bootstrap") {
        const config = this.deps.getConfig();
        const jobs = this.deps.service.registry.list().jobs;
        const threads = this.deps.chatStore.list().map((t) => {
          const entries = this.deps.chatStore.transcript(t.id).entries;
          const messageCount = entries.filter((e) => e.type === "user" || e.type === "assistant").length;
          return { ...t, messageCount };
        });
        const workflows = discoverWorkflows(this.deps.workspaceRoot).entries.map((w) => ({
          name: w.name,
          file: w.file,
          valid: w.valid,
          description: w.definition?.description,
        }));
        const models = new Set<string>([config.defaultModel, ...DEFAULT_FALLBACK_MODELS]);
        for (const m of this.deps.getKnownModels?.() ?? []) models.add(m);
        for (const t of threads) models.add(t.model);
        for (const j of jobs) models.add(j.model);

        const piFile = path.join(this.deps.workspaceRoot, ...PROJECT_INSTRUCTIONS_FILE.split("/"));
        const projectInstructions = fs.existsSync(piFile) ? fs.readFileSync(piFile, "utf8") : "";

        this.sendJson(res, 200, {
          workspaceRoot: toPosix(this.deps.workspaceRoot),
          recentWorkspaces: [...this.recentWorkspaces],
          config,
          threads,
          jobs,
          workflows,
          badge: badgeText(jobs),
          models: [...models],
          projectInstructions,
        });
        return;
      }

      // Directory browser & workspace folder switcher
      if (method === "GET" && pathname === "/api/workspace/browse-dirs") {
        const rawPath = parsedUrl.searchParams.get("path")?.trim();
        const targetAbs = rawPath ? path.resolve(rawPath) : path.resolve(this.deps.workspaceRoot);
        if (!fs.existsSync(targetAbs) || !fs.statSync(targetAbs).isDirectory()) {
          this.sendJson(res, 400, { error: `Directory does not exist: ${targetAbs}` });
          return;
        }
        const parentAbs = path.dirname(targetAbs);
        const dirs: Array<{ name: string; path: string; hasPiBatch: boolean }> = [];
        try {
          const items = fs.readdirSync(targetAbs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
          for (const item of items) {
            if (!item.isDirectory()) continue;
            if (item.name === "node_modules" || item.name === ".git") continue;
            const childAbs = path.join(targetAbs, item.name);
            let hasPiBatch = false;
            try {
              hasPiBatch = fs.existsSync(path.join(childAbs, ".pi"));
            } catch {}
            dirs.push({
              name: item.name,
              path: toPosix(childAbs),
              hasPiBatch,
            });
          }
        } catch (err) {
          this.sendJson(res, 400, { error: `Unable to list directory: ${err instanceof Error ? err.message : String(err)}` });
          return;
        }
        this.sendJson(res, 200, {
          current: toPosix(targetAbs),
          parent: parentAbs !== targetAbs ? toPosix(parentAbs) : null,
          homeDir: toPosix(os.homedir()),
          recentWorkspaces: [...this.recentWorkspaces],
          directories: dirs,
        });
        return;
      }

      if (method === "POST" && pathname === "/api/workspace/switch") {
        const body = await this.readJson<{ path?: string }>(req);
        const workspaceRoot = this.switchWorkspace(body.path ?? "");
        this.sendJson(res, 200, {
          workspaceRoot,
          recentWorkspaces: [...this.recentWorkspaces],
        });
        return;
      }

      // Workspace file browser & preview
      if (method === "GET" && pathname === "/api/workspace/files") {
        const entries = inspectWorkspaceFiles(this.deps.workspaceRoot, this.deps.getConfig());
        this.sendJson(res, 200, { entries });
        return;
      }

      if (method === "GET" && pathname === "/api/workspace/file-preview") {
        const rel = parsedUrl.searchParams.get("path") ?? "";
        if (!rel.trim()) {
          this.sendJson(res, 400, { error: "Missing ?path= parameter" });
          return;
        }
        const config = this.deps.getConfig();
        const pkg = buildContextPackage({
          workspaceRoot: this.deps.workspaceRoot,
          objective: "preview",
          files: [rel],
          contexts: [],
          includeInstructions: false,
          format: "markdown",
          config,
          knownSecrets: await this.deps.service.knownSecrets(config.defaultAccount),
          renderPackage: false,
        });
        if (pkg.problems.length > 0) {
          this.sendJson(res, 400, { error: pkg.problems.map((p) => p.message).join("; ") });
          return;
        }
        if (pkg.secretFindings.length > 0 && config.security.blockOnSecret) {
          this.sendJson(res, 400, { error: formatSecretFindings(pkg.secretFindings) });
          return;
        }
        const f = pkg.files[0];
        if (!f) {
          this.sendJson(res, 404, { error: `File ${rel} could not be loaded` });
          return;
        }
        this.sendJson(res, 200, {
          relPath: f.relPath,
          bytes: f.bytes,
          characters: f.characters,
          sha256: f.sha256,
          content: f.content.slice(0, 20_000),
        });
        return;
      }

      if (method === "POST" && pathname === "/api/workspace/write-file") {
        const body = await this.readJson<{ relPath?: string; content?: string; contentBase64?: string; overwrite?: boolean }>(req);
        const rawRel = (body.relPath ?? "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
        if (!rawRel) {
          this.sendJson(res, 400, { error: "Destination file path cannot be empty." });
          return;
        }
        const rootReal = fs.realpathSync.native(path.resolve(this.deps.workspaceRoot));
        const abs = path.resolve(rootReal, ...rawRel.split("/"));
        if (!isInside(rootReal, abs) || abs === rootReal) {
          this.sendJson(res, 400, { error: `Refusing to write outside the workspace: ${rawRel}` });
          return;
        }
        const normRel = toPosix(path.relative(rootReal, abs));
        const deny = hardDenyMatcher.match(normRel, false);
        if (deny) {
          this.sendJson(res, 400, { error: `Refusing to write to protected path "${normRel}" (matched hard-deny rule: ${deny.pattern})` });
          return;
        }
        // Reject writing through any existing symlink component inside the workspace
        let cur = rootReal;
        for (const seg of normRel.split("/")) {
          cur = path.join(cur, seg);
          if (fs.existsSync(cur) && fs.lstatSync(cur).isSymbolicLink()) {
            this.sendJson(res, 400, { error: `Refusing to write through symbolic link: ${normRel}` });
            return;
          }
        }
        let data: Buffer;
        if (body.contentBase64 !== undefined) {
          const rawB64 = body.contentBase64.includes(",")
            ? body.contentBase64.slice(body.contentBase64.indexOf(",") + 1)
            : body.contentBase64;
          data = Buffer.from(rawB64, "base64");
        } else {
          data = Buffer.from(body.content ?? "", "utf8");
        }
        try {
          writeFileAtomicExclusive(abs, data, Boolean(body.overwrite));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const status = msg.includes("already exists") ? 409 : 400;
          this.sendJson(res, status, { error: msg });
          return;
        }
        this.sendJson(res, 200, {
          relPath: normRel,
          absPath: toPosix(abs),
          bytes: data.length,
          sha256: sha256Hex(data),
        });
        return;
      }

      // Attachment & Secret Scan Preflight
      if (method === "POST" && pathname === "/api/attachments/preflight") {
        const body = await this.readJson<{ text?: string; attachments?: AttachmentRequestInput }>(req);
        const config = this.deps.getConfig();
        const knownSecrets = await this.deps.service.knownSecrets(config.defaultAccount);
        const prep = await prepareAttachments({
          workspaceRoot: this.deps.workspaceRoot,
          config,
          knownSecrets,
          input: body.attachments,
        });
        const text = body.text ?? "";
        if (config.security.scanSecrets && text.trim()) {
          const msgFindings = scanForSecrets(text, "<message>", knownSecrets);
          if (msgFindings.length > 0) {
            prep.secretFindings.push(...msgFindings);
            if (config.security.blockOnSecret) prep.blockers.push(formatSecretFindings(msgFindings));
          }
        }
        const estimatedTokens = Math.ceil((text.length + prep.inlinedText.length) / 4);
        this.sendJson(res, 200, {
          attachments: prep.attachments,
          excludedCount: prep.excludedCount,
          warnings: prep.warnings,
          blockers: prep.blockers,
          secretFindingsCount: prep.secretFindings.length,
          estimatedTokens,
        });
        return;
      }

      // ---------------- Chat Thread Endpoints ----------------
      if (method === "GET" && pathname === "/api/threads") {
        const threads = this.deps.chatStore.list();
        this.sendJson(res, 200, { threads });
        return;
      }

      if (method === "POST" && pathname === "/api/threads") {
        const body = await this.readJson<{ model?: string; title?: string }>(req);
        const thread = this.deps.chat.newThread();
        if (body.model?.trim()) this.deps.chat.setModel(thread.id, body.model.trim());
        if (body.title?.trim()) this.deps.chat.rename(thread.id, body.title.trim());
        this.broadcast({ type: "thread_created", threadId: thread.id });
        this.sendJson(res, 201, { thread: this.deps.chatStore.read(thread.id) });
        return;
      }

      const threadMatch = /^\/api\/threads\/([^/]+)(?:\/([a-z-]+))?$/.exec(pathname);
      if (threadMatch) {
        const threadId = this.deps.chatStore.resolve(decodeURIComponent(threadMatch[1]!));
        const action = threadMatch[2];

        if (method === "GET" && !action) {
          const thread = this.deps.chatStore.read(threadId);
          const entries = conversationOrder(this.deps.chatStore.transcript(threadId).entries);
          const estimate = this.deps.chat.nextRequestEstimate(threadId);
          const threadJobs = this.deps.service.registry.list().jobs.filter((j) => j.chat?.threadId === threadId);
          const pendingJob = thread.pending?.jobId ? this.safeReadJob(thread.pending.jobId) : undefined;
          const compactingJob = thread.compacting?.jobId ? this.safeReadJob(thread.compacting.jobId) : undefined;
          this.sendJson(res, 200, {
            thread,
            entries,
            estimate,
            pendingJob,
            compactingJob,
            costSummary: formatCost(threadJobs).split("\n").join(" · "),
          });
          return;
        }

        if (method === "GET" && action === "export") {
          const thread = this.deps.chatStore.read(threadId);
          const md = exportMarkdown(thread, this.deps.chatStore.transcript(threadId).entries);
          res.writeHead(200, {
            "Content-Type": "text/markdown; charset=utf-8",
            "Content-Disposition": `attachment; filename="${threadId}.md"`,
          });
          res.end(md);
          return;
        }

        if (method === "POST" && action === "send") {
          const body = await this.readJson<{ text?: string; attachments?: AttachmentRequestInput }>(req);
          const out = await this.deps.chat.send(threadId, body.text ?? "", body.attachments);
          this.deps.poller.updateBadge();
          this.broadcast({ type: "thread_updated", threadId });
          this.sendJson(res, 200, out);
          return;
        }

        if (method === "POST" && action === "rename") {
          const body = await this.readJson<{ title?: string; auto?: boolean }>(req);
          this.deps.chat.rename(threadId, body.auto ? { auto: true } : (body.title ?? ""));
          this.broadcast({ type: "thread_updated", threadId });
          this.sendJson(res, 200, { thread: this.deps.chatStore.read(threadId) });
          return;
        }

        if (method === "POST" && action === "model") {
          const body = await this.readJson<{ model: string }>(req);
          this.deps.chat.setModel(threadId, body.model ?? "");
          this.broadcast({ type: "thread_updated", threadId });
          this.sendJson(res, 200, { thread: this.deps.chatStore.read(threadId) });
          return;
        }

        if (method === "POST" && action === "compact") {
          const body = await this.readJson<{ instructions?: string }>(req);
          const jobId = await this.deps.chat.compact(threadId, body.instructions);
          this.deps.poller.updateBadge();
          this.broadcast({ type: "thread_updated", threadId });
          this.sendJson(res, 200, { jobId });
          return;
        }

        if (method === "POST" && action === "retry") {
          const jobId = await this.deps.chat.retry(threadId);
          this.deps.poller.updateBadge();
          this.broadcast({ type: "thread_updated", threadId });
          this.sendJson(res, 200, { jobId });
          return;
        }
      }

      // ---------------- Batch Job Endpoints ----------------
      if (method === "GET" && pathname === "/api/jobs") {
        this.sendJson(res, 200, this.deps.service.registry.list());
        return;
      }

      if (method === "POST" && pathname === "/api/jobs/check-all") {
        const outcomes = await this.deps.poller.checkNow(true);
        this.broadcast({ type: "jobs_checked" });
        this.sendJson(res, 200, { outcomes });
        return;
      }

      if (method === "POST" && pathname === "/api/jobs/ask") {
        const body = await this.readJson<{
          objective: string;
          files?: string[];
          contexts?: string[];
          uploads?: UploadedFileInput[];
          model?: string;
          account?: string;
          providerPin?: string;
          format?: "markdown" | "json";
          includeInstructions?: boolean;
          mode?: "dryrun" | "preview" | "submit";
        }>(req);
        const prepared = await this.deps.service.prepare({
          objective: body.objective ?? "",
          files: body.files ?? [],
          contexts: body.contexts ?? [],
          uploads: body.uploads,
          model: body.model,
          account: body.account,
          providerPin: body.providerPin,
          format: body.format === "json" ? "json" : "markdown",
          includeInstructions: body.includeInstructions ?? true,
        });
        if (body.mode === "dryrun") {
          this.sendJson(res, 200, {
            blockers: prepared.blockers,
            warnings: prepared.pkg.warnings,
            files: prepared.pkg.files.map((f) => ({ relPath: f.relPath, bytes: f.bytes, characters: f.characters })),
            uploads: prepared.uploads ?? [],
            excludedCount: prepared.pkg.excluded.length,
            characters: prepared.pkg.characters,
            contentSha256: prepared.contentSha256,
            summary: `Model: ${prepared.model} · Workspace files: ${prepared.pkg.files.length} · Uploads: ${(prepared.uploads ?? []).length} · Total characters: ${prepared.pkg.characters} (~${Math.ceil(prepared.pkg.characters / 4)} tokens)`,
          });
          return;
        }
        const job = await this.deps.service.createJob(prepared, { previewOnly: body.mode === "preview" });
        this.deps.poller.updateBadge();
        this.broadcast({ type: "job_created", localId: job.localId });
        this.sendJson(res, 201, { job });
        return;
      }

      if (method === "POST" && pathname === "/api/jobs/map-files") {
        const body = await this.readJson<{
          objective: string;
          files?: string[];
          contexts?: string[];
          groupSize?: number;
          model?: string;
          account?: string;
          providerPin?: string;
          format?: "markdown" | "json";
          mode?: "dryrun" | "preview" | "submit";
        }>(req);
        const plan = await this.deps.service.planMapFiles({
          objective: body.objective ?? "",
          files: body.files ?? [],
          contexts: body.contexts ?? [],
          groupSize: body.groupSize ?? 1,
          model: body.model,
          account: body.account,
          providerPin: body.providerPin,
          format: body.format === "json" ? "json" : "markdown",
          includeInstructions: true,
        });
        if (body.mode === "dryrun") {
          this.sendJson(res, 200, {
            blockers: plan.blockers,
            warnings: plan.pkg.warnings,
            summary: `Model: ${plan.model} · Requests in batch: ${plan.items.length} · Files selected: ${plan.pkg.files.length} · Total characters: ${plan.totalCharacters}`,
          });
          return;
        }
        const job = await this.deps.service.createWorkflowJob(plan, { previewOnly: body.mode === "preview" });
        this.deps.poller.updateBadge();
        this.broadcast({ type: "job_created", localId: job.localId });
        this.sendJson(res, 201, { job });
        return;
      }

      if (method === "POST" && pathname === "/api/jobs/dataset") {
        const body = await this.readJson<{
          workflow: string;
          input: string;
          model?: string;
          account?: string;
          providerPin?: string;
          mode?: "dryrun" | "preview" | "submit";
        }>(req);
        const prepared = await this.deps.service.planDataset({
          workflow: body.workflow ?? "",
          input: body.input ?? "",
          model: body.model,
          account: body.account,
          providerPin: body.providerPin,
        });
        if (body.mode === "dryrun") {
          this.sendJson(res, 200, {
            blockers: prepared.blockers,
            warnings: prepared.warnings,
            summary: `Workflow: ${body.workflow} · Model: ${prepared.model} · Rows selected: ${prepared.plan?.counts.selectedRows ?? 0} · Total characters: ${prepared.plan?.totalCharacters ?? 0}`,
          });
          return;
        }
        const job = await this.deps.service.createDatasetJob(prepared, { previewOnly: body.mode === "preview" });
        this.deps.poller.updateBadge();
        this.broadcast({ type: "job_created", localId: job.localId });
        this.sendJson(res, 201, { job });
        return;
      }

      const jobItemMatch = /^\/api\/jobs\/([^/]+)\/item\/(\d+)$/.exec(pathname);
      if (method === "GET" && jobItemMatch) {
        const localId = this.deps.service.registry.resolveId(decodeURIComponent(jobItemMatch[1]!));
        const ordinal = Number(jobItemMatch[2]!);
        const desc = this.deps.service.describeItem(localId, String(ordinal), { text: true });
        const promptPath = this.deps.service.registry.itemArtefact(localId, ordinal, "prompt");
        const prompt = fs.existsSync(promptPath) ? fs.readFileSync(promptPath, "utf8") : "";
        this.sendJson(res, 200, { ...desc, prompt });
        return;
      }

      const jobMatch = /^\/api\/jobs\/([^/]+)(?:\/([a-z-]+))?$/.exec(pathname);
      if (jobMatch) {
        const localId = this.deps.service.registry.resolveId(decodeURIComponent(jobMatch[1]!));
        const action = jobMatch[2];

        if (method === "GET" && !action) {
          const job = this.deps.service.registry.read(localId);
          const events = this.deps.service.registry.events(localId);
          const items = jobItems(this.deps.service.registry, job).map((it) => ({
            ...it,
            sourceLabel: sourceLabel(it),
          }));
          const readDefault = this.deps.service.read(localId, "default");
          const artifacts = this.deps.artifacts.list({ jobId: localId });
          const linked = this.deps.service.linkedJobs(localId);
          this.sendJson(res, 200, { job, events, items, readDefault, artifacts, linked });
          return;
        }

        if (method === "POST" && action === "check") {
          const outcome = await this.deps.service.reconcile(localId, { force: true, waitForLockMs: 5000 });
          this.deps.poller.updateBadge();
          this.broadcast({ type: "job_updated", localId });
          this.sendJson(res, 200, outcome);
          return;
        }

        if (method === "POST" && action === "submit") {
          const job = await this.deps.service.submit(localId);
          this.deps.poller.updateBadge();
          this.broadcast({ type: "job_updated", localId });
          this.sendJson(res, 200, { job });
          return;
        }

        if (method === "POST" && action === "cancel") {
          const out = await this.deps.service.cancel(localId);
          this.deps.poller.updateBadge();
          this.broadcast({ type: "job_updated", localId });
          this.sendJson(res, 200, out);
          return;
        }

        if (method === "POST" && action === "retry") {
          const body = await this.readJson<{ failedOnly?: boolean; model?: string }>(req);
          const job = body.failedOnly
            ? await this.deps.service.retryItems(localId, { failed: true, model: body.model })
            : await this.deps.service.retry(localId, { model: body.model });
          this.deps.poller.updateBadge();
          this.broadcast({ type: "job_created", localId: job.localId });
          this.sendJson(res, 201, { job });
          return;
        }

        if (method === "POST" && action === "synthesize") {
          const body = await this.readJson<{ allowPartial?: boolean; model?: string; previewOnly?: boolean }>(req);
          const prepared = await this.deps.service.prepareSynthesis(localId, {
            allowPartial: body.allowPartial ?? true,
            model: body.model,
          });
          const job = await this.deps.service.createSynthesisJob(prepared, { previewOnly: body.previewOnly ?? false });
          this.deps.poller.updateBadge();
          this.broadcast({ type: "job_created", localId: job.localId });
          this.sendJson(res, 201, { job });
          return;
        }

        if (method === "POST" && action === "artifact") {
          const body = await this.readJson<{ format: string; allowPartial?: boolean; item?: string; synthesis?: boolean }>(req);
          const plan = await this.deps.artifacts.planFromJob(localId, {
            format: body.format,
            allowPartial: body.allowPartial ?? true,
            item: body.item,
            synthesis: body.synthesis,
          });
          const artifact = this.deps.artifacts.execute(plan);
          this.broadcast({ type: "artifact_created", artifactId: artifact.artifactId });
          this.sendJson(res, 201, { artifact });
          return;
        }

        if (method === "POST" && action === "export") {
          const body = await this.readJson<{ format: "jsonl" | "csv" }>(req);
          const record = this.deps.service.exportResults(localId, { format: body.format === "csv" ? "csv" : "jsonl" });
          this.sendJson(res, 200, { record });
          return;
        }
      }

      // ---------------- Artifact Content Streaming ----------------
      const artifactMatch = /^\/api\/artifacts\/([^/]+)\/content$/.exec(pathname);
      if (method === "GET" && artifactMatch) {
        const id = this.deps.artifacts.store.resolveId(decodeURIComponent(artifactMatch[1]!));
        const manifest = this.deps.artifacts.store.read(id);
        if (!manifest.output?.path) {
          this.sendJson(res, 404, { error: `Artifact ${id} has no rendered output file` });
          return;
        }
        const absPath = path.resolve(this.deps.workspaceRoot, ...manifest.output.path.split("/"));
        if (!fs.existsSync(absPath)) {
          this.sendJson(res, 404, { error: `Rendered file missing on disk: ${manifest.output.path}` });
          return;
        }
        const bytes = fs.readFileSync(absPath);
        const contentType =
          manifest.format === "html"
            ? "text/html; charset=utf-8"
            : manifest.format === "pdf"
              ? "application/pdf"
              : manifest.format === "markdown"
                ? "text/markdown; charset=utf-8"
                : "text/plain; charset=utf-8";
        const download = parsedUrl.searchParams.get("download") === "1";
        res.writeHead(200, {
          "Content-Type": contentType,
          "Content-Length": bytes.length,
          ...(download ? { "Content-Disposition": `attachment; filename="${path.basename(absPath)}"` } : {}),
        });
        res.end(bytes);
        return;
      }

      // ---------------- Config & Project Instructions ----------------
      if (method === "POST" && pathname === "/api/config") {
        const body = await this.readJson<{ defaultModel?: string; defaultAccount?: string; projectInstructions?: string }>(req);
        const config = this.deps.getConfig();
        if (body.projectInstructions !== undefined && config.security.scanSecrets) {
          const known = await this.deps.service.knownSecrets(body.defaultAccount || config.defaultAccount);
          const findings = scanForSecrets(body.projectInstructions, PROJECT_INSTRUCTIONS_FILE, known);
          if (findings.length > 0 && config.security.blockOnSecret) {
            this.sendJson(res, 400, { error: formatSecretFindings(findings) });
            return;
          }
          const piFile = path.join(this.deps.workspaceRoot, ...PROJECT_INSTRUCTIONS_FILE.split("/"));
          atomicWriteFile(piFile, body.projectInstructions);
        }
        const update: Partial<Pick<BatchConfig, "defaultModel" | "defaultAccount">> = {};
        if (body.defaultModel?.trim()) update.defaultModel = body.defaultModel.trim();
        if (body.defaultAccount?.trim()) update.defaultAccount = body.defaultAccount.trim();
        const file = saveConfigUpdate(update, { cwd: this.deps.workspaceRoot, global: false });
        this.deps.reloadConfig?.();
        this.sendJson(res, 200, { file });
        return;
      }

      this.sendJson(res, 404, { error: `Not found: ${method} ${pathname}` });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.sendJson(res, 400, { error: message });
    }
  }

  private safeReadJob(localId: string): JobManifest | undefined {
    try {
      return this.deps.service.registry.read(localId);
    } catch {
      return undefined;
    }
  }

  private async readJson<T>(req: http.IncomingMessage): Promise<T> {
    const chunks: Buffer[] = [];
    let total = 0;
    const maxBodyBytes = 30_000_000; // 30 MB to allow base64 PDF/image uploads
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBodyBytes) throw new Error("Request payload exceeds 30 MB limit");
      chunks.push(buf);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw.trim()) return {} as T;
    return JSON.parse(raw) as T;
  }

  private sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(body);
  }
}
