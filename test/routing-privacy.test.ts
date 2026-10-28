import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import type { BatchConfig } from "../src/config.js";
import { promptEvidence, type TableEvidence } from "../src/metadata/contract.js";
import { METADATA_STANDARDS_INSTRUCTIONS, METADATA_V2_INSTRUCTIONS, planMetadataRun, renderMetadataPrompt } from "../src/metadata/plan.js";
import { ModelCatalog } from "../src/models/catalog.js";
import { OpenRouterBatchClient } from "../src/openrouter/client.js";
import { formatMetadataPreview } from "../src/metadata-commands.js";
import { ZDR_PIN_PREVIEW, formatPrivacyPolicy, formatRoutingPolicy, previewPin, providerAllowed } from "../src/openrouter/routing.js";
import { formatPrivacyStatus, pickerEntries } from "../src/privacy/commands.js";
import { immediateProviderFields, resolveBatchProvider, type ZdrEndpoint } from "../src/privacy/policy.js";
import { JobRegistry } from "../src/registry.js";
import { BatchService, SubmissionBlockedError, type AskOptions } from "../src/service.js";
import { FAKE_KEY, FakeOpenRouter, accepted, makeConfig, makeService } from "./fixtures/fake-openrouter.js";
import { metadataWorkspace } from "./fixtures/metadata.js";
import { chatCompletion, completed, successItem } from "./fixtures/openrouter.js";
import { rm, tempWorkspace, writeFiles } from "./helpers.js";
import { batchEndpointsMatchingZdr } from "./fixtures/catalog.js";

/**
 * routing.* (provider allow-list, account requirements) linked with the privacy levels:
 * the allow-list narrows the ZDR pin; requireZdr / requireNoDataCollection are met by the
 * effective level as well as by the account attestations.
 */

const ASK: AskOptions = { objective: "Review the authentication design", files: ["src/auth.ts"], contexts: [], format: "markdown", includeInstructions: true };
const MODEL = "anthropic/claude-opus-5.5";
const ZDR: ZdrEndpoint[] = [
  { model: MODEL, provider: "azure/eu" },
  { model: MODEL, provider: "anthropic" },
  { model: "openai/gpt-4o-mini", provider: "azure/eu" },
];

interface Ctx {
  fake: FakeOpenRouter;
  cfg: BatchConfig;
  service: BatchService;
  jobsDir: string;
}

function withEnv(
  opts: { level?: BatchConfig["privacy"]["level"]; accountNoTraining?: boolean; routing?: Partial<BatchConfig["routing"]> },
  fn: (ctx: Ctx) => Promise<void>,
): () => Promise<void> {
  return async () => {
    const root = tempWorkspace("pi batch routing-");
    writeFiles(root, { "src/auth.ts": "export function login() { return true; }\n" });
    try {
      const fake = new FakeOpenRouter();
      const cfg = makeConfig((c) => {
        c.defaultModel = MODEL;
        c.privacy.level = opts.level ?? "standard";
        c.privacy.accountNoTraining = opts.accountNoTraining ?? false;
        Object.assign(c.routing, opts.routing ?? {});
      });
      const catalog = new ModelCatalog({ fetch: async () => ({ models: [], zdr: ZDR, batchEndpoints: batchEndpointsMatchingZdr(ZDR) }), file: path.join(root, "catalog.json") });
      await catalog.load();
      const jobsDir = path.join(root, ".pi", "batches");
      const service = new BatchService({
        registry: new JobRegistry(jobsDir),
        workspaceRoot: root,
        getConfig: () => cfg,
        resolveApiKey: async () => FAKE_KEY,
        createClient: (apiKey, timeoutMs) => new OpenRouterBatchClient({ apiKey, fetchImpl: fake.fetch, timeoutMs }),
        gitIgnored: () => new Set(),
        catalog,
      });
      await fn({ fake, cfg, service, jobsDir });
    } finally {
      rm(root);
    }
  };
}

