import * as path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { parseArgs } from "../args.js";
import { showText } from "../commands.js";
import { isInside, writeFileAtomicExclusive } from "../fsutil.js";
import { discoverBatchModels } from "../models.js";
import { allowedProviders } from "../openrouter/routing.js";
import { batchModelCandidates, pickerEntries } from "../privacy/commands.js";
import { isPrivacyLevel, PRIVACY_LEVELS, type Route } from "../privacy/policy.js";
import type { BatchRuntime } from "../runtime.js";
import { formatIsoShort } from "../time.js";
import type { JobManifest } from "../types.js";
import { conversationOrder } from "./request.js";
import type { ChatService } from "./service.js";
import type { ThreadState, TranscriptEntry } from "./types.js";

const NOT_IN_CHAT = "Not in chat mode. Use /batch chat continue or /batch chat resume.";
const TYPE_SLUG = "Type a slug…";

export const CHAT_HELP = `/batch chat — chat with a model at batch prices (replies arrive when the batch completes)

  chat                      start a new thread and enter chat mode
  chat continue             re-enter the most recently active thread
  chat resume [thread]      pick a thread (or give an ID suffix or exact title)
  chat clear                start a fresh thread (the old one stays resumable)
  chat rename <title>       rename the thread (locks the title); rename --auto unlocks auto-titling
  chat model [slug] [--refresh]
                            change the model from the next message on (no slug: picker; --refresh reloads the model list first)
  chat privacy <level>      raise this thread to no-training or zdr (never below the project level)
  chat compact [focus]     summarise older messages now; optional focus instructions
  chat context              estimated size of the next request and distance to auto-compact
  chat cost                 usage and cost totals the provider reported for this thread
  chat export [file] [--overwrite]
                            write the transcript as Markdown (workspace-relative file), or show it
  chat off                  leave chat mode; typing goes to the live model again
  chat send [--file <path>] [--context <dir>] "<message>"
                            send a message with attached workspace files or context directories
  chat retry [--force]      resubmit the last turn if it failed; after "no response from OpenRouter" it is
                            refused unless --force (check your OpenRouter activity first: it may be billed)
  chat help                 this list

Chat mode is per Pi session and is off when Pi starts. Lines starting with / are always commands.`;

export function formatContext(e: ReturnType<ChatService["nextRequestEstimate"]>, retention?: string): string {
  const pct = e.limit > 0 ? Math.round((e.tokens / e.limit) * 100) : 0;
  return [
    `Next request: about ${e.tokens} tokens (estimate: characters / 4)`,
    `  Summary of earlier conversation: ${e.summaryTokens} tokens`,
    `  Recent messages and prompt:      ${e.recentTokens} tokens`,
    `Auto-compact limit: ${e.limit} tokens (${pct}% of auto-compact limit used)`,
    ...(retention ? [retention] : []),
  ].join("\n");
}

export function formatCost(jobs: JobManifest[]): string {
  let cost = 0;
  let tokens = 0;
  let costJobs = 0;
  let tokenJobs = 0;
  for (const j of jobs) {
    if (j.usage?.cost !== undefined) {
      cost += j.usage.cost;
      costJobs++;
    }
    if (j.usage?.totalTokens !== undefined) {
      tokens += j.usage.totalTokens;
      tokenJobs++;
    }
  }
  if (costJobs === 0 && tokenJobs === 0) return `Usage: not reported by the provider (${jobs.length} job(s) in this thread).`;
  const parts = [`Jobs in this thread: ${jobs.length}`];
  parts.push(tokenJobs > 0 ? `Tokens: ${tokens} (from ${tokenJobs} job(s) that reported usage)` : "Tokens: not reported");
  parts.push(costJobs > 0 ? `Charged: $${cost.toFixed(6)} (from ${costJobs} job(s) that reported cost)` : "Cost: not reported");
  return parts.join("\n");
}

function quote(text: string): string {
  return text.split("\n").map((l) => `> ${l}`).join("\n");
}

export function exportMarkdown(thread: ThreadState, entries: TranscriptEntry[]): string {
  const out: string[] = [`# ${thread.title}`, "", `Thread ${thread.id} · created ${thread.createdAt} · model ${thread.model}`];
  for (const e of conversationOrder(entries)) {
    out.push("");
    switch (e.type) {
      case "user":
        out.push("### You", "", e.text);
        if (e.attachments?.length) {
          out.push("", `_Attachments: ${e.attachments.map((a) => `${a.path ?? a.name} (${a.bytes} B, sha256:${a.sha256.slice(0, 8)})`).join(", ")}_`);
        }
        break;
      case "assistant":
        out.push(`### ${e.model}`, "", e.text);
        if (e.finishReason === "length") out.push("", "_(truncated: max_tokens)_");
        break;
      case "compaction":
        out.push(`> **Compacted** earlier conversation (through #${e.throughSeq}, ${e.model}). Summary:`, ">", quote(e.summary));
        break;
      case "model":
        out.push(`_Model changed: ${e.from} -> ${e.to}_`);
        break;
      case "title":
        out.push(`_Retitled (${e.source}): ${e.title}_`);
        break;
      case "failure":
        out.push(`_Failed ${e.purpose}${e.jobId ? ` (${e.jobId})` : ""}: ${e.message}_`);
        break;
      case "status":
        out.push(`_${e.text}_`);
        break;
    }
  }
  return `${out.join("\n")}\n`;
}

