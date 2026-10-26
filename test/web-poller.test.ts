import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ArtifactService } from "../src/artifacts/service.js";
import { ArtifactStore } from "../src/artifacts/store.js";
import { ChatService } from "../src/chat/service.js";
import { ThreadStore } from "../src/chat/store.js";
import { BatchPoller } from "../src/poller.js";
import { BatchRuntime } from "../src/runtime.js";
import { BatchWebServer } from "../src/web/server.js";
import { FakeOpenRouter, accepted, makeConfig, makeService } from "./fixtures/fake-openrouter.js";
import { completed, successItem } from "./fixtures/openrouter.js";
import { rm, tempWorkspace } from "./helpers.js";

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("U-I1: switching workspace in the web UI never stops the runtime's (Pi's) poller; the web server polls the other workspace itself", async () => {
  const root = tempWorkspace();
  const other = tempWorkspace();
  const fake = new FakeOpenRouter();
  const cfg = makeConfig();
  const batch = makeService(root, fake, cfg);
  const store = new ThreadStore(join(root, ".pi/batches/threads"));
  const chat = new ChatService({ store, batch, workspaceRoot: root, getConfig: () => cfg });
  const artifacts = new ArtifactService({ batch, workspaceRoot: root, getConfig: () => cfg, store: new ArtifactStore(join(root, ".pi/batches/artifacts")) });
  const piPoller = new BatchPoller(() => batch, () => false);
  piPoller.start();
  const web = new BatchWebServer({ workspaceRoot: root, service: batch, chat, chatStore: store, artifacts, poller: piPoller, getConfig: () => cfg });
  await web.start(0, "127.0.0.1");
  try {
    web.switchWorkspace(other);
    assert.equal(piPoller.isRunning, true, "Pi's poller keeps running");
    assert.notEqual(web.activePoller, piPoller);
    assert.equal(web.activePoller.isRunning, true, "the web server polls the workspace it switched to");
    const owned = web.activePoller;

    // Switching back reuses Pi's runtime instead of polling the same workspace twice.
    web.switchWorkspace(root);
    assert.equal(web.activePoller, piPoller);
    assert.equal(owned.isRunning, false);
    assert.equal(piPoller.isRunning, true);

    web.switchWorkspace(other);
    const owned2 = web.activePoller;
    await web.stop();
    assert.equal(owned2.isRunning, false, "the web server's own poller stops with it");
    assert.equal(piPoller.isRunning, true, "stopping the web server leaves Pi's poller alone");
  } finally {
    piPoller.stop();
    await web.stop();
    rm(root);
    rm(other);
  }
});

test("U-I1: a new Pi session stops a running web server bound to the old one", async () => {
  const rt = new BatchRuntime({} as ExtensionAPI);
  let stopped = 0;
  rt.webServer = { stop: async () => void stopped++ } as unknown as BatchWebServer;
  assert.equal(await rt.stopWebServerForSessionChange(), true);
  assert.equal(stopped, 1);
  assert.equal(rt.webServer, null);
  assert.equal(await rt.stopWebServerForSessionChange(), false);
});

test("U-I2: the standalone server runs a poller with the chat tick, so replies land; stopping the server stops it", async () => {
  const root = tempWorkspace();
  try {
    // A turn whose job already settled while nothing was running.
    const fake = new FakeOpenRouter();
    fake.submitReplies = [async () => accepted("batch_1")];
    const cfg = makeConfig();
    const batch = makeService(root, fake, cfg);
    const store = new ThreadStore(join(root, ".pi/batches/threads"));
    const chat = new ChatService({ store, batch, workspaceRoot: root, getConfig: () => cfg });
    const t = chat.newThread();
    const r = await chat.send(t.id, "hello");
    const job = batch.registry.read(r.jobId!);
    fake.getReplies = [{ status: 200, body: completed([successItem(job.customIds[0]!, "Landed via the standalone poller")], { id: job.providerBatchId }) }];
    await batch.reconcile(job.localId, { force: true });
    assert.equal(store.read(t.id).pending?.jobId, job.localId);

    const web = BatchWebServer.createStandalone(root, { resolveApiKey: async () => "" });
    assert.equal(web.activePoller.isRunning, false);
    await web.start(0, "127.0.0.1");
    try {
      assert.equal(web.activePoller.isRunning, true);
      await waitFor(() => store.transcript(t.id).entries.some((e) => e.type === "assistant"));
    } finally {
      await web.stop();
    }
    assert.equal(web.activePoller.isRunning, false);
  } finally {
    rm(root);
  }
});
