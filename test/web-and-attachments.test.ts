import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { ArtifactService } from "../src/artifacts/service.js";
import { ArtifactStore } from "../src/artifacts/store.js";
import { renderPdf } from "../src/artifacts/render-pdf.js";
import { extractPdfText, extractResponseFiles, isValidImageBuffer, prepareAttachments } from "../src/attachments.js";
import { ChatBlockedError, ChatService } from "../src/chat/service.js";
import { ThreadStore } from "../src/chat/store.js";
import type { BatchConfig } from "../src/config.js";
import { BatchPoller } from "../src/poller.js";
import type { BatchService } from "../src/service.js";
import { BatchWebServer } from "../src/web/server.js";
import { FakeOpenRouter, accepted, makeConfig, makeService } from "./fixtures/fake-openrouter.js";
import { completed, successItem } from "./fixtures/openrouter.js";
import { rm, tempWorkspace, writeFiles } from "./helpers.js";

const SECRET = "sk-or-v1-" + "b".repeat(64);
// Valid 1x1 transparent PNG
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

interface TestEnv {
  root: string;
  fake: FakeOpenRouter;
  cfg: BatchConfig;
  batch: BatchService;
  store: ThreadStore;
  chat: ChatService;
  artifacts: ArtifactService;
  poller: BatchPoller;
  web: BatchWebServer;
}

function createEnv(): TestEnv {
  const root = tempWorkspace();
  const fake = new FakeOpenRouter();
  let seq = 0;
  fake.submitReplies = [async () => accepted(`batch_${++seq}`)];
  const cfg = makeConfig();
  const batch = makeService(root, fake, cfg);
  const store = new ThreadStore(join(root, ".pi/batches/threads"));
  const chat = new ChatService({ store, batch, workspaceRoot: root, getConfig: () => cfg });
  const artifacts = new ArtifactService({
    batch,
    workspaceRoot: root,
    getConfig: () => cfg,
    store: new ArtifactStore(join(root, ".pi/batches/artifacts")),
  });
  const poller = new BatchPoller(
    () => batch,
    () => true,
    undefined,
    async () => {
      await chat.tick();
    },
  );
  const web = new BatchWebServer({
    workspaceRoot: root,
    service: batch,
    chat,
    chatStore: store,
    artifacts,
    poller,
    getConfig: () => cfg,
  });
  return { root, fake, cfg, batch, store, chat, artifacts, poller, web };
}