const posted = (fake: FakeOpenRouter) => fake.requests.filter((r) => r.method === "POST" && r.url.endsWith("/batches")).map((r) => JSON.parse(r.body ?? "{}") as Record<string, unknown>);
const jobCount = (jobsDir: string) => (fs.existsSync(jobsDir) ? fs.readdirSync(jobsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).length : 0);
const chatDraft = (model: string, privacyLevel?: BatchConfig["privacy"]["level"]) => ({
  threadId: "T-20261028-ABCD",
  purpose: "turn" as const,
  throughSeq: 1,
  model,
  account: "default",
  main: [{ role: "user" as const, content: "hello" }],
  ...(privacyLevel ? { privacyLevel } : {}),
});

// ------------------------------------------------------------ zdr x allow-list

test("allow-list entries admit equal tags and base providers only", () => {
  assert.equal(providerAllowed(["azure"], "azure/eu"), true);
  assert.equal(providerAllowed(["azure/eu"], "azure/eu"), true);
  assert.equal(providerAllowed(["azure/us"], "azure/eu"), false);
  assert.equal(providerAllowed(["azur"], "azure/eu"), false);
  assert.equal(providerAllowed(["anthropic"], "azure/eu"), false);
});

test("policy: zdr intersects the ZDR tags with the allow-list, never with fallbacks", () => {
  const catalog = { fresh: true, zdr: ZDR, batchEndpoints: batchEndpointsMatchingZdr(ZDR) };
  const base = { level: "zdr" as const, model: MODEL, catalog, accountNoTraining: false };
  assert.deepEqual(resolveBatchProvider({ ...base, allowedProviders: ["azure"] }), { ok: true, provider: { only: ["azure/eu"], allow_fallbacks: false }, enforcement: "pinned to ZDR providers: azure/eu" });
  assert.deepEqual(resolveBatchProvider({ ...base, allowedProviders: ["anthropic", "groq"], userPin: { only: ["anthropic", "groq"], allow_fallbacks: true } }), {
    ok: true,
    provider: { only: ["anthropic"], allow_fallbacks: false },
    enforcement: "pinned to ZDR providers: anthropic",
  });
  assert.deepEqual(resolveBatchProvider({ ...base, allowedProviders: ["groq", "together"] }), {
    ok: false,
    reason: `Privacy level zdr: no ZDR provider for ${MODEL} within routing.allowedProviders (groq, together)`,
  });
});

test(
  "zdr with an allow-list: a ZDR tag inside the list is pinned (allowFallbacks ignored)",
  withEnv({ level: "zdr", routing: { allowedProviders: ["anthropic", "groq"], allowFallbacks: true } }, async ({ service, fake }) => {
    const p = await service.prepare(ASK);
    assert.deepEqual(p.blockers, []);
    fake.submitReplies = [accepted()];
    const job = await service.createJob(p, { previewOnly: false });
    assert.equal(job.localStatus, "submitted", job.error?.message);
    assert.deepEqual(posted(fake)[0]!.provider, { only: ["anthropic"], allow_fallbacks: false });
    assert.deepEqual(job.providerPin, { only: ["anthropic"], allow_fallbacks: false });
  }),
);

test(
  "zdr with an allow-list: the base slug azure admits the ZDR tag azure/eu",
  withEnv({ level: "zdr", routing: { allowedProviders: ["azure"] } }, async ({ service, fake }) => {
    fake.submitReplies = [accepted()];
    const job = await service.createJob(await service.prepare(ASK), { previewOnly: false });
    assert.equal(job.localStatus, "submitted", job.error?.message);
    assert.deepEqual(posted(fake)[0]!.provider, { only: ["azure/eu"], allow_fallbacks: false });
  }),
);

test(
  "zdr with an allow-list that has no ZDR endpoint is refused, and nothing is saved or sent",
  withEnv({ level: "zdr", routing: { allowedProviders: ["groq"] } }, async ({ service, fake, jobsDir }) => {
    const p = await service.prepare(ASK);
    await assert.rejects(service.createJob(p, { previewOnly: true }), (err: unknown) => {
      assert.ok(err instanceof SubmissionBlockedError);
      assert.equal(err.message, `Privacy level zdr: no ZDR provider for ${MODEL} within routing.allowedProviders (groq)`);
      return true;
    });
    assert.equal(jobCount(jobsDir), 0);
    assert.equal(posted(fake).length, 0);
  }),
);

