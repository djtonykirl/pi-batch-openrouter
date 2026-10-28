import assert from "node:assert/strict";
import test from "node:test";
import { MAX_CONSECUTIVE_429 } from "../src/openrouter/immediate.js";
import { inflightHeadline, renderWebUiHtml } from "../src/web/ui.js";

const page = () => renderWebUiHtml({ csrfToken: "t", workspaceRoot: "/w", nonce: "n" });

// ------------------------------------------------------------------ 4a: in-flight banner

test("4a: a rate-limited free-model turn names the route, the retry time and the attempt", () => {
  const at = new Date(2026, 9, 28, 14, 15, 0);
  assert.equal(
    inflightHeadline("turn", { route: "immediate", nextPollAt: at.toISOString(), consecutivePollFailures: 5 }, 8),
    "⏳ Free-model turn rate-limited by OpenRouter; retrying at 14:15 (attempt 5 of 8)",
  );
  assert.equal(inflightHeadline("turn", { route: "immediate", consecutivePollFailures: 0 }, 8), "⏳ Free-model turn in flight");
  assert.equal(inflightHeadline("turn", { route: "batch", consecutivePollFailures: 0 }, 8), "⏳ Batch turn in flight");
  assert.equal(inflightHeadline("turn", undefined, 8), "⏳ Batch turn in flight");
  assert.equal(
    inflightHeadline("turn", { route: "batch", consecutivePollFailures: 2, lastPollError: { message: "HTTP 502" } }, 8),
    "⏳ Batch turn in flight (last status check failed: HTTP 502)",
  );
  assert.equal(inflightHeadline("compaction", { route: "batch" }, 8), "⏳ Compaction in flight");
});

test("4a: the page embeds inflightHeadline with the real cap and no longer says 'Batch Turn in Flight'", () => {
  const html = page();
  assert.ok(html.includes(inflightHeadline.toString()));
  assert.ok(html.includes(`const MAX_RATE_LIMITS = ${MAX_CONSECUTIVE_429};`));
  assert.ok(html.includes("inflightHeadline(p ? \"turn\" : \"compaction\", activeJob, MAX_RATE_LIMITS)"));
  assert.ok(!html.includes("Batch Turn in Flight"));
});