function relativeTime(iso: string, now = Date.now()): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "unknown";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function activeThread(rt: BatchRuntime): string {
  const id = rt.requireChatSession().activeThreadId;
  if (!id) throw new Error(NOT_IN_CHAT);
  return id;
}

function startNew(rt: BatchRuntime): void {
  const t = rt.requireChat().newThread();
  rt.requireChatSession().enter(t.id);
}

async function pickThread(rt: BatchRuntime, ctx: ExtensionCommandContext): Promise<string | undefined> {
  const store = rt.requireChatStore();
  const threads = store.list();
  if (threads.length === 0) {
    rt.notify("No chat threads yet. Start one with /batch chat.", "info");
    return undefined;
  }
  const labels = new Map<string, string>();
  for (const t of threads) {
    const msgs = store.transcript(t.id).entries.filter((e) => e.type === "user" || e.type === "assistant").length;
    let label = `${t.title} · ${relativeTime(t.updatedAt)} · ${msgs} msgs · ${t.model}`;
    if (t.pending) label += " · waiting";
    else if (t.compacting) label += " · compacting";
    if (labels.has(label)) label += ` · ${t.id}`;
    labels.set(label, t.id);
  }
  const choice = await ctx.ui.select("Resume which chat?", [...labels.keys()]);
  return choice === undefined ? undefined : labels.get(choice);
}

const REFRESH_MODELS = "Refresh models";

/** Labelled model picker. Models the thread's level rules out are hidden. Returns the slug and the route the picker chose. */
async function pickModel(rt: BatchRuntime, ctx: ExtensionCommandContext, threadId: string, refresh: boolean): Promise<{ slug: string; route?: Route } | undefined> {
  const catalog = rt.catalog;
  if (refresh && catalog) await catalog.load();
  const slugs = new Set<string>();
  for (const t of rt.requireChatStore().list()) slugs.add(t.model);
  slugs.add(rt.loaded.config.defaultModel);
  for (const m of discoverBatchModels(ctx)) slugs.add(m.modelId);
  for (;;) {
    const snapshot = catalog?.snapshot();
    const level = rt.requireChat().effectiveLevel(threadId);
    const entries = pickerEntries(snapshot, batchModelCandidates(snapshot, slugs), level, rt.privacy().accountNoTraining, allowedProviders(rt.loaded.config));
    const shown = entries.filter((e) => !e.blocked);
    const options = new Map<string, { slug: string; route: Route }>();
    for (const e of shown) options.set(`${e.id} ${e.labels.map((l) => `[${l}]`).join(" ")}`, { slug: e.id, route: e.route });
    const hidden = entries.length - shown.length;
    const note = !snapshot ? " (loading models…)" : !snapshot.fresh ? ` (model list from ${formatIsoShort(snapshot.loadedAt)}, refresh failed)` : "";
    const title = `Chat model · ${level}${note}${hidden > 0 ? ` · ${hidden} hidden by privacy level` : ""}`;
    const choice = await ctx.ui.select(title, [...options.keys(), REFRESH_MODELS, TYPE_SLUG]);
    if (choice === undefined) return undefined;
    if (choice === REFRESH_MODELS) {
      if (catalog) await catalog.load();
      continue;
    }
    if (choice !== TYPE_SLUG) return options.get(choice);
    const typed = (await ctx.ui.input("Model slug", "vendor/model"))?.trim();
    return typed ? { slug: typed } : undefined;
  }
}

