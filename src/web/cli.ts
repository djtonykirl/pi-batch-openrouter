import * as path from "node:path";
import { BatchWebServer } from "./server.js";

/**
 * Standalone CLI entry point (`npm run web [-- --port 3456 --cwd /path/to/project]`).
 * Launches the local HTTP server bound to 127.0.0.1 and starts the background poller.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let port = Number(process.env.PI_BATCH_PORT ?? 3456);
  let cwd = process.cwd();

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if ((a === "--port" || a === "-p") && args[i + 1]) {
      port = Number(args[++i]);
    } else if (a === "--cwd" && args[i + 1]) {
      cwd = path.resolve(args[++i]!);
    } else if (a === "--help" || a === "-h") {
      console.log("Usage: npm run web [-- --port <port> --cwd <workspace-path>]");
      process.exit(0);
    }
  }

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`Invalid port: ${port}`);
    process.exit(1);
  }

  const srv = BatchWebServer.createStandalone(cwd);
  const url = await srv.start(port, "127.0.0.1");
  console.log(`🌐 Pi Batch OpenRouter Web UI running at ${url}`);
  console.log(`🔑 Open (one-time sign-in link): ${srv.createLaunchUrl()}`);
  console.log(`📁 Workspace: ${cwd}`);
  console.log(`Press Ctrl+C to stop.`);

  const shutdown = async () => {
    await srv.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

const isMain = process.argv[1] && (process.argv[1].endsWith("cli.js") || process.argv[1].endsWith("cli.ts"));
if (isMain) {
  void main();
}
