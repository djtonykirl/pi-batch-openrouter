#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { BatchMcpServer } from "./server.js";

/**
 * Stdio MCP server entry point (`pi-batch-mcp [--cwd /path/to/workspace]`).
 *
 * All diagnostic output MUST go to stderr (or `.pi/batches/extension.log`); stdout is owned by the MCP JSON-RPC stream.
 */
export function parseMcpCliArgs(argv: readonly string[]): { cwd?: string; help: boolean } {
  let cwd: string | undefined;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if ((a === "--cwd" || a === "--workspace") && argv[i + 1]) {
      cwd = path.resolve(argv[++i]!);
    } else if (a.startsWith("--cwd=")) {
      cwd = path.resolve(a.slice("--cwd=".length));
    } else if (a === "--help" || a === "-h") {
      help = true;
    }
  }
  return { cwd, help };
}

async function main(): Promise<void> {
  const { cwd, help } = parseMcpCliArgs(process.argv.slice(2));
  if (help) {
    process.stderr.write("Usage: pi-batch-mcp [--cwd <workspace-path>]\n");
    process.exit(0);
  }
  if (cwd !== undefined && (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory())) {
    process.stderr.write(`pi-batch-mcp: workspace directory does not exist: ${cwd}\n`);
    process.exit(1);
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
