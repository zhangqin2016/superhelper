#!/usr/bin/env node
// One reader for chat-completion replies. Six modules each read
// `choices[0].message…` by hand; one returned the whole reply object (the
// 2026-09-08 vision-bridge regression), one dropped content-part arrays, and the
// vision probe took any HTTP 200 as "the model read the image" — a gateway that
// answers 200 with an HTML error page passed it. [gate: chat-completion-reply-seam]
// Run: node scripts/test-chat-completion-reply.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const reply = require("../src/main/chat-completion-reply.js");
const { probeVision } = require("../src/main/model-probe-vision.js");

let checks = 0;
function check(name, fn) { fn(); checks += 1; console.log(`ok - ${name}`); }
async function checkAsync(name, fn) { await fn(); checks += 1; console.log(`ok - ${name}`); }

const completion = (message, extra = {}) => ({ id: "r", choices: [{ index: 0, message, finish_reason: "stop", ...extra }], usage: {} });

check("the assistant text is read the same way whatever shape it arrives in", () => {
  assert.equal(reply.replyText(completion({ role: "assistant", content: "  hello " })), "hello");
  assert.equal(reply.replyText(completion({ role: "assistant", content: [{ type: "text", text: "一只猫" }, { type: "image_url" }] })), "一只猫");
  assert.equal(reply.replyText({ choices: [{ text: "legacy completion" }] }), "legacy completion");
  assert.equal(reply.replyText(completion({ role: "assistant", content: null, tool_calls: [{ id: "c" }] })), "");
  assert.equal(reply.replyToolCalls(completion({ content: null, tool_calls: [{ id: "c" }] })).length, 1);
  assert.equal(reply.replyReasoning(completion({ content: "", reasoning_content: "thinking…" })), "thinking…");
  assert.equal(reply.replyReasoning(completion({ content: "", reasoning: "chain" })), "chain");
  assert.equal(reply.finishReason(completion({ content: "" }, { finish_reason: "content_filter" })), "content_filter");
});

check("a reply that is not a completion is never mistaken for one — whatever the status said", () => {
  assert.equal(reply.isChatCompletion(null), false, "an HTML error page parses to null");
  assert.equal(reply.isChatCompletion({ error: { message: "upstream" } }), false, "an error envelope has no choices");
  assert.equal(reply.isChatCompletion({ choices: [] }), false);
  assert.equal(reply.isChatCompletion(completion({ role: "assistant", content: "" })), true, "an empty answer is still an answer");
  assert.equal(reply.isChatCompletion(completion({ role: "assistant", content: null, tool_calls: [] })), true);
  assert.equal(reply.replyText(null), "");
  assert.equal(reply.replyText("nonsense"), "");
});

check("a streamed chunk is read the same way", () => {
  const d = reply.streamDelta({ choices: [{ delta: { content: "ok", reasoning_content: "r" }, finish_reason: "stop" }] });
  assert.deepEqual(d, { content: "ok", reasoning: "r", toolCalls: [], finishReason: "stop" });
  assert.deepEqual(reply.streamDelta({}), { content: "", reasoning: "", toolCalls: [], finishReason: "" });
});

await checkAsync("the vision probe judges the reply, not the status code", async () => {
  const realFetch = globalThis.fetch;
  const answer = (status, body, type = "application/json") => async () => new Response(body, { status, headers: { "content-type": type } });
  const probe = () => probeVision({ baseUrl: "http://vision.test/v1", apiKey: "k", model: "m", timeoutMs: 2000 });
  try {
    globalThis.fetch = answer(200, JSON.stringify(completion({ role: "assistant", content: "ok" })));
    assert.equal(await probe(), true, "a completion means the image was accepted and answered");
    globalThis.fetch = answer(200, "<html><body>Bad Gateway</body></html>", "text/html");
    assert.equal(await probe(), false, "a 200 HTML error page is not vision");
    globalThis.fetch = answer(200, JSON.stringify({ error: { message: "model overloaded" } }));
    assert.equal(await probe(), false, "a 200 error envelope is not vision");
    globalThis.fetch = answer(400, JSON.stringify({ error: { message: "This model does not support image input.", type: "invalid_request_error" } }));
    assert.equal(await probe(), false, "a 400 naming images is not vision, as before");
  } finally {
    globalThis.fetch = realFetch;
  }
});

check("no module reads choices[0] by hand — the seam and the shape producer are the only two", () => {
  const offenders = [];
  const allowed = new Set(["src/main/chat-completion-reply.js", "src/main/openai-request-shape.js"]);
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith(".js")) continue;
      const rel = path.relative(ROOT, full).split(path.sep).join("/");
      if (allowed.has(rel)) continue;
      const code = fs.readFileSync(full, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
      if (/\.choices\b|\bchoices\?\.\[|\bchoices\[/.test(code)) offenders.push(rel);
    }
  };
  walk(path.join(ROOT, "src/main"));
  walk(path.join(ROOT, "src/shared"));
  assert.deepEqual(offenders, [], `read replies through chat-completion-reply.js:\n${offenders.join("\n")}`);
});

console.log(`\n${checks} checks passed (chat completion reply seam)`);