test(
  "standard with an allow-list: master's pin (fallbacks within the list); a chat job without a pin gets it too",
  withEnv({ level: "standard", routing: { allowedProviders: ["deepinfra", "groq"] } }, async ({ service, fake }) => {
    fake.submitReplies = [accepted("b1"), accepted("b2")];
    await service.createJob(await service.prepare(ASK), { previewOnly: false });
    await service.createChatJob(chatDraft(`${MODEL}:batch`));
    for (const body of posted(fake)) assert.deepEqual(body.provider, { only: ["deepinfra", "groq"], allow_fallbacks: true });
    // An explicit pin outside the list blocks at prepare (master's rule).
    assert.match((await service.prepare({ ...ASK, providerPin: "together" })).blockers.join("\n"), /not in routing.allowedProviders/);
  }),
);

// ------------------------------------------------------------ account requirements

test(
  "requireZdr without accountZdrEnforced: standard is blocked, zdr is allowed (pinned per request)",
  async () => {
    await withEnv({ level: "standard", routing: { requireZdr: true } }, async ({ service, fake, jobsDir }) => {
      const p = await service.prepare(ASK);
      assert.match(p.blockers.join("\n"), /routing\.requireZdr is set, but zero data retention cannot be requested on a batch submission/);
      // The enforcement point refuses it too (a chat job has no prepare step).
      await assert.rejects(service.createChatJob(chatDraft(`${MODEL}:batch`)), /routing\.requireZdr is set/);
      assert.equal(jobCount(jobsDir), 0);
      assert.equal(posted(fake).length, 0);
    })();
    await withEnv({ level: "zdr", routing: { requireZdr: true } }, async ({ service, fake }) => {
      const p = await service.prepare(ASK);
      assert.deepEqual(p.blockers, []);
      fake.submitReplies = [accepted()];
      const job = await service.createJob(p, { previewOnly: false });
      assert.equal(job.localStatus, "submitted", job.error?.message);
      assert.deepEqual(posted(fake)[0]!.provider, { only: ["anthropic", "azure/eu"], allow_fallbacks: false });
    })();
  },
);

test(
  "requireNoDataCollection: blocked at standard; met at no-training (attested) and at zdr",
  async () => {
    await withEnv({ level: "standard", routing: { requireNoDataCollection: true } }, async ({ service }) => {
      assert.match((await service.prepare(ASK)).blockers.join("\n"), /routing\.requireNoDataCollection is set/);
    })();
    await withEnv({ level: "no-training", accountNoTraining: true, routing: { requireNoDataCollection: true } }, async ({ service, fake }) => {
      const p = await service.prepare(ASK);
      assert.deepEqual(p.blockers, []);
      fake.submitReplies = [accepted()];
      const job = await service.createJob(p, { previewOnly: false });
      assert.equal(job.localStatus, "submitted", job.error?.message);
      assert.equal(job.privacy?.enforcement, "account attested no-training");
    })();
    await withEnv({ level: "zdr", routing: { requireNoDataCollection: true, requireZdr: true } }, async ({ service, fake }) => {
      const p = await service.prepare(ASK);
      assert.deepEqual(p.blockers, []);
      fake.submitReplies = [accepted()];
      assert.equal((await service.createJob(p, { previewOnly: false })).localStatus, "submitted");
    })();
  },
);

test(
  "a chat thread at zdr (project at standard, requireZdr set) is allowed and pinned",
  withEnv({ level: "standard", routing: { requireZdr: true, requireNoDataCollection: true, allowedProviders: ["azure"] } }, async ({ service, fake }) => {
    fake.submitReplies = [accepted()];
    const job = await service.createChatJob(chatDraft("openai/gpt-4o-mini:batch", "zdr"));
    assert.equal(job.localStatus, "submitted", job.error?.message);
    assert.equal(job.privacy?.level, "zdr");
    assert.deepEqual(posted(fake)[0]!.provider, { only: ["azure/eu"], allow_fallbacks: false });
  }),
);

