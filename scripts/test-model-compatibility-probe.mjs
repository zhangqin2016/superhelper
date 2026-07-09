#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-model-probe-"));
process.env.LILY_USER_DATA_DIR = tmp;
process.env.LILY_HOME = os.homedir();
process.env.LILY_DOCUMENTS_DIR = tmp;

const require = createRequire(import.meta.url);
const { probeCustomModelProfile } = require("../src/main/model-compatibility-probe.js");
const modelPresets = require("../src/main/model-presets.js");

const requests = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    const parsed = JSON.parse(body || "{}");
    requests.push(parsed);
    if (!req.url.includes("/chat/completions")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    const thinkingDisabled = parsed.chat_template_kwargs?.enable_thinking === false;
    if (parsed.stream) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      send({
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        model: parsed.model,
        choices: [{
          index: 0,
          delta: thinkingDisabled ? { content: "pong" } : { reasoning: "Thinking only" },
          finish_reason: null,
        }],
      });
      send({
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        model: parsed.model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      });
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      model: parsed.model,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: thinkingDisabled ? "pong" : null,
          reasoning: thinkingDisabled ? null : "Thinking only",
        },
        finish_reason: thinkingDisabled ? "stop" : "length",
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  const { port } = server.address();
  const result = await probeCustomModelProfile({
    protocol: "openai",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: "sk-test-probe",
    model: "provider/model-with-reasoning-default",
    timeoutMs: 5_000,
  });

  assert.equal(result.ok, true, `probe should succeed: ${JSON.stringify(result)}`);
  assert.deepEqual(
    result.profile.requestBodyOverlay,
    { chat_template_kwargs: { enable_thinking: false } },
    "probe should discover a request body overlay instead of relying on model name heuristics",
  );
  assert.equal(result.profile.conformance.chatCompletions, true, "probe profile records non-stream chat conformance");
  assert.equal(result.profile.conformance.streaming, true, "probe profile records streaming conformance");
  assert.equal(result.profile.conformance.contentSource, "body-overlay", "probe profile records how compatibility was achieved");
  assert.equal(requests.length, 4, "probe should verify non-stream and stream for both the plain request and candidate repair");
  assert.equal(requests[0].chat_template_kwargs, undefined, "first probe must measure the endpoint as configured");
  assert.equal(requests[1].chat_template_kwargs, undefined, "plain stream probe must also measure the endpoint as configured");
  assert.equal(requests[2].chat_template_kwargs.enable_thinking, false, "candidate repair applies to non-stream probe");
  assert.equal(requests[3].chat_template_kwargs.enable_thinking, false, "candidate repair also applies to stream probe");
  assert.equal(result.diagnostics.stream, "repaired", "probe must prove the repaired profile works for streaming, not only non-streaming");

  const saved = await modelPresets.saveCustomPresetWithProbe({
    label: "Reasoning Default",
    protocol: "openai",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: "sk-test-probe",
    model: "provider/model-with-reasoning-default",
    probeTimeoutMs: 5_000,
  });
  assert.equal(saved.ok, true, `save with probe should succeed: ${JSON.stringify(saved)}`);
  modelPresets.setActivePreset(saved.preset.id);
  const env = modelPresets.getUserApiEnv();
  assert.equal(
    JSON.parse(env.LILY_OPENCODE_BODY_OVERLAY_JSON).chat_template_kwargs.enable_thinking,
    false,
    "save with probe should persist the discovered body overlay into runtime env",
  );
  const stored = JSON.parse(fs.readFileSync(path.join(tmp, "model-settings.json"), "utf8"));
  const storedPreset = stored.customPresets.find((preset) => preset.id === saved.preset.id);
  assert.equal(storedPreset.compatibilityProfile.conformance.streaming, true, "saved custom model keeps the compatibility contract for diagnostics");
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
}

const streamBrokenServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    const parsed = JSON.parse(body || "{}");
    if (parsed.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({
        id: "chatcmpl-stream-broken",
        object: "chat.completion.chunk",
        model: parsed.model,
        choices: [{ index: 0, delta: { reasoning: "reasoning only" }, finish_reason: null }],
      })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl-stream-broken",
      object: "chat.completion",
      model: parsed.model,
      choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
    }));
  });
});

await new Promise((resolve) => streamBrokenServer.listen(0, "127.0.0.1", resolve));
try {
  const { port } = streamBrokenServer.address();
  const result = await probeCustomModelProfile({
    protocol: "openai",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: "sk-test-probe",
    model: "provider/nonstream-only",
    timeoutMs: 5_000,
  });
  assert.equal(result.ok, false, "probe must reject endpoints that only pass non-stream chat but fail stream content");
  assert.equal(result.error, "MODEL_STREAMING_NO_CONTENT", "stream failure should be explicit instead of a generic no-content error");
} finally {
  await new Promise((resolve) => streamBrokenServer.close(resolve));
}

console.log("model-compatibility-probe: ok");
