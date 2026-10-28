import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import type { BatchConfig } from "../src/config.js";
import { sha256Hex } from "../src/fsutil.js";
import { ModelCatalog } from "../src/models/catalog.js";
import { OpenRouterBatchClient } from "../src/openrouter/client.js";
import type { ZdrEndpoint } from "../src/privacy/policy.js";
import { JobRegistry } from "../src/registry.js";
import { BatchService, DuplicateActiveRequestError, SubmissionBlockedError, type AskOptions } from "../src/service.js";
import { CLASSIFY_YAML, TICKETS_CSV } from "./fixtures/datasets.js";
import { FAKE_KEY, FakeOpenRouter, accepted, makeConfig } from "./fixtures/fake-openrouter.js";
import { chatCompletion, completed, successItem } from "./fixtures/openrouter.js";
import { rm, tempWorkspace, writeFiles } from "./helpers.js";
import { batchEndpointsMatchingZdr } from "./fixtures/catalog.js";

const ASK: AskOptions = { objective: "Review the authentication design", files: ["src/auth.ts"], contexts: [], format: "markdown", includeInstructions: true };

const ZDR: ZdrEndpoint[] = [
  { model: "anthropic/claude-opus-5.5", provider: "azure/eu" },
  { model: "anthropic/claude-opus-5.5", provider: "anthropic" },
  { model: "openai/gpt-oss-20b", provider: "azure/eu" },
  { model: "openai/gpt-4o-mini", provider: "azure/eu" },
];

/**
 * Captured from the code BEFORE privacy enforcement existed (commit 55a2c38):
 * the `/batch ask` job built from ASK at the default config. Request bytes at
 * `standard` must never change (duplicate detection hashes them).
 */
const STANDARD_SNAPSHOT = {
  /** sha256 of submitted-request.json with the job's custom_ids replaced by "{custom_id}". */
  maskedRequestSha256: "c524672c54b75755a7a475d989cb4bd55bff0d6ff7a88ce5faff0ceed0b73620",
  contentSha256: "828fc9b5d7e7fa6ec6e297dfa06214836d95ef595ea819b093bd8cb33152f67f",
};

async function stubCatalog(zdr: ZdrEndpoint[] | Error, file: string): Promise<ModelCatalog> {
  const catalog = new ModelCatalog({
    fetch: async () => {
      if (zdr instanceof Error) throw zdr;
      return { models: [], zdr, batchEndpoints: batchEndpointsMatchingZdr(zdr) };
    },
    file,
  });
  await catalog.load();
  return catalog;
}

interface Ctx {
  root: string;
  fake: FakeOpenRouter;
  cfg: BatchConfig;
  service: BatchService;
  jobsDir: string;
}

function withEnv(opts: { level?: BatchConfig["privacy"]["level"]; accountNoTraining?: boolean; catalog?: ZdrEndpoint[] | Error | null }, fn: (ctx: Ctx) => Promise<void>): () => Promise<void> {
  return async () => {
    const root = tempWorkspace("pi batch privacy-");
    writeFiles(root, {
      "src/auth.ts": "export function login() { return true; }\r\n",
      ".pi/batch-workflows/classify-tickets.yaml": CLASSIFY_YAML,
      "data/tickets.csv": TICKETS_CSV,
    });
    try {
      const fake = new FakeOpenRouter();
      const cfg = makeConfig((c) => {
        c.privacy.level = opts.level ?? "standard";
        c.privacy.accountNoTraining = opts.accountNoTraining ?? false;
      });
      const catalog = opts.catalog === null ? undefined : await stubCatalog(opts.catalog ?? ZDR, path.join(root, "catalog.json"));
      const jobsDir = path.join(root, ".pi", "batches");
      const service = new BatchService({
        registry: new JobRegistry(jobsDir),
        workspaceRoot: root,
        getConfig: () => cfg,
        resolveApiKey: async () => FAKE_KEY,
        createClient: (apiKey, timeoutMs) => new OpenRouterBatchClient({ apiKey, fetchImpl: fake.fetch, timeoutMs }),
        gitIgnored: () => new Set(),
        ...(catalog ? { catalog } : {}),
      });
      await fn({ root, fake, cfg, service, jobsDir });
    } finally {
      rm(root);
    }
  };
}

