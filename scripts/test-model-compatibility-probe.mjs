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
  assert.equal(requests.length, 2, "probe should try the plain request, then one candidate repair");
  assert.equal(requests[0].chat_template_kwargs, undefined, "first probe must measure the endpoint as configured");
  assert.equal(requests[1].chat_template_kwargs.enable_thinking, false, "second probe applies the discovered candidate");

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
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("model-compatibility-probe: ok");