test("attachments: workspace files, uploaded text/CSV/JSON, PDF text extraction, PDF multimodal, and images in Batch Chat", async () => {
  const env = createEnv();
  try {
    writeFiles(env.root, {
      "src/app.ts": "export const greeting = 'hello batch world';\n",
      "docs/guide.md": "# Guide\nUse batch models for deep analysis.\n",
      ".env": `OPENROUTER_API_KEY=${SECRET}\n`,
    });

    const pdf = await renderPdf("# Architecture Spec\n\nBatch latency is asynchronous.", {
      title: "Architecture Spec",
      producer: "test",
    });
    const extracted = await extractPdfText(pdf.bytes);
    assert.equal(extracted.ok, true);
    if (extracted.ok) {
      assert.equal(extracted.pages, 1);
      assert.match(extracted.text, /Architecture Spec/);
    }

    const thread = env.chat.newThread();

    // 1. Send turn with workspace file + uploaded JSON + PDF (text mode)
    const r1 = await env.chat.send(thread.id, "Please review these files.", {
      files: ["src/app.ts"],
      contexts: ["docs"],
      uploads: [
        {
          name: "metrics.json",
          mimeType: "application/json",
          text: '{"latencyMs": 120, "discount": 0.5}',
        },
        {
          name: "spec.pdf",
          mimeType: "application/pdf",
          contentBase64: pdf.bytes.toString("base64"),
          pdfMode: "text",
        },
      ],
    });
    assert.equal(r1.queued, false);
    assert.ok(r1.jobId);

    // Check transcript entry has attachment metadata badges
    const entries1 = env.store.transcript(thread.id).entries;
    assert.equal(entries1.length, 1);
    const u1 = entries1[0]!;
    assert.equal(u1.type, "user");
    if (u1.type === "user") {
      assert.equal(u1.attachments?.length, 4);
      assert.deepEqual(
        u1.attachments?.map((a) => [a.source, a.kind, a.path ?? a.name]),
        [
          ["workspace", "text", "src/app.ts"],
          ["workspace", "text", "docs/guide.md"],
          ["upload", "text", "metrics.json"],
          ["upload", "pdf", "spec.pdf"],
        ],
      );
      assert.ok(u1.inlinedText?.includes("FILE: src/app.ts"));
      assert.ok(u1.inlinedText?.includes("FILE: docs/guide.md"));
      assert.ok(u1.inlinedText?.includes("FILE: metrics.json"));
      assert.ok(u1.inlinedText?.includes("FILE: spec.pdf"));
    }

    // Because all 4 attachments are text/extracted-text, wire content stays a plain string
    const wireBody1 = env.fake.accepted[0]!.requests[0]!.body as { messages: Array<{ role: string; content: unknown }> };
    const wireMsg1 = wireBody1.messages[1]!;
    assert.equal(typeof wireMsg1.content, "string");
    assert.match(String(wireMsg1.content), /Please review these files\./);
    assert.match(String(wireMsg1.content), /greeting = 'hello batch world'/);
    assert.match(String(wireMsg1.content), /"latencyMs": 120/);

    // Settle turn 1
    const job1 = env.batch.registry.read(r1.jobId!);
    env.fake.getReplies = [{ status: 200, body: completed([successItem(job1.customIds[0]!, "Reviewed all 4 files.")], { id: job1.providerBatchId }) }];
    const settled1 = await env.batch.reconcile(job1.localId, { force: true });
    assert.equal(settled1.status, "ready");
    env.chat.applySettled(env.batch.registry.read(job1.localId));

    // 2. Send turn with an Image attachment + Multimodal PDF attachment
    const r2 = await env.chat.send(thread.id, "Check this diagram and PDF.", {
      uploads: [
        {
          name: "diagram.png",
          mimeType: "image/png",
          contentBase64: `data:image/png;base64,${TINY_PNG_B64}`,
        },
        {
          name: "raw-spec.pdf",
          mimeType: "application/pdf",
          contentBase64: pdf.bytes.toString("base64"),
          pdfMode: "multimodal",
        },
      ],
    });
    assert.equal(r2.queued, false);
    const wireBody2 = env.fake.accepted[1]!.requests[0]!.body as { messages: Array<{ role: string; content: unknown }> };
    const wireMsg2 = wireBody2.messages[3]!;
    assert.ok(Array.isArray(wireMsg2.content), "wire message content should be a multimodal part array");
    if (Array.isArray(wireMsg2.content)) {
      const parts = wireMsg2.content as Array<{ type: string; text?: string }>;
      assert.equal(parts.length, 3);
      assert.deepEqual(parts[0], { type: "text", text: "Check this diagram and PDF." });
      assert.equal(parts[1]?.type, "image_url");
      assert.equal(parts[2]?.type, "file");
    }
  } finally {
    rm(env.root);
  }
});

test("attachments: secret scanning and hard-deny rules block unsafe workspace or uploaded files before saving", async () => {
  const env = createEnv();
  try {
    writeFiles(env.root, {
      ".env": "SECRET_KEY=123\n",
      "notes.txt": `Contains key ${SECRET} inside\n`,
    });
    const thread = env.chat.newThread();

    // Hard-denied .env file blocked
    await assert.rejects(
      env.chat.send(thread.id, "read env", { files: [".env"] }),
      (err: unknown) => err instanceof ChatBlockedError && /hard-deny/.test(err.message),
    );
    assert.equal(env.store.transcript(thread.id).entries.length, 0);

    // Workspace file with secret blocked
    await assert.rejects(
      env.chat.send(thread.id, "read notes", { files: ["notes.txt"] }),
      (err: unknown) => err instanceof ChatBlockedError && /secret/i.test(err.message),
    );
    assert.equal(env.store.transcript(thread.id).entries.length, 0);

    // Uploaded text file with secret blocked
    await assert.rejects(
      env.chat.send(thread.id, "uploaded secret", {
        uploads: [{ name: "leak.txt", text: `my key is ${SECRET}` }],
      }),
      (err: unknown) => err instanceof ChatBlockedError && /leak\.txt/.test(err.message),
    );
    assert.equal(env.store.transcript(thread.id).entries.length, 0);

    // Invalid image magic bytes blocked
    assert.equal(isValidImageBuffer(Buffer.from("not a png"), "image/png"), false);
    const prepBadImg = await prepareAttachments({
      workspaceRoot: env.root,
      config: env.cfg,
      knownSecrets: [],
      input: {
        uploads: [{ name: "fake.png", mimeType: "image/png", contentBase64: Buffer.from("not a png").toString("base64") }],
      },
    });
    assert.ok(prepBadImg.blockers.some((b) => /header bytes/.test(b)));
  } finally {
    rm(env.root);
  }
});

