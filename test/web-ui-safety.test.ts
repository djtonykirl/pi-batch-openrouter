import assert from "node:assert/strict";
import test from "node:test";
import * as vm from "node:vm";
import { renderWebUiHtml } from "../src/web/ui.js";

test("U-I4: the web UI has no inline event-handler attributes, so no value is ever parsed as inline JavaScript", () => {
  const html = renderWebUiHtml({ csrfToken: "t", workspaceRoot: "/w" });
  const inline = [...html.matchAll(/\son[a-z]+\s*=\s*["']/gi)].map((m) => m[0].trim());
  assert.deepEqual(inline, []);
  // Buttons use the delegated, whitelisted action mechanism instead.
  assert.match(html, /data-action=/);
  assert.match(html, /const ACTIONS = new Set\(/);
});

test("U-I4: the page script is valid JavaScript", () => {
  const html = renderWebUiHtml({ csrfToken: "t", workspaceRoot: "/w" });
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new vm.Script(scripts[0]!));
});

test("U-I4: a crafted workspace path cannot close the script element", () => {
  const evil = "C:/x/</script><script>alert(1)</script>";
  const html = renderWebUiHtml({ csrfToken: "t", workspaceRoot: evil });
  assert.equal(html.includes("</script><script>alert(1)"), false);
  assert.ok(html.includes("\\u003c/script>"));
});
