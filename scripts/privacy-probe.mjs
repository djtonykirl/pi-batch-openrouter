#!/usr/bin/env node
// Live probe: does the OpenRouter Batch API accept privacy-related `provider` fields?
//
// Usage: node scripts/privacy-probe.mjs <model> [--account <alias>]
//
// Submits up to three single-request batches (max_tokens 1, content "ping") for <model>:
//   1. provider: { data_collection: "deny" }
//   2. provider: { zdr: true }
//   3. provider: { only: [<first batch endpoint tag of the model that is also on the ZDR list>], allow_fallbacks: false }
// and reports ACCEPTED or REJECTED for each. The third confirms that the Batch API takes the full endpoint tags
// (for example "google-vertex/global") that the extension pins at privacy level zdr. Batch jobs run only on the model's
// :batch endpoints (GET /models/{id}:batch/endpoints), which differ from the sync endpoints /endpoints/zdr lists, so the
// third probe is skipped when none of the model's batch endpoints is on the ZDR list.
//
// THIS BILLS YOUR ACCOUNT (a few tokens per accepted batch). It never runs unless you type "yes".
// Exit codes: 0 done, 1 usage error or no API key, 2 not confirmed.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline/promises";

const BASE = "https://openrouter.ai/api/v1";
const DEFAULT_ACCOUNT = "openrouter";
const POLL_MS = 15_000;
const POLL_BUDGET_MS = 10 * 60_000;
const TERMINAL = new Set(["completed", "failed", "expired", "cancelled", "canceled"]);

function usage(msg) {
  if (msg) console.error(msg);
  console.error("Usage: node scripts/privacy-probe.mjs <model> [--account <alias>]");
  process.exit(1);
}

function parseArgs(argv) {
  let model;
  let account = DEFAULT_ACCOUNT;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--account") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) usage("--account needs an alias");
      account = v;
    } else if (a === "--help" || a === "-h") {
      usage();
    } else if (a.startsWith("--")) {
      usage(`Unknown option ${a}`);
    } else if (!model) {
      model = a;
    } else {
      usage(`Unexpected argument ${a}`);
    }
  }
  if (!model) usage("A model is required, for example anthropic/claude-haiku-4.5");
  return { model, account };
}