test("web server: serves UI, enforces CSRF token, handles chat + attachments + jobs + artifacts over HTTP", async () => {
  const env = createEnv();
  try {
    writeFiles(env.root, {
      "src/hello.ts": "export const x = 42;\n",
    });

    const baseUrl = await env.web.start(0, "127.0.0.1");
    assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);

    // 1. GET / serves HTML UI with CSRF token
    const uiRes = await fetch(baseUrl + "/");
    assert.equal(uiRes.status, 200);
    assert.equal(uiRes.headers.get("x-frame-options"), "DENY");
    const html = await uiRes.text();
    assert.ok(html.includes(env.web.csrfToken));
    assert.ok(html.includes("Pi Batch OpenRouter"));

    // 2. POST without X-Batch-Token is rejected with 403
    const forbiddenRes = await fetch(baseUrl + "/api/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(forbiddenRes.status, 403);

    const authHeaders = {
      "Content-Type": "application/json",
      "X-Batch-Token": env.web.csrfToken,
    };

    // 3. GET /api/workspace/files & file-preview
    const filesRes = await fetch(baseUrl + "/api/workspace/files");
    const filesData = (await filesRes.json()) as { entries: Array<{ relPath: string; selectable: boolean }> };
    assert.ok(filesData.entries.some((e) => e.relPath === "src/hello.ts" && e.selectable));

    const previewRes = await fetch(baseUrl + "/api/workspace/file-preview?path=src/hello.ts");
    assert.equal(previewRes.status, 200);
    const previewData = (await previewRes.json()) as { content: string };
    assert.equal(previewData.content, "export const x = 42;\n");

    // 4. POST /api/attachments/preflight
    const preflightRes = await fetch(baseUrl + "/api/attachments/preflight", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        text: "Check hello.ts",
        attachments: {
          files: ["src/hello.ts"],
          uploads: [{ name: "extra.csv", text: "id,val\n1,100\n" }],
        },
      }),
    });
    assert.equal(preflightRes.status, 200);
    const preflightData = (await preflightRes.json()) as { blockers: string[]; attachments: unknown[] };
    assert.equal(preflightData.blockers.length, 0);
    assert.equal(preflightData.attachments.length, 2);

    // 5. Create thread & send turn with attachments via HTTP API
    const createThreadRes = await fetch(baseUrl + "/api/threads", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ title: "Web UI Thread" }),
    });
    assert.equal(createThreadRes.status, 201);
    const { thread } = (await createThreadRes.json()) as { thread: { id: string; title: string } };
    assert.equal(thread.title, "Web UI Thread");

    const sendRes = await fetch(`${baseUrl}/api/threads/${thread.id}/send`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        text: "Explain x in hello.ts",
        attachments: {
          files: ["src/hello.ts"],
          uploads: [{ name: "snippet.txt", text: "additional note" }],
        },
      }),
    });
    assert.equal(sendRes.status, 200);
    const sendData = (await sendRes.json()) as { queued: boolean; jobId: string };
    assert.equal(sendData.queued, false);
    assert.ok(sendData.jobId);

    // 6. Create & submit a /batch ask job with uploads via POST /api/jobs/ask
    const askRes = await fetch(`${baseUrl}/api/jobs/ask`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        objective: "Summarize the uploaded CSV and hello.ts",
        files: ["src/hello.ts"],
        uploads: [{ name: "data.csv", text: "col1,col2\na,b\n" }],
        mode: "submit",
      }),
    });
    assert.equal(askRes.status, 201);
    const { job: askJob } = (await askRes.json()) as { job: { localId: string; providerBatchId: string; customIds: string[] } };

    // Reconcile askJob and render an HTML artifact via HTTP API
    env.fake.getReplies = [{ status: 200, body: completed([successItem(askJob.customIds[0]!, "# Summary Result\n\nEverything looks good.")], { id: askJob.providerBatchId }) }];
    const checkRes = await fetch(`${baseUrl}/api/jobs/${askJob.localId}/check`, {
      method: "POST",
      headers: authHeaders,
    });
    assert.equal(checkRes.status, 200);

    const artRes = await fetch(`${baseUrl}/api/jobs/${askJob.localId}/artifact`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ format: "html" }),
    });
    assert.equal(artRes.status, 201);
    const { artifact } = (await artRes.json()) as { artifact: { artifactId: string } };

    const artContentRes = await fetch(`${baseUrl}/api/artifacts/${artifact.artifactId}/content`);
    assert.equal(artContentRes.status, 200);
    assert.match(artContentRes.headers.get("content-type") ?? "", /text\/html/);
    const renderedHtml = await artContentRes.text();
    assert.match(renderedHtml, /Summary Result/);

    // 7. Browse directories and hot-swap active workspace folder via /api/workspace/browse-dirs & /api/workspace/switch
    const secondRoot = tempWorkspace();
    try {
      writeFiles(secondRoot, {
        "second-project.ts": "export const project = 2;\n",
      });
      const browseRes = await fetch(`${baseUrl}/api/workspace/browse-dirs?path=${encodeURIComponent(env.root)}`);
      assert.equal(browseRes.status, 200);
      const browseData = (await browseRes.json()) as { current: string; directories: Array<{ name: string }> };
      assert.ok(browseData.directories.some((d) => d.name === "src"));

      const switchRes = await fetch(`${baseUrl}/api/workspace/switch`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ path: secondRoot }),
      });
      assert.equal(switchRes.status, 200);
      const switchData = (await switchRes.json()) as { workspaceRoot: string; recentWorkspaces: string[] };
      assert.equal(switchData.recentWorkspaces.length, 2);

      const filesAfterSwitchRes = await fetch(`${baseUrl}/api/workspace/files`);
      const filesAfterSwitch = (await filesAfterSwitchRes.json()) as { entries: Array<{ relPath: string }> };
      assert.ok(filesAfterSwitch.entries.some((e) => e.relPath === "second-project.ts"));

      // 8. Extract code/files from an LLM response and save them safely into the workspace via /api/workspace/write-file
      const llmReply = [
        "Here are the generated files:",
        "```ts:src/generated-helper.ts",
        "export const answer = 42;",
        "```",
        "And a CSV report:",
        "```csv",
        "// FILE: reports/summary.csv",
        "metric,value",
        "accuracy,0.99",
        "```",
        `And an image: ![chart](data:image/png;base64,${TINY_PNG_B64})`,
      ].join("\n");

      const extracted = extractResponseFiles(llmReply);
      assert.equal(extracted.length, 3);
      assert.equal(extracted[0]?.suggestedPath, "src/generated-helper.ts");
      assert.equal(extracted[1]?.suggestedPath, "reports/summary.csv");
      assert.equal(extracted[2]?.kind, "image");
      assert.equal(extracted[2]?.suggestedPath, "image-3.png");

      // Write the first extracted file to workspace
      const writeRes1 = await fetch(`${baseUrl}/api/workspace/write-file`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          relPath: extracted[0]!.suggestedPath,
          content: extracted[0]!.content,
          overwrite: false,
        }),
      });
      assert.equal(writeRes1.status, 200);

      // Writing again with overwrite: false returns 409 Conflict
      const writeConflict = await fetch(`${baseUrl}/api/workspace/write-file`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          relPath: extracted[0]!.suggestedPath,
          content: "// updated\n",
          overwrite: false,
        }),
      });
      assert.equal(writeConflict.status, 409);

      // Writing with overwrite: true succeeds
      const writeOverwrite = await fetch(`${baseUrl}/api/workspace/write-file`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          relPath: extracted[0]!.suggestedPath,
          content: "// updated\n",
          overwrite: true,
        }),
      });
      assert.equal(writeOverwrite.status, 200);

      // Path traversal outside workspace and hard-denied paths (.env) are refused
      const writeEscape = await fetch(`${baseUrl}/api/workspace/write-file`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ relPath: "../escape.ts", content: "bad", overwrite: true }),
      });
      assert.equal(writeEscape.status, 400);

      const writeEnv = await fetch(`${baseUrl}/api/workspace/write-file`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ relPath: ".env", content: "SECRET=1", overwrite: true }),
      });
      assert.equal(writeEnv.status, 400);
    } finally {
      rm(secondRoot);
    }
  } finally {
    await env.web.stop();
    rm(env.root);
  }
});
