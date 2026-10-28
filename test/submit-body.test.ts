import assert from "node:assert/strict";
import test from "node:test";
import { buildSubmitBody, submitBodyProblems } from "../src/openrouter/types.js";

const IMG = { type: "image_url" as const, image_url: { url: "data:image/png;base64,AAAA" } };

test("an image-only message sends no empty text part", () => {
  const body = buildSubmitBody({ model: "m/x", requests: [{ custom_id: "c1", body: { messages: [{ role: "user", content: "", parts: [IMG] }] } }] });
  assert.deepEqual(body.requests[0]!.body.messages[0], { role: "user", content: [IMG] });
  assert.deepEqual(submitBodyProblems(body), []);
});

test("a message with text and parts keeps the text part first", () => {
  const body = buildSubmitBody({ model: "m/x", requests: [{ custom_id: "c1", body: { messages: [{ role: "user", content: "look", parts: [IMG] }] } }] });
  assert.deepEqual(body.requests[0]!.body.messages[0], { role: "user", content: [{ type: "text", text: "look" }, IMG] });
});

test("text-only requests stay byte-identical", () => {
  const messages = [
    { role: "system" as const, content: "SYS" },
    { role: "user" as const, content: "hello" },
  ];
  const body = buildSubmitBody({ model: "m/x", requests: [{ custom_id: "c1", body: { messages, max_tokens: 100 } }] });
  assert.equal(
    JSON.stringify(body),
    '{"endpoint":"/v1/chat/completions","model":"m/x","completion_window":"24h","requests":[{"custom_id":"c1","body":{"messages":[{"role":"system","content":"SYS"},{"role":"user","content":"hello"}],"max_tokens":100}}]}',
  );
});