/** Same rule as the standalone web server: the account's own auth.json entry, or OPENROUTER_API_KEY for the default account only. */
function resolveKey(account) {
  const authFile = path.join(os.homedir(), ".pi", "agent", "auth.json");
  try {
    if (fs.existsSync(authFile)) {
      const auth = JSON.parse(fs.readFileSync(authFile, "utf8"));
      const entry = Object.prototype.hasOwnProperty.call(auth, account) ? auth[account] : undefined;
      if (entry?.key) return entry.key;
      if (entry?.access) return entry.access;
    }
  } catch {
    // fall through to the environment variable
  }
  if (account === DEFAULT_ACCOUNT && process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  usage(
    `No API key for account "${account}" in ${authFile}` +
      (account === DEFAULT_ACCOUNT ? " and OPENROUTER_API_KEY is not set." : `. OPENROUTER_API_KEY is used only for the "${DEFAULT_ACCOUNT}" account.`),
  );
}

const normalise = (slug) => String(slug).replace(/:(batch|free)$/i, "");

async function call(key, method, pathName, body) {
  const res = await fetch(BASE + pathName, {
    method,
    headers: { Authorization: `Bearer ${key}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, text, json };
}

function errorDetail(r) {
  const e = r.json?.error;
  const msg = (typeof e === "string" ? e : e?.message) ?? r.json?.message ?? r.text;
  return String(msg).replace(/\s+/g, " ").slice(0, 300);
}

async function probe(key, model, label, provider, accepted) {
  const r = await call(key, "POST", "/batches", {
    endpoint: "/v1/chat/completions",
    model,
    provider,
    completion_window: "24h",
    requests: [{ custom_id: "probe-1", body: { messages: [{ role: "user", content: "ping" }], max_tokens: 1 } }],
  });
  if (r.status >= 200 && r.status < 300 && typeof r.json?.id === "string") {
    console.log(`${label}: ACCEPTED (batch ${r.json.id})`);
    accepted.push(r.json.id);
  } else {
    console.log(`${label}: REJECTED (${r.status}: ${errorDetail(r)})`);
  }
}

/** The first of the model's :batch endpoint tags that is also one of its ZDR endpoint tags, or undefined (with the reason printed). */
async function firstBatchZdrTag(key, model) {
  const want = normalise(model);
  const z = await call(key, "GET", "/endpoints/zdr");
  if (z.status < 200 || z.status >= 300) {
    console.log(`Could not load the ZDR endpoint list (${z.status}: ${errorDetail(z)}); skipping the endpoint-tag probe.`);
    return undefined;
  }
  const list = Array.isArray(z.json?.data) ? z.json.data : Array.isArray(z.json) ? z.json : [];
  const zdrTags = [...new Set(list.filter((e) => typeof e?.model_id === "string" && typeof e?.tag === "string" && normalise(e.model_id) === want).map((e) => e.tag))];

  const segments = want.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) {
    console.log(`Model ID ${JSON.stringify(want)} has an empty, "." or ".." path segment; skipping the endpoint-tag probe.`);
    return undefined;
  }
  const batchPath = `/models/${segments.map((seg) => encodeURIComponent(seg).replace(/%3A/gi, ":")).join("/")}:batch/endpoints`;
  const b = await call(key, "GET", batchPath);
  if (b.status < 200 || b.status >= 300 || !Array.isArray(b.json?.data?.endpoints)) {
    console.log(`Could not load the batch endpoints of ${want} (${b.status}: ${errorDetail(b)}); skipping the endpoint-tag probe.`);
    return undefined;
  }
  const batchTags = [...new Set(b.json.data.endpoints.map((e) => e?.tag).filter((t) => typeof t === "string" && t))];
  const hit = batchTags.find((t) => zdrTags.includes(t));
  if (!hit) {
    console.log(
      `No batch endpoint of ${want} is on the ZDR list (batch endpoints: ${batchTags.join(", ") || "none"}; ZDR endpoints: ${zdrTags.join(", ") || "none"}); skipping.`,
    );
    console.log("To run this probe, pick a model the chat model picker labels [ZDR] (a batch model with a batch endpoint on the ZDR list).");
  }
  return hit;
}

async function cleanup(key, ids) {
  if (ids.length === 0) return;
  console.log("");
  console.log("Accepted probe batches cannot be cancelled (OpenRouter has no cancel endpoint):");
  for (const id of ids) console.log(`  ${id}`);
  console.log(`Waiting up to ${POLL_BUDGET_MS / 60_000} minutes for them to finish so their results can be deleted (DELETE /batches/{id}).`);
  const pending = new Set(ids);
  const deadline = Date.now() + POLL_BUDGET_MS;
  while (pending.size > 0 && Date.now() < deadline) {
    for (const id of [...pending]) {
      const g = await call(key, "GET", `/batches/${encodeURIComponent(id)}`);
      // 402 carries the batch object too (finalized cost exceeds balance); treat any readable terminal status as finished.
      if (g.json?.status && TERMINAL.has(String(g.json.status))) {
        const d = await call(key, "DELETE", `/batches/${encodeURIComponent(id)}`);
        if ((d.status >= 200 && d.status < 300) || d.status === 404 || d.status === 410) {
          console.log(`Deleted ${id}`);
          pending.delete(id);
        } else if (d.status !== 409) {
          console.log(`Could not delete ${id} (${d.status}: ${errorDetail(d)}); delete it yourself: DELETE ${BASE}/batches/${id}`);
          pending.delete(id);
        }
      }
    }
    if (pending.size > 0) await new Promise((r) => setTimeout(r, POLL_MS));
  }
  for (const id of pending) console.log(`Still not finished: ${id}. Delete it later with DELETE ${BASE}/batches/${id} once it has completed.`);
}

async function main() {
  const { model, account } = parseArgs(process.argv.slice(2));
  const key = resolveKey(account);

  console.log(`Privacy probe for model "${model}" on account "${account}".`);
  console.log("This submits up to three real single-request batches (one token of output each). Accepted batches are billed,");
  console.log("cannot be cancelled, and run until the provider finishes them; their results are then deleted.");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('Type "yes" to continue: ')).trim();
  rl.close();
  if (answer !== "yes") {
    console.log("Not confirmed; nothing was submitted.");
    process.exit(2);
  }

  const accepted = [];
  try {
    await probe(key, model, 'provider { data_collection: "deny" }', { data_collection: "deny" }, accepted);
    await probe(key, model, "provider { zdr: true }", { zdr: true }, accepted);

    const tag = await firstBatchZdrTag(key, model);
    if (tag) {
      await probe(key, model, `provider { only: ["${tag}"], allow_fallbacks: false }`, { only: [tag], allow_fallbacks: false }, accepted);
    }
  } finally {
    await cleanup(key, accepted);
  }
}

main().catch((err) => {
  // Never print the key: only the message of the error.
  console.error(`Probe failed: ${err?.message ?? err}`);
  process.exit(1);
});