test(
  "immediate route: no-training and zdr meet the requirements per request; standard does not",
  async () => {
    await withEnv({ level: "zdr", routing: { requireZdr: true, requireNoDataCollection: true } }, async ({ service, fake }) => {
      fake.chatReplies = [{ status: 200, body: chatCompletion() }];
      const job = await service.createChatJob(chatDraft("meta/llama-free:free"));
      assert.equal(job.route, "immediate");
      assert.deepEqual(fake.chatBodies()[0]!.provider, { zdr: true });
    })();
    await withEnv({ level: "no-training", routing: { requireNoDataCollection: true } }, async ({ service, fake }) => {
      fake.chatReplies = [{ status: 200, body: chatCompletion() }];
      const job = await service.createChatJob(chatDraft("meta/llama-free:free"));
      assert.equal(job.route, "immediate");
      assert.deepEqual(fake.chatBodies()[0]!.provider, { data_collection: "deny" });
    })();
    await withEnv({ level: "standard", routing: { requireNoDataCollection: true } }, async ({ service }) => {
      await assert.rejects(service.createChatJob(chatDraft("meta/llama-free:free")), /routing\.requireNoDataCollection is set/);
    })();
  },
);

test("formatPrivacyPolicy names a requirement the level satisfies (no-training only with the attestation)", () => {
  const cfg = makeConfig((c) => Object.assign(c.routing, { requireZdr: true, requireNoDataCollection: true }));
  assert.equal(formatPrivacyPolicy(cfg), "routing.requireZdr: on (NOT attested); routing.requireNoDataCollection: on (NOT attested)");
  assert.equal(formatPrivacyPolicy(cfg, { level: "zdr", accountNoTraining: false }), "routing.requireZdr: on (satisfied by privacy level zdr); routing.requireNoDataCollection: on (satisfied by privacy level zdr)");
  assert.equal(formatPrivacyPolicy(cfg, { level: "no-training", accountNoTraining: true }), "routing.requireZdr: on (NOT attested); routing.requireNoDataCollection: on (satisfied by privacy level no-training)");
  // On a batch, no-training meets requireNoDataCollection only with the no-training attestation.
  assert.equal(formatPrivacyPolicy(cfg, { level: "no-training", accountNoTraining: false }), "routing.requireZdr: on (NOT attested); routing.requireNoDataCollection: on (NOT attested) (needs /batch privacy attest)");
});

// ------------------------------------------------------------ standards mode x contract v2

const V2_LINES = fs.readFileSync(path.resolve("test", "fixtures", "contract", "tables.v2.valid.jsonl"), "utf8");
const STANDARDS = { domain: "pinpoint", ucPrefix: "PNPT_" };

function planV2(lines: string, standards = STANDARDS) {
  const text = lines.endsWith("\n") ? lines : lines + "\n";
  return planMetadataRun({
    context: { relPath: "context.md", bytes: Buffer.from("# Pinpoint\n"), text: "# Pinpoint\n" },
    input: { relPath: "tables.jsonl", bytes: Buffer.from(text), text },
    model: MODEL,
    maxTokens: 4000,
    limits: { maxRequests: 100, maxRows: 100, maxCharactersPerItem: 500_000, maxTotalCharacters: 5_000_000 },
    security: { scanSecrets: false, blockOnSecret: true, knownSecrets: [] },
    standards,
  });
}

const v2Records = (): Array<Record<string, unknown>> => V2_LINES.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
const jsonl = (records: Array<Record<string, unknown>>) => records.map((r) => JSON.stringify(r)).join("\n");

test("standards mode: matching v2 evidence plans fine, with both kinds of guidance", () => {
  const plan = planV2(V2_LINES);
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.items.length, 3);
  assert.equal(plan.tablesV2, 3);
  for (const it of plan.items) {
    for (const r of [...METADATA_V2_INSTRUCTIONS, ...METADATA_STANDARDS_INSTRUCTIONS]) assert.ok(it.prompt.includes(`- ${r}`));
  }
});

test("standards mode: a v2 layer that disagrees with the schema name blocks the table", () => {
  const recs = v2Records();
  recs[1]!.layer = "gold"; // demo_catalog.lighthouse_silver.…
  const plan = planV2(jsonl(recs));
  assert.match(plan.blockers.join("\n"), /evidence layer disagrees with the medallion layer[\s\S]*line 2: demo_catalog\.lighthouse_silver\.PNPT_location_data \(evidence layer gold, schema name silver\)/);
});

test('standards mode: layer "other" blocks the table, listing its name', () => {
  const recs = v2Records();
  recs[0]!.layer = "other";
  const plan = planV2(jsonl(recs));
  assert.match(plan.blockers.join("\n"), /evidence layer is "other"[\s\S]*line 1: demo_catalog\.lighthouse_bronze\.PNPT_loc/);
});

