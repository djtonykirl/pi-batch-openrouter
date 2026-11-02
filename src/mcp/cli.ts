#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { initAgentInstructions, type InitClient } from "./init.js";
import { BatchMcpServer } from "./server.js";

/**
 * Stdio MCP server entry point (`pi-batch-mcp [--cwd /path/to/workspace]`)
 * and instruction installer (`pi-batch-mcp init [--client vscode|claude|antigravity|all] [--cwd <dir>] [--force]`).
 *
 * All diagnostic output in server mode MUST go to stderr (or `.pi/batches/extension.log`); stdout is owned by the MCP JSON-RPC stream.
 */
export interface ParsedMcpCliArgs {
  subcommand?: "init";
  client?: InitClient;
  force?: boolean;
  cwd?: string;
  help: boolean;
}

export function parseMcpCliArgs(argv: readonly string[]): ParsedMcpCliArgs {
  let subcommand: "init" | undefined;
  let client: InitClient | undefined;
  let force = false;
  let cwd: string | undefined;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "init" && i === 0) {
      subcommand = "init";
    } else if ((a === "--cwd" || a === "--workspace") && argv[i + 1]) {
      cwd = path.resolve(argv[++i]!);
    } else if (a.startsWith("--cwd=")) {
      cwd = path.resolve(a.slice("--cwd=".length));
    } else if (a === "--client" && argv[i + 1]) {
      const val = argv[++i]!.toLowerCase();
      if (val === "vscode" || val === "claude" || val === "antigravity" || val === "all") client = val;
      else throw new Error(`Unknown --client "${val}". Expected vscode, claude, antigravity, or all.`);
    } else if (a.startsWith("--client=")) {
      const val = a.slice("--client=".length).toLowerCase();
      if (val === "vscode" || val === "claude" || val === "antigravity" || val === "all") client = val;
      else throw new Error(`Unknown --client "${val}". Expected vscode, claude, antigravity, or all.`);
    } else if (a === "--force" || a === "--overwrite") {
      force = true;
    } else if (a === "--help" || a === "-h") {
      help = true;
    }
  }
  return { subcommand, client, force, cwd, help };
}

async function main(): Promise<void> {
  const { subcommand, client, force, cwd, help } = parseMcpCliArgs(process.argv.slice(2));
  if (help) {
    process.stderr.write(
      "Usage:\n" +
        "  pi-batch-mcp [--cwd <workspace-path>]\n" +
        "  pi-batch-mcp init [--client vscode|claude|antigravity|all] [--cwd <workspace-path>] [--force]\n",
    );
    process.exit(0);
  }
  if (cwd !== undefined && (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory())) {
    process.stderr.write(`pi-batch-mcp: workspace directory does not exist: ${cwd}\n`);
    process.exit(1);
  }

  if (subcommand === "init") {
    const targetRoot = cwd ?? process.cwd();
    const res = initAgentInstructions({ workspaceRoot: targetRoot, client: client ?? "all", overwrite: force });
    for (const f of res.written) process.stderr.write(`Wrote ${f}\n`);
    for (const f of res.skipped) process.stderr.write(`Skipped ${f} (already exists; pass --force to overwrite)\n`);
    process.exit(0);
  }

  const srv = new BatchMcpServer({ workspaceRoot: cwd });
  const transport = new StdioServerTransport();
  await srv.connect(transport);

  const shutdown = async () => {
    try {
      await srv.close();
    } catch {
      // ignore
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

const entry = process.argv[1] ?? "";
const isMain = /(?:[/\\]|^)(?:mcp[/\\])?cli\.(?:[cm]?js|ts)$/.test(entry) || entry.endsWith("pi-batch-mcp");
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`pi-batch-mcp fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  });
}
