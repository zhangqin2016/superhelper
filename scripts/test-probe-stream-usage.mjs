#!/usr/bin/env node
/**
 * Streaming usage is VERIFIED per endpoint, never switched off for all of them
 * (2026-09-28 integration audit). It was disabled for every OpenAI-compatible
 * endpoint because some vLLM deployments send a usage chunk without `choices`,
 * which the engine's AI SDK rejects mid-turn — and that blinded the engine's
 * overflow check and every pressure measurement on every such model. The probe
 * now asks for usage on its content stream and records `streamUsage: "include"`
 * only when the endpoint accepted it, returned usage and kept every chunk
 * well-formed; the engine config turns usage on for exactly those endpoints.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-probe-usage-"));
process.env.LILY_USER_DATA_DIR = tmp; process.env.LILY_HOME = os.homedir(); process.env.LILY_DOCUMENTS_DIR = tmp;
const require = createRequire(import.meta.url);
const { probeCustomModelProfile } = require("../src/main/model-compatibility-probe.js");
const shapes = require("../src/main/openai-request-shape.js");
const { resolveOpencodeModelConfig } = require("../src/main/runtime/opencode-model-config.js");

const toolCall = { id: "call_1", type: "function", function: { name: "lily_probe_tool", arguments: "{\"ok\":true}" } };
const usage = { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 };
const server = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const parsed = JSON.parse(body || "{}");
    const json = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    const hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
    const wantsUsage = parsed.stream_options?.include_usage === true;
    if (parsed.model === "rejects-options" && parsed.stream_options) {
      return json(400, { error: { message: "Invalid request: extra inputs are not permitted", type: "invalid_request_error" } });
    }
    if (!parsed.stream) {
      return json(200, { id: "c", object: "chat.completion", model: parsed.model, choices: [{ index: 0, message: hasTools ? { role: "assistant", content: null, tool_calls: [toolCall] } : { role: "assistant", content: "pong" }, finish_reason: hasTools ? "tool_calls" : "stop" }], usage });
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const delta = hasTools ? { tool_calls: [{ index: 0, ...toolCall }] } : { content: "pong" };
    send({ id: "c", object: "chat.completion.chunk", model: parsed.model, choices: [{ index: 0, delta, finish_reason: null }] });
    send({ id: "c", object: "chat.completion.chunk", model: parsed.model, choices: [{ index: 0, delta: {}, finish_reason: hasTools ? "tool_calls" : "stop" }] });
    if (wantsUsage && parsed.model === "usage-ok") send({ id: "c", object: "chat.completion.chunk", model: parsed.model, choices: [], usage });
    if (wantsUsage && parsed.model === "vllm-choiceless") send({ id: "c", object: "chat.completion.chunk", model: parsed.model, usage });
    res.write("data: [DONE]\n\n"); res.end();
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;

const includeUsageFor = (requestShape) => {
  const r = resolveOpencodeModelConfig({
    LILY_API_BASE_URL: baseUrl, LILY_API_KEY: "sk", LILY_MODEL: "m",
    ...(requestShape ? { LILY_MODEL_REQUEST_SHAPE: JSON.stringify(requestShape) } : {}),
  });
  return JSON.parse(r.configContent).provider.lily.options.includeUsage;
};

try {
  for (const [model, expectInclude, label] of [
    ["usage-ok", true, "an endpoint that streams usage with well-formed chunks is verified"],
    ["vllm-choiceless", false, "a usage chunk without choices (the vLLM shape the AI SDK rejects) is not"],
    ["rejects-options", false, "an endpoint that refuses stream_options is not"],
  ]) {
    shapes.resetLearnedShapesForTests();
    const result = await probeCustomModelProfile({ protocol: "openai", baseUrl, apiKey: "sk-test", model, timeoutMs: 5000 });
    assert.equal(result.ok, true, `${model}: the probe still passes — this check never rejects a model: ${JSON.stringify(result).slice(0, 300)}`);
    assert.equal(result.profile.requestShape?.streamUsage === "include", expectInclude, `${model}: ${label}`);
    assert.equal(includeUsageFor(result.profile.requestShape), expectInclude ? undefined : false,
      `${model}: engine usage is ${expectInclude ? "left on (the engine default)" : "kept off"}`);
  }
  // A preset probed before this check (no learned field) keeps usage off: the baseline.
  assert.equal(includeUsageFor(null), false, "an unverified endpoint keeps the previous behaviour");

  // Kill switch: the probe skips the check and records nothing.
  process.env.LILY_PROBE_STREAM_USAGE = "0";
  shapes.resetLearnedShapesForTests();
  const skipped = await probeCustomModelProfile({ protocol: "openai", baseUrl, apiKey: "sk-test", model: "usage-ok", timeoutMs: 5000 });
  assert.equal(skipped.ok, true);
  assert.equal(skipped.profile.requestShape?.streamUsage, undefined, "LILY_PROBE_STREAM_USAGE=0 skips the check");
  delete process.env.LILY_PROBE_STREAM_USAGE;
} finally {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("probe-stream-usage: ok");