function jobDirs(jobsDir: string): string[] {
  if (!fs.existsSync(jobsDir)) return [];
  return fs.readdirSync(jobsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
}

function postedBodies(fake: FakeOpenRouter): string[] {
  return fake.requests.filter((r) => r.method === "POST" && r.url.endsWith("/batches")).map((r) => r.body ?? "");
}

function maskedSha(service: BatchService, localId: string, customIds: string[]): string {
  let text = fs.readFileSync(service.registry.artefact(localId, "submittedRequest"), "utf8");
  for (const id of customIds) text = text.split(id).join("{custom_id}");
  return sha256Hex(text);
}

for (const withCatalog of [false, true]) {
  test(
    `standard request bytes are unchanged (${withCatalog ? "with" : "without"} a catalog)`,
    withEnv({ level: "standard", catalog: withCatalog ? ZDR : null }, async ({ service, fake }) => {
      fake.submitReplies = [accepted()];
      const job = await service.createJob(await service.prepare(ASK), { previewOnly: false });
      assert.equal(job.localStatus, "submitted");
      assert.equal(maskedSha(service, job.localId, job.customIds), STANDARD_SNAPSHOT.maskedRequestSha256);
      assert.equal(job.contentSha256, STANDARD_SNAPSHOT.contentSha256);
      const posted = postedBodies(fake)[0]!;
      assert.equal(posted, fs.readFileSync(service.registry.artefact(job.localId, "submittedRequest"), "utf8"));
      assert.equal(JSON.parse(posted).provider, undefined);
    }),
  );
}

test(
  "zdr pins every creation path",
  withEnv({ level: "zdr" }, async ({ service, fake, cfg }) => {
    const expectOpus = { only: ["anthropic", "azure/eu"], allow_fallbacks: false };
    const expectEu = { only: ["azure/eu"], allow_fallbacks: false };

    fake.submitReplies = [accepted("batch_ask")];
    const ask = await service.createJob(await service.prepare(ASK), { previewOnly: false });
    fake.submitReplies = [accepted("batch_wf")];
    const wf = await service.createWorkflowJob(
      await service.planMapFiles({ objective: "Review this file for defects.", files: ["src/auth.ts"], contexts: [], format: "markdown", includeInstructions: true }),
      { previewOnly: false },
    );
    fake.submitReplies = [accepted("batch_ds")];
    const ds = await service.createDatasetJob(await service.planDataset({ workflow: "classify-tickets", input: "data/tickets.csv" }), { previewOnly: false });
    fake.submitReplies = [accepted("batch_chat")];
    const chat = await service.createChatJob({
      threadId: "T-20261026-ABCD",
      purpose: "turn",
      throughSeq: 1,
      model: "openai/gpt-4o-mini",
      account: "default",
      main: [{ role: "user", content: "hello" }],
    });

    const jobs = [ask, wf, ds, chat];
    for (const j of jobs) assert.equal(j.localStatus, "submitted", `${j.localId} ${j.error?.message}`);
    const posted = postedBodies(fake).map((b) => JSON.parse(b));
    assert.deepEqual(posted[0].provider, expectOpus);
    assert.deepEqual(posted[1].provider, expectOpus);
    assert.deepEqual(posted[2].provider, expectEu);
    assert.deepEqual(posted[3].provider, expectEu);
    for (const j of jobs) {
      assert.equal(j.privacy?.level, "zdr");
      assert.equal(j.privacy?.route, "batch");
      assert.match(j.privacy!.enforcement, /ZDR/);
    }
    assert.deepEqual(ask.providerPin, expectOpus);

    // Retry of a job created at standard is re-evaluated at the CURRENT level.
    cfg.privacy.level = "standard";
    fake.submitReplies = [accepted("batch_std")];
    const std = await service.createJob(await service.prepare({ ...ASK, objective: "Another review" }), { previewOnly: false });
    assert.equal(std.privacy?.level, "standard");
    assert.equal(JSON.parse(postedBodies(fake).at(-1)!).provider, undefined);
    fake.getReplies = [{ status: 200, body: completed([successItem(std.customIds[0]!, "ok")], { id: "batch_std" }) }];
    await service.reconcile(std.localId, { force: true });
    cfg.privacy.level = "zdr";
    fake.submitReplies = [accepted("batch_retry")];
    const retried = await service.retry(std.localId);
    assert.equal(retried.privacy?.level, "zdr");
    assert.deepEqual(JSON.parse(postedBodies(fake).at(-1)!).provider, expectOpus);
  }),
);

test(
  "zdr refusal persists nothing",
  withEnv({ level: "zdr", catalog: [] }, async ({ service, fake, jobsDir }) => {
    fake.submitReplies = [accepted()];
    const prepared = await service.prepare(ASK);
    await assert.rejects(service.createJob(prepared, { previewOnly: false }), (err: unknown) => {
      assert.ok(err instanceof SubmissionBlockedError);
      // No ZDR endpoint at all: the definitive refusal, whatever its batch endpoints (a refresh can't help).
      assert.equal(err.message, "Privacy level zdr: anthropic/claude-opus-5.5 has no batch endpoint on OpenRouter's ZDR list (its batch endpoints: unknown; ZDR endpoints: none)");
      return true;
    });
    assert.deepEqual(jobDirs(jobsDir), []);
    assert.equal(postedBodies(fake).length, 0);
  }),
);

test(
  "zdr refuses when the catalog failed to load this session, or no catalog is wired",
  async () => {
    for (const catalog of [new Error("offline"), null] as const) {
      await withEnv({ level: "zdr", catalog }, async ({ service, fake, jobsDir }) => {
        await assert.rejects(service.createJob(await service.prepare(ASK), { previewOnly: false }), /^SubmissionBlockedError: Privacy level zdr: model catalog not loaded/);
        assert.deepEqual(jobDirs(jobsDir), []);
        assert.equal(postedBodies(fake).length, 0);
      })();
    }
  },
);

test(
  "duplicate detection still works at zdr, where the decided pin differs from the prepared one",
  withEnv({ level: "zdr" }, async ({ service, fake, jobsDir }) => {
    fake.submitReplies = [accepted()];
    const first = await service.createJob(await service.prepare(ASK), { previewOnly: false });
    assert.equal(first.localStatus, "submitted");
    await assert.rejects(service.createJob(await service.prepare(ASK), { previewOnly: false }), DuplicateActiveRequestError);
    assert.equal(jobDirs(jobsDir).length, 1);
    assert.equal(postedBodies(fake).length, 1);
  }),
);

test(
  "user provider pin outside ZDR is refused",
  withEnv({ level: "zdr" }, async ({ service, fake, jobsDir }) => {
    const prepared = await service.prepare({ ...ASK, providerPin: "notzdr" });
    await assert.rejects(service.createJob(prepared, { previewOnly: false }), (err: unknown) => {
      assert.ok(err instanceof SubmissionBlockedError);
      assert.match(err.message, /no ZDR provider/);
      return true;
    });
    assert.deepEqual(jobDirs(jobsDir), []);
    assert.equal(postedBodies(fake).length, 0);
  }),
);

test(
  "user provider pin inside ZDR is narrowed, not widened",
  withEnv({ level: "zdr" }, async ({ service, fake }) => {
    fake.submitReplies = [accepted()];
    const job = await service.createJob(await service.prepare({ ...ASK, providerPin: "azure/eu" }), { previewOnly: false });
    assert.deepEqual(JSON.parse(postedBodies(fake)[0]!).provider, { only: ["azure/eu"], allow_fallbacks: false });
    assert.equal(job.privacy?.level, "zdr");
  }),
);

test(
  "no-training batch requires attestation",
  async () => {
    await withEnv({ level: "no-training", accountNoTraining: false }, async ({ service, fake, jobsDir }) => {
      await assert.rejects(service.createJob(await service.prepare(ASK), { previewOnly: false }), (err: unknown) => {
        assert.ok(err instanceof SubmissionBlockedError);
        assert.match(err.message, /^Privacy level no-training: /);
        return true;
      });
      assert.deepEqual(jobDirs(jobsDir), []);
      assert.equal(postedBodies(fake).length, 0);
    })();
    await withEnv({ level: "no-training", accountNoTraining: true }, async ({ service, fake }) => {
      fake.submitReplies = [accepted()];
      const job = await service.createJob(await service.prepare(ASK), { previewOnly: false });
      assert.equal(job.localStatus, "submitted");
      assert.deepEqual(job.privacy, { level: "no-training", route: "batch", enforcement: "account attested no-training" });
      assert.equal(JSON.parse(postedBodies(fake)[0]!).provider, undefined);
    })();
  },
);

test(
  "a batch body never contains data_collection or zdr",
  async () => {
    for (const level of ["standard", "no-training", "zdr"] as const) {
      await withEnv({ level, accountNoTraining: true }, async ({ service, fake }) => {
        fake.submitReplies = [accepted()];
        const job = await service.createJob(await service.prepare(ASK), { previewOnly: false });
        assert.equal(job.privacy?.level, level);
        const posted = postedBodies(fake);
        assert.equal(posted.length, 1);
        for (const text of posted) {
          assert.doesNotMatch(text, /data_collection/);
          assert.doesNotMatch(text, /"zdr"/);
        }
      })();
    }
  },
);

test(
  "a draft's own privacy level wins only when stricter: chat job at zdr with project at standard",
  withEnv({ level: "standard" }, async ({ service, fake }) => {
    fake.submitReplies = [accepted()];
    const job = await service.createChatJob({
      threadId: "T-20261026-ABCD",
      purpose: "turn",
      throughSeq: 1,
      model: "openai/gpt-4o-mini:batch",
      account: "default",
      main: [{ role: "user", content: "hello" }],
      privacyLevel: "zdr",
    });
    assert.equal(job.privacy?.level, "zdr");
    assert.deepEqual(JSON.parse(postedBodies(fake)[0]!).provider, { only: ["azure/eu"], allow_fallbacks: false });
  }),
);

test(
  "immediate route records privacy without a pin",
  async () => {
    const cases = [
      { level: "standard", enforcement: "none" },
      { level: "no-training", enforcement: "immediate: data_collection=deny" },
      { level: "zdr", enforcement: "immediate: zdr=true" },
    ] as const;
    for (const c of cases) {
      // No attestation and an empty ZDR list: neither applies to the immediate route.
      await withEnv({ level: c.level, catalog: [] }, async ({ service, fake }) => {
        fake.chatReplies = [{ status: 200, body: chatCompletion() }];
        const job = await service.createChatJob({
          threadId: "T-20261026-ABCD",
          purpose: "turn",
          throughSeq: 1,
          model: "meta/llama-free:free",
          account: "default",
          main: [{ role: "user", content: "hello" }],
        });
        assert.deepEqual(job.privacy, { level: c.level, route: "immediate", enforcement: c.enforcement });
        assert.equal(job.route, "immediate");
        assert.equal(job.providerPin, undefined);
        assert.equal(postedBodies(fake).length, 0);
      })();
    }
  },
);

// ------------------------------------------------------------ fix round 1

test(
  "a preview made at a lower level is refused at submit after the level is raised, and stays previewed",
  withEnv({ level: "standard" }, async ({ service, fake, cfg }) => {
    const preview = await service.createJob(await service.prepare(ASK), { previewOnly: true });
    assert.equal(preview.privacy?.level, "standard");
    cfg.privacy.level = "zdr";
    fake.submitReplies = [accepted()];
    await assert.rejects(service.submit(preview.localId), (err: unknown) => {
      assert.ok(err instanceof SubmissionBlockedError);
      assert.equal(err.message, `Privacy level zdr: ${preview.localId} was prepared at standard; cancel it and create it again`);
      return true;
    });
    assert.equal(postedBodies(fake).length, 0);
    assert.equal(service.registry.read(preview.localId).localStatus, "previewed");
  }),
);

test(
  "a preview from before privacy levels (no privacy field) counts as standard at submit",
  withEnv({ level: "standard" }, async ({ service, fake, cfg }) => {
    const preview = await service.createJob(await service.prepare(ASK), { previewOnly: true });
    service.registry.update(preview.localId, (u) => {
      delete u.manifest.privacy;
    });
    cfg.privacy.level = "no-training";
    cfg.privacy.accountNoTraining = true;
    await assert.rejects(service.submit(preview.localId), /^SubmissionBlockedError: Privacy level no-training: .* was prepared at standard/);
    assert.equal(postedBodies(fake).length, 0);
    assert.equal(service.registry.read(preview.localId).localStatus, "previewed");
  }),
);

test(
  "a preview recorded at zdr submits normally with the config at zdr or standard",
  async () => {
    for (const later of ["zdr", "standard"] as const) {
      await withEnv({ level: "zdr" }, async ({ service, fake, cfg }) => {
        const preview = await service.createJob(await service.prepare(ASK), { previewOnly: true });
        cfg.privacy.level = later;
        fake.submitReplies = [accepted()];
        const job = await service.submit(preview.localId);
        assert.equal(job.localStatus, "submitted");
        assert.deepEqual(JSON.parse(postedBodies(fake)[0]!).provider, { only: ["anthropic", "azure/eu"], allow_fallbacks: false });
      })();
    }
  },
);

test(
  "an immediate-route chat job is sent through chat completions with its provider fields, never to /batches",
  withEnv({ level: "zdr", catalog: [] }, async ({ service, fake, jobsDir }) => {
    fake.submitReplies = [new Error("an immediate job must never reach /batches")];
    fake.chatReplies = [{ status: 200, body: chatCompletion() }];
    const job = await service.createChatJob({
      threadId: "T-20261026-ABCD",
      purpose: "turn",
      throughSeq: 1,
      model: "meta/llama-free:free",
      account: "default",
      main: [{ role: "user", content: "hello" }],
    });
    assert.equal(job.localStatus, "ready", job.error?.message);
    assert.equal(postedBodies(fake).length, 0);
    const chat = fake.chatBodies();
    assert.equal(chat.length, 1);
    assert.deepEqual(chat[0]!.provider, { zdr: true });
    assert.deepEqual(jobDirs(jobsDir), [job.localId], "no orphan preview is left behind");
  }),
);

const CHAT_ONLY = "Free models run only in batch chat (/batch chat); /batch ask and workflows need a batch model";

test(
  "/batch ask with a free model is refused before anything is persisted or sent",
  async () => {
    for (const previewOnly of [true, false]) {
      await withEnv({ level: "standard" }, async ({ service, fake, jobsDir }) => {
        await assert.rejects(service.createJob(await service.prepare({ ...ASK, model: "meta/llama-free:free" }), { previewOnly }), (err: unknown) => {
          assert.ok(err instanceof SubmissionBlockedError);
          assert.equal(err.message, CHAT_ONLY);
          return true;
        });
        assert.deepEqual(jobDirs(jobsDir), []);
        assert.equal(fake.requests.length, 0);
      })();
    }
  },
);

test(
  "a map-files workflow with a free model is refused before anything is persisted or sent",
  withEnv({ level: "standard" }, async ({ service, fake, jobsDir }) => {
    const plan = await service.planMapFiles({ objective: "Review this file for defects.", files: ["src/auth.ts"], contexts: [], format: "markdown", includeInstructions: true, model: "meta/llama-free:free" });
    assert.deepEqual(plan.blockers, []);
    await assert.rejects(service.createWorkflowJob(plan, { previewOnly: false }), (err: unknown) => {
      assert.ok(err instanceof SubmissionBlockedError);
      assert.equal(err.message, CHAT_ONLY);
      return true;
    });
    assert.deepEqual(jobDirs(jobsDir), []);
    assert.equal(fake.requests.length, 0);
  }),
);

test(
  "a retry keeps its source's stricter level when the project level is lower",
  withEnv({ level: "zdr" }, async ({ service, fake, cfg }) => {
    fake.submitReplies = [accepted("batch_src")];
    const src = await service.createJob(await service.prepare(ASK), { previewOnly: false });
    assert.equal(src.privacy?.level, "zdr");
    fake.getReplies = [{ status: 200, body: completed([successItem(src.customIds[0]!, "ok")], { id: "batch_src" }) }];
    await service.reconcile(src.localId, { force: true });
    cfg.privacy.level = "standard";
    fake.submitReplies = [accepted("batch_retry")];
    const retried = await service.retry(src.localId);
    assert.equal(retried.localStatus, "submitted");
    assert.equal(retried.privacy?.level, "zdr");
    assert.deepEqual(JSON.parse(postedBodies(fake).at(-1)!).provider, { only: ["anthropic", "azure/eu"], allow_fallbacks: false });
  }),
);
