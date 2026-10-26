import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { registerArtifactCommand } from "./src/artifact-commands.js";
import { registerBatchCommand } from "./src/commands.js";
import { renderChatEntry } from "./src/chat/render.js";
import { CHAT_ENTRY_TYPE, type ChatEntryData } from "./src/chat/session.js";
import { BatchRuntime, INJECTED_MESSAGE_TYPE } from "./src/runtime.js";
import { registerBatchTools } from "./src/tools.js";

export default function (pi: ExtensionAPI): void {
  // No timers/IO here: Pi may load extensions without starting a session.
  const rt = new BatchRuntime(pi);

  registerBatchCommand(rt);
  registerArtifactCommand(rt);
  registerBatchTools(rt);

  // Injected results render compactly in the transcript; the full text is what the model receives.
  pi.registerMessageRenderer<{ localId?: string; bounded?: boolean; characters?: number }>(INJECTED_MESSAGE_TYPE, (message, { expanded, outputPad }, theme) => {
    const content = typeof message.content === "string" ? message.content : message.content.map((c) => ("text" in c ? c.text : "")).join("");
    const d = message.details;
    const header = theme.fg("accent", `📦 Batch result ${d?.localId ?? ""} injected`) + theme.fg("dim", ` (${d?.characters ?? content.length} chars${d?.bounded ? ", bounded excerpt" : ""})`);
    const body = expanded ? content : content.split("\n").slice(0, 8).join("\n") + (content.split("\n").length > 8 ? theme.fg("dim", "\n… (expand to see all)") : "");
    const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
    box.addChild(new Text(`${header}\n${body}`, 0, 0));
    return box;
  });

  pi.registerEntryRenderer<ChatEntryData>(CHAT_ENTRY_TYPE, (entry, { expanded }, theme) => (entry.data ? renderChatEntry(entry.data, expanded, theme) : undefined));

  pi.on("input", async (event) => {
    const session = rt.chatSession;
    if (!session) return { action: "continue" as const };
    const source = event.source === "interactive" || event.source === "rpc" ? event.source : "extension";
    const result = await session.handleInput(event.text, source);
    return { action: result === "handled" ? ("handled" as const) : ("continue" as const) };
  });

  pi.on("session_start", (_event, ctx) => {
    // Rebind storage + config to this session's project, then recover/reconcile
    // any jobs left from previous runs (restart-safe; runs on timers, non-blocking).
    rt.poller.stop();
    const webStopped = rt.stopWebServerForSessionChange();
    rt.bind(ctx);
    rt.startChatSession();
    rt.poller.start();
    rt.poller.updateBadge();
    void webStopped.then(
      (stopped) => {
        if (stopped) rt.notify("Batch Web UI stopped because the Pi session changed. Run /batch web to open it for this session.", "info");
      },
      () => {},
    );
  });

  pi.on("session_shutdown", () => {
    // Idempotent. Job state is already durable on disk; nothing to flush.
    rt.poller.stop();
    rt.chatSession?.leave();
    void rt.stopWebServer();
  });
}