test("standards mode: a v2 layer stands in for a schema name without one", () => {
  const recs = v2Records();
  recs[0]!.table = "demo_catalog.lighthouse_raw.PNPT_loc";
  assert.deepEqual(planV2(jsonl(recs)).blockers, []);
  delete recs[0]!.layer;
  delete recs[0]!.contract_version;
  for (const c of recs[0]!.columns as Array<Record<string, unknown>>) delete c.profile;
  assert.match(planV2(jsonl(recs)).blockers.join("\n"), /schema names no medallion layer/);
});

test("standards mode: domain_prefix must match --uc-prefix (case-insensitive, without the trailing _)", () => {
  const recs = v2Records();
  recs[2]!.domain_prefix = "ABCD";
  const plan = planV2(jsonl(recs));
  assert.match(plan.blockers.join("\n"), /domain_prefix does not match the uc prefix PNPT_[\s\S]*line 3: demo_catalog\.lighthouse_gold\.PNPT_vw_location_data/);
  assert.deepEqual(planV2(V2_LINES, { domain: "pinpoint", ucPrefix: "PNPT_" }).blockers, []);
});

test("standards mode: v2 evidence outside standards mode is not checked for layer or domain_prefix", () => {
  const recs = v2Records();
  recs[0]!.layer = "other";
  recs[0]!.domain_prefix = "ABCD";
  const text = jsonl(recs) + "\n";
  const plan = planMetadataRun({
    context: { relPath: "context.md", bytes: Buffer.from("# Pinpoint\n"), text: "# Pinpoint\n" },
    input: { relPath: "tables.jsonl", bytes: Buffer.from(text), text },
    model: MODEL,
    maxTokens: 4000,
    limits: { maxRequests: 100, maxRows: 100, maxCharactersPerItem: 500_000, maxTotalCharacters: 5_000_000 },
    security: { scanSecrets: false, blockOnSecret: true, knownSecrets: [] },
  });
  assert.deepEqual(plan.blockers, []);
});

test("standards mode drops audit columns, and their profiles, from the prompt; existing_tags and v2 fields validate together", () => {
  const ev = v2Records()[1] as unknown as TableEvidence & { columns: Array<Record<string, unknown>> };
  const audit = { name: "fw_ingestdate", data_type: "TIMESTAMP", nullable: true, existing_comment: null, existing_tags: { pii: "false" }, profile: { disclosure_tier: 2, tier_reason: "audit timestamp" } };
  const withAudit = { ...ev, existing_tags: { owner_team: "lighthouse" }, columns: [...ev.columns, audit] } as unknown as TableEvidence;
  const plan = planV2(JSON.stringify(withAudit));
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.auditColumns, 1);
  const sent = promptEvidence(withAudit, STANDARDS);
  assert.ok(!sent.columns.some((c) => c.name === "fw_ingestdate"));
  const prompt = renderMetadataPrompt("# Pinpoint", withAudit, STANDARDS);
  assert.doesNotMatch(prompt, /fw_ingestdate|audit timestamp/);
});

// ------------------------------------------------------------ post-review fixes

test("immediate provider fields: allow-list as provider.only (list order) with the privacy fields", () => {
  const list = { only: ["groq", "azure"], allowFallbacks: true };
  assert.deepEqual(immediateProviderFields("standard", list), { only: ["groq", "azure"] });
  assert.deepEqual(immediateProviderFields("no-training", list), { only: ["groq", "azure"], data_collection: "deny" });
  assert.deepEqual(immediateProviderFields("zdr", list), { only: ["groq", "azure"], zdr: true });
  assert.deepEqual(immediateProviderFields("zdr", { only: ["groq"], allowFallbacks: false }), { only: ["groq"], allow_fallbacks: false, zdr: true });
  assert.deepEqual(immediateProviderFields("standard", { only: [], allowFallbacks: false }), {});
});

