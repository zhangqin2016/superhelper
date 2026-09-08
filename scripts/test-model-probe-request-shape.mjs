#!/usr/bin/env node
/**
 * Adding a model whose endpoint refuses `max_tokens` (the official API's newer
 * families) must succeed, not fail with "保存失败": the probe learns the field
 * from the rejection, finishes with `max_completion_tokens`, persists the learned
 * shape on the preset, and hands it to the runtime env. A rejection for any
 * OTHER reason carries the server's real words back to the caller.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

process.env.LILY_ALLOW_PLAINTEXT_SECRETS = "1"; // no OS keychain in this harness
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-probe-shape-"));
process.env.LILY_USER_DATA_DIR = tmp; process.env.LILY_HOME = os.homedir(); process.env.LILY_DOCUMENTS_DIR = tmp;
const require = createRequire(import.meta.url);
const { probeCustomModelProfile } = require("../src/main/model-compatibility-probe.js");
const shapes = require("../src/main/openai-request-shape.js");
const modelPresets = require("../src/main/model-presets.js");

const requests = [];
const REASONING_NEED = 3000; // tokens of thinking before this fake answers
const OFFICIAL_MAX_TOKENS = { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", type: "invalid_request_error", param: "max_tokens", code: "unsupported_parameter" } };
// A strict "official" endpoint: refuses max_tokens, refuses a non-default
// temperature, knows only one model, otherwise answers like a plain model.
const server = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const parsed = JSON.parse(body || "{}"); requests.push(parsed);
    const json = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (!req.url.includes("/chat/completions")) return json(404, { error: "not found" });
    if (parsed.model === "missing-model") return json(404, { error: { message: "The model `missing-model` does not exist or you do not have access to it.", type: "invalid_request_error", code: "model_not_found" } });
    if ("max_tokens" in parsed) return json(400, OFFICIAL_MAX_TOKENS);
    if (parsed.temperature !== undefined && parsed.temperature !== 1) return json(400, { error: { message: "Unsupported value: 'temperature' does not support 0 with this model.", param: "temperature", code: "unsupported_value" } });
    const hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
    const toolCall = { id: "call_probe", type: "function", function: { name: "lily_probe_tool", arguments: "{\"ok\":true}" } };
    // A reasoning model: below REASONING_NEED tokens the whole budget goes to
    // thinking and the answer is cut off — finish_reason "length", nothing else.
    if (Number(parsed.max_completion_tokens) < REASONING_NEED) {
      if (parsed.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", model: parsed.model, choices: [{ index: 0, delta: {}, finish_reason: "length" }] })}\n\n`);
        res.write("data: [DONE]\n\n"); res.end(); return;
      }
      return json(200, { id: "c", object: "chat.completion", model: parsed.model, choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "length" }], usage: { prompt_tokens: 1, completion_tokens: parsed.max_completion_tokens, completion_tokens_details: { reasoning_tokens: parsed.max_completion_tokens } } });
    }
    if (parsed.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      send({ id: "c", object: "chat.completion.chunk", model: parsed.model, choices: [{ index: 0, delta: hasTools ? { tool_calls: [{ index: 0, ...toolCall }] } : { content: "pong" }, finish_reason: null }] });
      send({ id: "c", object: "chat.completion.chunk", model: parsed.model, choices: [{ index: 0, delta: {}, finish_reason: hasTools ? "tool_calls" : "stop" }] });
      res.write("data: [DONE]\n\n"); res.end(); return;
    }
    json(200, { id: "c", object: "chat.completion", model: parsed.model, choices: [{ index: 0, message: hasTools ? { role: "assistant", content: null, tool_calls: [toolCall] } : { role: "assistant", content: "pong" }, finish_reason: hasTools ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;

try {
  shapes.resetLearnedShapesForTests();
  const result = await probeCustomModelProfile({ protocol: "openai", baseUrl, apiKey: "sk-test", model: "gpt-strict", timeoutMs: 5000 });
  assert.equal(result.ok, true, `probe must pass on a strict official endpoint: ${JSON.stringify(result)}`);
  assert.deepEqual(result.profile.requestShape, { outputLimitField: "max_completion_tokens", temperature: "allowed" }, "the learned shape is part of the profile");
  const rejected = requests.filter((r) => "max_tokens" in r).length;
  assert.equal(rejected, 1, `exactly ONE request paid for the lesson, got ${rejected}`);
  assert.equal(requests.filter((r) => "max_completion_tokens" in r).length, requests.length - 1, "every later request used the learned field");
  assert.equal(result.profile.conformance.toolCalls, true, "tool conformance still measured under the learned shape");
  assert.ok(requests.some((r) => Number(r.max_completion_tokens) >= REASONING_NEED), "the budget was raised when the server reported exhaustion (finish_reason=length)");
  assert.ok(requests.filter((r) => Array.isArray(r.tools) && Number(r.max_completion_tokens) >= REASONING_NEED).length >= 2, "the working budget was reused for the tool probes and their stream pass");

  // Persisted through the preset and visible to the runtime.
  const saved = await modelPresets.saveCustomPresetWithProbe({ label: "Strict", model: "gpt-strict", baseUrl, apiKey: "sk-test-0123456789", protocol: "openai", probeTimeoutMs: 5000 });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const env = modelPresets.getUserApiEnv();
  assert.ok(env.LILY_MODEL_REQUEST_SHAPE, "runtime env carries the learned shape");
  assert.equal(JSON.parse(env.LILY_MODEL_REQUEST_SHAPE).outputLimitField, "max_completion_tokens");
  const stored = modelPresets.listPresetsPublic().presets.find((p) => p.custom && p.model === "gpt-strict");
  assert.ok(stored, "preset stored");

  // Engine config: with an output limit configured, the number rides
  // max_completion_tokens through model options and the SDK gets no max_tokens.
  const { resolveOpencodeModelConfig } = require("../src/main/runtime/opencode-model-config.js");
  const cfg = resolveOpencodeModelConfig({ ...env, LILY_MODEL: "gpt-strict", LILY_MAX_OUTPUT_TOKENS: "2048", LILY_OPENCODE_PROTOCOL: "openai" });
  assert.equal(cfg.ok, true, cfg.reason);
  const models = JSON.parse(cfg.configContent).provider[cfg.model.providerID].models;
  const m = models[cfg.model.modelID];
  assert.equal(m.options?.max_completion_tokens, 2048, "learned field carries the configured output limit");
  assert.equal(m.limit?.output || 0, 0, "no limit.output → the SDK sends no max_tokens");

  // A rejection for another reason reaches the caller with the server's words.
  shapes.resetLearnedShapesForTests();
  const missing = await probeCustomModelProfile({ protocol: "openai", baseUrl, apiKey: "sk-test", model: "missing-model", timeoutMs: 5000 });
  assert.equal(missing.ok, false); assert.equal(missing.error, "HTTP_404");
  assert.equal(missing.detail?.code, "model_not_found"); assert.match(missing.detail?.message || "", /does not exist/);
  const savedMissing = await modelPresets.saveCustomPresetWithProbe({ label: "Missing", model: "missing-model", baseUrl, apiKey: "sk-test-0123456789", protocol: "openai", probeTimeoutMs: 5000 });
  assert.equal(savedMissing.ok, false); assert.equal(savedMissing.detail?.code, "model_not_found", "save surfaces the structured detail");
  console.log("model probe request shape: ok");
} finally {
  server.close(); fs.rmSync(tmp, { recursive: true, force: true });
}
