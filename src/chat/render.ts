import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, Text, type Component } from "@earendil-works/pi-tui";
import type { ChatEntryData } from "./session.js";

const COLLAPSED_LINES = 8;
export const TRUNCATED_MARKER = "(truncated: max_tokens)";

/** Renders one chat entry: a coloured header, then the text (collapsed to 8 lines unless expanded). */
export function renderChatEntry(data: ChatEntryData, expanded: boolean, theme: Theme): Component {
  const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
  if (data.role === "status") {
    box.addChild(new Text(theme.fg("dim", data.text), 0, 0));
    return box;
  }
  const header = data.role === "assistant" ? theme.fg("accent", `${data.model ?? "assistant"} → you`) : theme.fg("muted", `You → ${data.title}`);
  const lines = data.text.split("\n");
  let body = expanded ? data.text : lines.slice(0, COLLAPSED_LINES).join("\n");
  if (!expanded && lines.length > COLLAPSED_LINES) body += theme.fg("dim", "\n… (expand to see all)");
  if (data.truncated) body += `\n${theme.fg("warning", TRUNCATED_MARKER)}`;
  box.addChild(new Text(`${header}\n${body}`, 0, 0));
  return box;
}