test("immediate route: a non-empty allow-list is sent as provider.only; without one the body is unchanged", async () => {
  const cases: Array<{ level: BatchConfig["privacy"]["level"]; routing: Partial<BatchConfig["routing"]>; provider: unknown }> = [
    { level: "standard", routing: { allowedProviders: ["groq", "azure"] }, provider: { only: ["groq", "azure"] } },
    { level: "no-training", routing: { allowedProviders: ["groq", "azure"] }, provider: { only: ["groq", "azure"], data_collection: "deny" } },
    { level: "zdr", routing: { allowedProviders: ["groq", "azure"] }, provider: { only: ["groq", "azure"], zdr: true } },
    { level: "zdr", routing: { allowedProviders: ["azure"], allowFallbacks: false }, provider: { only: ["azure"], allow_fallbacks: false, zdr: true } },
    { level: "zdr", routing: {}, provider: { zdr: true } },
    { level: "standard", routing: {}, provider: undefined },
  ];
  for (const c of cases) {
    await withEnv({ level: c.level, routing: c.routing }, async ({ service, fake }) => {
      fake.chatReplies = [{ status: 200, body: chatCompletion() }];
      const job = await service.createChatJob(chatDraft("meta/llama-free:free"));
      assert.equal(job.route, "immediate");
      const body = fake.chatBodies()[0]!;
      assert.deepEqual(body.provider, c.provider, JSON.stringify(c));
      if (c.provider === undefined) assert.ok(!("provider" in body));
    })();
  }
});

test(
  "immediate route: a requirement refusal does not mention a batch submission",
  withEnv({ level: "standard", routing: { requireZdr: true } }, async ({ service }) => {
    await assert.rejects(service.createChatJob(chatDraft("meta/llama-free:free")), (err: unknown) => {
      assert.ok(err instanceof SubmissionBlockedError);
      assert.doesNotMatch(err.message, /batch submission/);
      assert.match(err.message, /^routing\.requireZdr is set, but it cannot be guaranteed for this request at privacy level standard without the account attestation/);
      return true;
    });
  }),
);

test("model picker at zdr: a batch model with no ZDR endpoint in the allow-list is blocked with decidePrivacy's reason", () => {
  const snap = { fresh: true, loadedAt: new Date().toISOString(), models: [{ id: "meta/llama-free:free", free: true }], zdr: ZDR, batchEndpoints: batchEndpointsMatchingZdr(ZDR) } as never;
  const blocked = pickerEntries(snap, [MODEL], "zdr", false, ["groq"]).find((e) => e.id === MODEL)!;
  assert.equal(blocked.blocked, `Privacy level zdr: no ZDR provider for ${MODEL} within routing.allowedProviders (groq)`);
  assert.equal(pickerEntries(snap, [MODEL], "zdr", false, ["azure"]).find((e) => e.id === MODEL)!.blocked, undefined);
  assert.equal(pickerEntries(snap, [MODEL], "zdr", false).find((e) => e.id === MODEL)!.blocked, undefined);
  assert.equal(pickerEntries(snap, [MODEL], "standard", false, ["groq"]).find((e) => e.id === MODEL)!.blocked, undefined);
});

test("/batch privacy status shows the routing policy", () => {
  const cfg = makeConfig((c) => Object.assign(c.routing, { allowedProviders: ["azure"], allowFallbacks: false, requireZdr: true }));
  const routing = formatRoutingPolicy(cfg, { level: "zdr", accountNoTraining: false });
  assert.equal(routing, "Provider allow-list: azure (no fallbacks); routing.requireZdr: on (satisfied by privacy level zdr); routing.requireNoDataCollection: off");
  const text = formatPrivacyStatus({ level: "zdr", source: "project", accountNoTraining: false, snapshot: undefined, routing });
  assert.match(text, /^Routing: Provider allow-list: azure \(no fallbacks\); routing.requireZdr: on/m);
});

