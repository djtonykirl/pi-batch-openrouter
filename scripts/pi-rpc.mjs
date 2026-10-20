// Drives this extension's slash commands through a real Pi process in RPC mode, for local validation and
// live tests. Pi's chat model is never meant to run: only /batch and /artifact commands are sent, and Pi is
// killed if an agent turn starts anyway.
//
// Usage: node scripts/pi-rpc.mjs <workspace> "/batch ..." ["/artifact ..." ...]
// Env:   PI_LINGER_MS  wait after the last command so Pi's background poller can finish (default 15000)
//        PI_MAX        maximum characters printed per message (default 2500)
// Exit:  0 ok · 1 usage · 2 refused (non-command argument; nothing sent) · 3 aborted (Pi started an agent turn)
//
// Pi exits on stdin EOF even while a command is still awaiting network I/O, so stdin stays open until each
// command's RPC response has arrived (see README, "Scripting Pi in RPC mode").
import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const [, , ws, ...cmds] = process.argv;
if (!ws || cmds.length === 0) {
  console.error('Usage: node scripts/pi-rpc.mjs <workspace> "/batch ..." [more commands]');
  process.exit(1);
}

// Guard 1: only extension slash commands are sent. Anything else would reach Pi's chat model as an ordinary
// prompt and may be billed. Git Bash, for example, rewrites "/batch list" into "C:/Program Files/Git/batch list";
// run from PowerShell, or set MSYS_NO_PATHCONV=1.
const ALLOWED = /^\/(batch|artifact)(\s|$)/;
const bad = cmds.filter((c) => !ALLOWED.test(c));
if (bad.length) {
  console.error(`REFUSED: not a /batch or /artifact command (nothing sent to Pi): ${bad.map((c) => JSON.stringify(c.slice(0, 80))).join(", ")}`);
  console.error("Hint: in Git Bash set MSYS_NO_PATHCONV=1, or run from PowerShell.");
  process.exit(2);
}

const extension = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "index.ts");
const pi = spawn("pi", ["-ne", "-e", `"${extension}"`, "--no-tools", "--no-mcp", "--no-skills", "--offline", "--no-session", "--mode", "rpc"], { cwd: ws, shell: true });
const MAX = Number(process.env.PI_MAX ?? 2500);

function killPi() {
  if (process.platform === "win32") spawn("taskkill", ["/PID", String(pi.pid), "/T", "/F"], { stdio: "ignore" });
  else pi.kill("SIGKILL");
}

let waiting = null;
const rl = readline.createInterface({ input: pi.stdout });
rl.on("line", (l) => {
  let e;
  try { e = JSON.parse(l); } catch { console.log("NON-JSON:", l); return; }
  if (e.type === "turn_start" || e.type === "agent_start") {
    // Guard 2: a slash command never starts an agent turn. If one starts anyway, stop Pi at once.
    console.error("ABORTED: Pi started an agent turn (a model call). Killing Pi; no further commands sent.");
    killPi();
    process.exit(3);
  }
  if (e.type === "extension_ui_request" && e.method === "notify") console.log(`--- notify (${e.notifyType}) ---\n${String(e.message).slice(0, MAX)}`);
  if (e.type === "message_end" && e.message?.role === "custom") console.log(`--- custom message customType=${e.message.customType} ---\n${String(e.message.content).slice(0, MAX)}`);
  if (e.type === "response") {
    if (!e.success) console.log("--- RESPONSE FAILURE:", l.slice(0, 500));
    if (waiting && e.id === waiting.id) { const w = waiting; waiting = null; w.resolve(); }
  }
});
pi.stderr.on("data", (d) => process.stderr.write(d));

let n = 0;
for (const c of cmds) {
  const id = `c${++n}`;
  console.log(`\n>>> ${c}`);
  await new Promise((resolve) => {
    waiting = { id, resolve };
    pi.stdin.write(JSON.stringify({ id, type: "prompt", message: c }) + "\n");
    setTimeout(() => { if (waiting?.id === id) { console.log("--- TIMEOUT waiting for response"); waiting = null; resolve(); } }, 120_000).unref();
  });
  await new Promise((r) => setTimeout(r, 500)); // let trailing notifies flush
}
// Let Pi's own background poller (started at session_start) finish any in-flight HTTP work.
await new Promise((r) => setTimeout(r, Number(process.env.PI_LINGER_MS ?? 15_000)));
pi.stdin.end();
await new Promise((r) => pi.on("close", r));
console.log("=== done: no agent turns started ===");
