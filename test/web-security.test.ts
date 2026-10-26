import assert from "node:assert/strict";
import * as http from "node:http";
import { join } from "node:path";
import test from "node:test";
import { ArtifactService } from "../src/artifacts/service.js";
import { ArtifactStore } from "../src/artifacts/store.js";
import { ChatService } from "../src/chat/service.js";
import { ThreadStore } from "../src/chat/store.js";
import { BatchPoller } from "../src/poller.js";
import { BatchWebServer } from "../src/web/server.js";
import { FakeOpenRouter, accepted, makeConfig, makeService } from "./fixtures/fake-openrouter.js";
import { rm, tempWorkspace } from "./helpers.js";

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** Raw HTTP request (fetch cannot set Host). */
function request(port: number, opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: opts.method ?? "GET", path: opts.path, headers: { Host: `127.0.0.1:${port}`, ...opts.headers } }, (res) => {
      const chunks: Buffer[] = [];
      // The event stream never ends: answer with what arrived first.
      const done = () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") });
      res.on("data", (c: Buffer) => {
        chunks.push(c);
        if (res.headers["content-type"]?.startsWith("text/event-stream")) {
          done();
          req.destroy();
        }
      });
      res.on("end", done);
    });
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function withServer(fn: (web: BatchWebServer, port: number) => Promise<void>): Promise<void> {
  const root = tempWorkspace();
  const fake = new FakeOpenRouter();
  fake.submitReplies = [async () => accepted("batch_1")];
  const cfg = makeConfig();
  const batch = makeService(root, fake, cfg);
  const store = new ThreadStore(join(root, ".pi/batches/threads"));
  const chat = new ChatService({ store, batch, workspaceRoot: root, getConfig: () => cfg });
  const artifacts = new ArtifactService({ batch, workspaceRoot: root, getConfig: () => cfg, store: new ArtifactStore(join(root, ".pi/batches/artifacts")) });
  const poller = new BatchPoller(() => batch, () => false);
  const web = new BatchWebServer({ workspaceRoot: root, service: batch, chat, chatStore: store, artifacts, poller, getConfig: () => cfg });
  const url = await web.start(0, "127.0.0.1");
  try {
    await fn(web, Number(new URL(url).port));
  } finally {
    await web.stop();
    rm(root);
  }
}

/** Opens the one-time launch link and returns the session cookie it sets. */
async function signIn(web: BatchWebServer, port: number): Promise<string> {
  const launch = new URL(web.createLaunchUrl()!);
  const res = await request(port, { path: launch.pathname + launch.search });
  assert.equal(res.status, 303);
  const setCookie = res.headers["set-cookie"]?.[0] ?? "";
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  return setCookie.split(";")[0]!;
}

test("U-C2: a wrong Host header is refused with 403 (DNS rebinding)", () =>
  withServer(async (web, port) => {
    const cookie = await signIn(web, port);
    for (const host of ["evil.example:" + port, `127.0.0.1:${port + 1}`, "127.0.0.1", `attacker.127.0.0.1.nip.io:${port}`]) {
      const res = await request(port, { path: "/api/bootstrap", headers: { Host: host, Cookie: cookie } });
      assert.equal(res.status, 403, host);
      const page = await request(port, { path: "/", headers: { Host: host, Cookie: cookie } });
      assert.equal(page.status, 403, host);
    }
    assert.equal((await request(port, { path: "/api/bootstrap", headers: { Host: `localhost:${port}`, Cookie: cookie } })).status, 200);
  }));

test("U-C2: a cross-site Origin or Sec-Fetch-Site is refused with 403", () =>
  withServer(async (web, port) => {
    const cookie = await signIn(web, port);
    const post = (headers: Record<string, string>) =>
      request(port, { method: "POST", path: "/api/threads", headers: { Cookie: cookie, "X-Batch-Token": web.csrfToken, "Content-Type": "application/json", ...headers }, body: "{}" });
    assert.equal((await post({ Origin: "http://evil.example" })).status, 403);
    assert.equal((await post({ Origin: `http://127.0.0.1:${port + 1}` })).status, 403);
    assert.equal((await post({ "Sec-Fetch-Site": "cross-site" })).status, 403);
    assert.equal((await request(port, { path: "/api/bootstrap", headers: { Cookie: cookie, "Sec-Fetch-Site": "cross-site" } })).status, 403);
    assert.equal((await post({ Origin: `http://127.0.0.1:${port}`, "Sec-Fetch-Site": "same-origin" })).status, 201);
  }));

test("U-C2: every /api request, GETs and the event stream included, needs the session; the page does not leak the CSRF token", () =>
  withServer(async (web, port) => {
    for (const path of ["/api/bootstrap", "/api/events", "/api/jobs", "/api/workspace/files", "/api/workspace/browse-dirs", "/api/threads"]) {
      assert.equal((await request(port, { path })).status, 401, path);
    }
    const page = await request(port, { path: "/" });
    assert.equal(page.status, 401);
    assert.equal(page.body.includes(web.csrfToken), false);
    // The CSRF token alone is not enough.
    const res = await request(port, { method: "POST", path: "/api/threads", headers: { "X-Batch-Token": web.csrfToken }, body: "{}" });
    assert.equal(res.status, 401);
    // A forged session cookie is refused too.
    assert.equal((await request(port, { path: "/api/bootstrap", headers: { Cookie: `pi_batch_session_${port}=${"0".repeat(64)}` } })).status, 401);
  }));

test("U-C2: the launch token is one-time; a valid session works, and responses carry the security headers", () =>
  withServer(async (web, port) => {
    const launch = new URL(web.createLaunchUrl()!);
    const first = await request(port, { path: launch.pathname + launch.search });
    assert.equal(first.status, 303);
    assert.equal((await request(port, { path: launch.pathname + launch.search })).status, 401, "reused launch token");
    assert.equal((await request(port, { path: "/?token=wrong" })).status, 401);
    const cookie = first.headers["set-cookie"]![0]!.split(";")[0]!;

    const page = await request(port, { path: "/", headers: { Cookie: cookie } });
    assert.equal(page.status, 200);
    assert.ok(page.body.includes(web.csrfToken));
    const csp = String(page.headers["content-security-policy"]);
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    assert.ok(nonce, csp);
    assert.ok(page.body.includes(`<script nonce="${nonce}">`));
    assert.doesNotMatch(csp, /unsafe-inline'[^;]*;?\s*$|script-src[^;]*unsafe-inline/);
    assert.equal(page.headers["x-content-type-options"], "nosniff");
    assert.equal(page.headers["referrer-policy"], "no-referrer");

    const api = await request(port, { path: "/api/bootstrap", headers: { Cookie: cookie } });
    assert.equal(api.status, 200);
    assert.equal(api.headers["x-content-type-options"], "nosniff");
    const events = await request(port, { path: "/api/events", headers: { Cookie: cookie } });
    assert.equal(events.status, 200);
    // Mutations still need the CSRF token as well as the session.
    assert.equal((await request(port, { method: "POST", path: "/api/threads", headers: { Cookie: cookie }, body: "{}" })).status, 403);
    assert.equal((await request(port, { method: "POST", path: "/api/threads", headers: { Cookie: cookie, "X-Batch-Token": web.csrfToken }, body: "{}" })).status, 201);
  }));