test("previews at zdr show the ZDR pin note instead of the allow-list pin", async () => {
  assert.equal(previewPin({ only: ["azure"], allow_fallbacks: true }, "zdr"), ZDR_PIN_PREVIEW);
  assert.equal(previewPin({ only: ["azure"], allow_fallbacks: true }, "standard"), "azure (fallbacks within the list)");
  const root = metadataWorkspace();
  try {
    const cfg = makeConfig((c) => {
      c.privacy.level = "zdr";
      c.routing.allowedProviders = ["azure"];
    });
    const service = makeService(root, new FakeOpenRouter(), cfg);
    const p = await service.planMetadata({ context: "metadata/beverage/context.md", input: "metadata/beverage/tables.jsonl" });
    assert.deepEqual(p.pin, { only: ["azure"], allow_fallbacks: true });
    const privacy = service.privacyConfig();
    const text = formatMetadataPreview(p, true, formatPrivacyPolicy(cfg, privacy), privacy.level);
    assert.match(text, new RegExp(`Provider pin:\\s+${ZDR_PIN_PREVIEW}`));
    assert.match(text, /Privacy level:\s+zdr/);
    assert.doesNotMatch(formatMetadataPreview(p, true), new RegExp(ZDR_PIN_PREVIEW));
  } finally {
    rm(root);
  }
});
test(
  "synthesis keeps its source's stricter level: source at zdr, project at standard",
  withEnv({ level: "zdr", routing: { requireZdr: true } }, async ({ service, fake, cfg }) => {
    fake.submitReplies = [accepted("batch_src")];
    const src = await service.createJob(await service.prepare(ASK), { previewOnly: false });
    assert.equal(src.privacy?.level, "zdr");
    fake.getReplies = [{ status: 200, body: completed([successItem(src.customIds[0]!, "a finding")], { id: "batch_src" }) }];
    await service.reconcile(src.localId, { force: true });
    cfg.privacy.level = "standard";
    const prep = await service.prepareSynthesis(src.localId, { allowPartial: false });
    assert.deepEqual(prep.blockers, [], "requireZdr is met by the source's zdr level at prepare too");
    fake.submitReplies = [accepted("batch_syn")];
    const syn = await service.createSynthesisJob(prep, { previewOnly: false });
    assert.equal(syn.privacy?.level, "zdr");
    assert.deepEqual(posted(fake).at(-1)!.provider, { only: ["anthropic", "azure/eu"], allow_fallbacks: false });
  }),
);

test(
  "submit re-checks routing: a requirement set after the preview refuses it, and it stays previewed",
  withEnv({ level: "standard" }, async ({ service, fake, cfg }) => {
    const preview = await service.createJob(await service.prepare(ASK), { previewOnly: true });
    cfg.routing.requireZdr = true;
    fake.submitReplies = [accepted()];
    await assert.rejects(service.submit(preview.localId), (err: unknown) => {
      assert.ok(err instanceof SubmissionBlockedError);
      assert.match(err.message, new RegExp(`^Privacy level standard: ${preview.localId} cannot be sent: routing\\.requireZdr is set`));
      return true;
    });
    assert.equal(posted(fake).length, 0);
    assert.equal(service.registry.read(preview.localId).localStatus, "previewed");
    cfg.routing.accountZdrEnforced = true;
    assert.equal((await service.submit(preview.localId)).localStatus, "submitted");
  }),
);

test(
  "submit re-checks routing: a stored pin outside the current allow-list is refused, and it stays previewed",
  withEnv({ level: "standard", routing: { allowedProviders: ["deepinfra"] } }, async ({ service, fake, cfg }) => {
    const pinned = await service.createJob(await service.prepare(ASK), { previewOnly: true });
    cfg.routing.allowedProviders = ["groq"];
    fake.submitReplies = [accepted()];
    await assert.rejects(service.submit(pinned.localId), (err: unknown) => {
      assert.ok(err instanceof SubmissionBlockedError);
      assert.match(err.message, new RegExp(`^Privacy level standard: ${pinned.localId} cannot be sent: provider pin "deepinfra" is not in routing.allowedProviders \\(groq\\)`));
      return true;
    });
    assert.equal(service.registry.read(pinned.localId).localStatus, "previewed");
    assert.equal(posted(fake).length, 0);
  }),
);

test(
  "submit re-checks routing: an unpinned preview is refused once an allow-list is set",
  withEnv({ level: "standard" }, async ({ service, fake, cfg }) => {
    const preview = await service.createJob(await service.prepare(ASK), { previewOnly: true });
    cfg.routing.allowedProviders = ["groq"];
    await assert.rejects(service.submit(preview.localId), /^SubmissionBlockedError: Privacy level standard: .* the stored request has no provider pin/);
    assert.equal(service.registry.read(preview.localId).localStatus, "previewed");
    assert.equal(posted(fake).length, 0);
  }),
);