export async function cmdChat(rt: BatchRuntime, rest: string[], ctx: ExtensionCommandContext): Promise<void> {
  const sub = rest[0]?.toLowerCase() ?? "";
  const args = rest.slice(1);
  switch (sub) {
    case "":
    case "clear":
      startNew(rt);
      return;
    case "continue": {
      const t = rt.requireChat().mostRecent();
      if (!t) {
        rt.notify("No chat threads yet. Start one with /batch chat.", "info");
        return;
      }
      rt.requireChatSession().enter(t.id);
      return;
    }
    case "resume": {
      const arg = args.join(" ").trim();
      const id = arg ? rt.requireChatStore().resolve(arg) : await pickThread(rt, ctx);
      if (id) rt.requireChatSession().enter(id);
      return;
    }
    case "off":
      rt.requireChatSession().leave();
      return;
    case "help":
      await showText(rt, ctx, "/batch chat help", CHAT_HELP);
      return;
    case "rename": {
      const id = activeThread(rt);
      const parsed = parseArgs(args, { booleans: ["auto"] });
      if (parsed.errors.length) throw new Error(`/batch chat rename: ${parsed.errors.join("; ")}`);
      if (parsed.booleans.has("auto")) {
        rt.requireChat().rename(id, { auto: true });
        rt.requireChatSession().sync();
        rt.notify("Auto-titling is on again for this thread.", "info");
        return;
      }
      const title = parsed.positionals.join(" ").trim();
      if (!title) throw new Error("Usage: /batch chat rename <title> | --auto");
      rt.requireChat().rename(id, title);
      rt.requireChatSession().sync();
      return;
    }
    case "model": {
      const id = activeThread(rt);
      const refresh = args.some((a) => a.toLowerCase() === "--refresh");
      const typedSlug = args.filter((a) => a.toLowerCase() !== "--refresh").join(" ").trim();
      if (typedSlug && refresh && rt.catalog) await rt.catalog.load();
      const picked = typedSlug ? { slug: typedSlug } : await pickModel(rt, ctx, id, refresh);
      if (!picked) return;
      await rt.requireChat().setModel(id, picked.slug, picked.route ? { route: picked.route } : {});
      rt.requireChatSession().sync();
      rt.notify(`Chat model set to ${picked.slug} from the next message on.`, "info");
      return;
    }
    case "privacy": {
      const id = activeThread(rt);
      const level = args.join(" ").trim();
      if (!level) {
        rt.notify(`Privacy level for this thread: ${rt.requireChat().effectiveLevel(id)}. Usage: /batch chat privacy ${PRIVACY_LEVELS.join("|")}`, "info");
        return;
      }
      if (!isPrivacyLevel(level)) throw new Error(`Usage: /batch chat privacy ${PRIVACY_LEVELS.join("|")}`);
      rt.requireChat().raisePrivacy(id, level);
      rt.requireChatSession().sync();
      rt.notify(`Privacy level for this thread raised to ${level}.`, "info");
      return;
    }
    case "compact": {
      const id = activeThread(rt);
      const jobId = await rt.requireChat().compact(id, args.join(" ").trim() || undefined);
      rt.poller.updateBadge();
      rt.requireChatSession().sync();
      rt.notify(`Compaction started (${jobId}). The summary applies when the job lands.`, "info");
      return;
    }
    case "context": {
      const id = activeThread(rt);
      await showText(rt, ctx, "Chat context", formatContext(rt.requireChat().nextRequestEstimate(id), rt.requireChat().batchRetentionLine(id)));
      return;
    }
    case "cost": {
      const id = activeThread(rt);
      const jobs = rt.requireService().registry.list().jobs.filter((j) => j.chat?.threadId === id);
      await showText(rt, ctx, "Chat cost", formatCost(jobs));
      return;
    }
    case "export": {
      const id = activeThread(rt);
      const parsed = parseArgs(args, { booleans: ["overwrite"] });
      if (parsed.errors.length) throw new Error(`/batch chat export: ${parsed.errors.join("; ")}`);
      const store = rt.requireChatStore();
      const md = exportMarkdown(store.read(id), store.transcript(id).entries);
      const file = parsed.positionals.join(" ").trim();
      if (!file) {
        await showText(rt, ctx, "Chat export", md);
        return;
      }
      const root = path.resolve(rt.requireService().workspaceRoot);
      const abs = path.resolve(root, file);
      if (!isInside(root, abs)) throw new Error(`Refusing to write outside the workspace: ${file}`);
      writeFileAtomicExclusive(abs, md, parsed.booleans.has("overwrite"));
      rt.notify(`Exported ${id} to ${abs}`, "info");
      return;
    }
    case "send": {
      const id = activeThread(rt);
      const parsed = parseArgs(args, { repeatable: ["file", "context"] });
      if (parsed.errors.length) throw new Error(`/batch chat send: ${parsed.errors.join("; ")}`);
      const text = parsed.positionals.join(" ").trim();
      const files = parsed.lists.file ?? [];
      const contexts = parsed.lists.context ?? [];
      if (!text && files.length === 0 && contexts.length === 0) {
        throw new Error('Usage: /batch chat send [--file <path>] [--context <dir>] "<message>"');
      }
      const sent = await rt.requireChat().send(id, text, { files, contexts });
      rt.poller.updateBadge();
      rt.requireChatSession().sync();
      if (sent.warnings?.length) rt.notify(`⚠ ${sent.warnings.join("\n")}`, "warning");
      return;
    }
    case "retry": {
      const id = activeThread(rt);
      const parsed = parseArgs(args, { booleans: ["force"] });
      if (parsed.errors.length) throw new Error(`/batch chat retry: ${parsed.errors.join("; ")}`);
      const jobId = await rt.requireChat().retry(id, { force: parsed.booleans.has("force") });
      rt.poller.updateBadge();
      rt.requireChatSession().sync();
      rt.notify(`Resubmitted as ${jobId}.`, "info");
      return;
    }
    default:
      throw new Error(`Unknown chat subcommand "${sub}". Try /batch chat help`);
  }
}
