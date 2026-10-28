import assert from "node:assert/strict";
import test from "node:test";
import { ChatJobError, type BatchService } from "../src/service.js";
import type { ChatMessage } from "../src/openrouter/types.js";
import type { JobManifest } from "../src/types.js";
import { FakeOpenRouter, accepted, makeService } from "./fixtures/fake-openrouter.js";
import { completed, failedItem, successItem } from "./fixtures/openrouter.js";
import { rm, tempWorkspace } from "./helpers.js";

const MAIN: ChatMessage[] = [
  { role: "system", content: "You are helpful." },
  { role: "user", content: "hello there" },
];
const TITLE: ChatMessage[] = [{ role: "user", content: "Title this: hello there" }];

function withService(fn: (service: BatchService, fake: FakeOpenRouter) => Promise<void>): () => Promise<void> {
  return async () => {
    const root = tempWorkspace();
    try {
      const fake = new FakeOpenRouter();
      await fn(makeService(root, fake), fake);
    } finally {
      rm(root);
    }
  };
}

async function newChatJob(service: BatchService, fake: FakeOpenRouter): Promise<JobManifest> {
  fake.submitReplies = [accepted()];
  return service.createChatJob({
    threadId: "T-20261026-ABCD",
    purpose: "turn",
    throughSeq: 3,
    model: "openai/gpt-4o-mini",
    account: "default",
    main: MAIN,
    title: TITLE,
  });
}

test(
  "createChatJob submits a 2-item chat job",
  withService(async (service, fake) => {
    const job = await newChatJob(service, fake);
    assert.equal(job.kind, "chat");
    assert.equal(job.schemaVersion, 4);
    assert.deepEqual(job.chat, { threadId: "T-20261026-ABCD", purpose: "turn", throughSeq: 3, titleItem: true });
    assert.equal(job.requestCount, 2);
    assert.equal(job.objective, "Chat turn in T-20261026-ABCD");
    assert.equal(job.localStatus, "submitted");
    const posted = JSON.parse(fake.requests[0]!.body as string);
    assert.deepEqual(posted.requests[0].body.messages, MAIN);
    assert.deepEqual(posted.requests[1].body.messages, TITLE);
    assert.deepEqual(job.items!.map((i) => i.source), [
      { kind: "goal", label: "chat-reply" },
      { kind: "goal", label: "chat-title" },
    ]);
  }),
);

test(
  "chat job with a failed title item settles partial but the reply item is completed",
  withService(async (service, fake) => {
    const job = await newChatJob(service, fake);
    fake.getReplies = [{ status: 200, body: completed([successItem(job.customIds[0]!, "hi"), failedItem(job.customIds[1]!)]) }];
    const r = await service.reconcile(job.localId, { force: true });
    assert.equal(r.status, "partial");
    const done = service.registry.read(job.localId);
    assert.equal(done.items![0]!.status, "completed");
  }),
);

test(
  "guards refuse chat jobs",
  withService(async (service, fake) => {
    const job = await newChatJob(service, fake);
    const id = job.localId;
    const calls: Array<() => unknown> = [
      () => service.buildInjection(id, "full"),
      () => service.retry(id),
      () => service.retryItems(id, { failed: true }),
      () => service.prepareSynthesis(id, { allowPartial: false } as never),
      () => service.exportResults(id, { format: "csv" }),
    ];
    for (const call of calls) {
      await assert.rejects(
        async () => call(),
        (e: unknown) => e instanceof ChatJobError && (e as Error).message === `${id} is a batch chat job; use /batch chat instead.`,
      );
    }
  }),
);
