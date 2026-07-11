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
const promptProbeText = `${"# Lily guide\n\n".repeat(2000)}Use tools carefully and answer the user.`;
const shortPromptProbeText = `${"# Lily short guide\n\n".repeat(250)}`.slice(0, 5_000);
const largePromptProbeText = "# Lily 48 KiB guide\n\n".padEnd(48 * 1024, "x");

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
    const systemChars = (parsed.messages || [])
      .filter((message) => message?.role === "system")
      .map((message) => String(message.content || "").length)
      .reduce((sum, value) => sum + value, 0);
    if (systemChars > 10_000) {
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: {
          code: "context_length_exceeded",
          message: "System prompt is too long; maximum context input is 10000 characters.",
        },
      }));
      return;
    }
    const hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
    if (parsed.stream) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      if (hasTools && thinkingDisabled) {
        send({
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          model: parsed.model,
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: "call_probe",
                type: "function",
                function: { name: "lily_probe_tool", arguments: "{\"ok\":true}" },
              }],
            },
            finish_reason: null,
          }],
        });
        send({
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          model: parsed.model,
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        });
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
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
        message: hasTools && thinkingDisabled
          ? {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call_probe",
                type: "function",
                function: { name: "lily_probe_tool", arguments: "{\"ok\":true}" },
              }],
            }
          : {
              role: "assistant",
              content: thinkingDisabled ? "pong" : null,
              reasoning: thinkingDisabled ? null : "Thinking only",
            },
        finish_reason: hasTools && thinkingDisabled ? "tool_calls" : thinkingDisabled ? "stop" : "length",
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
    systemPromptProbeText: promptProbeText,
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
  assert.equal(result.profile.conformance.toolCalls, true, "probe profile records tool-call conformance");
  assert.equal(result.profile.conformance.contentSource, "body-overlay", "probe profile records how compatibility was achieved");
  assert.equal(result.profile.prompt.systemMaxChars, 10000, "probe should discover the endpoint's safe system prompt size");
  assert.deepEqual(
    result.profile.capability,
    { grade: "standard", signals: { instructionFidelity: false, toolChoiceAuto: true } },
    "mock volunteers tool calls under tool_choice:auto but echoes lowercase pong → standard grade",
  );
  assert(requests.length > 6, "probe should verify chat, stream, tools, and system prompt capacity");
  assert.equal(requests[0].chat_template_kwargs, undefined, "first probe must measure the endpoint as configured");
  assert.equal(requests[1].chat_template_kwargs, undefined, "plain stream probe must also measure the endpoint as configured");
  assert.equal(requests[2].chat_template_kwargs.enable_thinking, false, "candidate repair applies to non-stream probe");
  assert.equal(requests[3].chat_template_kwargs.enable_thinking, false, "candidate repair also applies to stream probe");
  assert.equal(Array.isArray(requests[4].tools), true, "candidate repair must be checked with non-stream tools");
  assert.equal(Array.isArray(requests[5].tools), true, "candidate repair must be checked with streaming tools");
  assert.equal(result.diagnostics.stream, "repaired", "probe must prove the repaired profile works for streaming, not only non-streaming");

  const saved = await modelPresets.saveCustomPresetWithProbe({
    label: "Reasoning Default",
    protocol: "openai",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: "sk-test-probe",
    model: "provider/model-with-reasoning-default",
    systemPromptProbeText: promptProbeText,
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
  assert.equal(env.LILY_OPENCODE_SYSTEM_PROMPT_MAX_CHARS, "10000", "save with probe should persist the discovered system prompt budget");
  assert.equal(env.LILY_MODEL_CAPABILITY_GRADE, "standard", "save with probe should hand the capability grade to the runtime env");
  const stored = JSON.parse(fs.readFileSync(path.join(tmp, "model-settings.json"), "utf8"));
  const storedPreset = stored.customPresets.find((preset) => preset.id === saved.preset.id);
  assert.equal(storedPreset.compatibilityProfile.conformance.streaming, true, "saved custom model keeps the compatibility contract for diagnostics");
  assert.equal(storedPreset.compatibilityProfile.conformance.toolCalls, true, "saved custom model records tool-call conformance for agent safety");
  assert.equal(storedPreset.compatibilityProfile.prompt.systemMaxChars, 10000, "saved custom model records prompt capacity for runtime prompt budgeting");

  const legacy = modelPresets.saveCustomPreset({
    label: "Legacy Reasoning Default",
    protocol: "openai",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: "sk-test-probe",
    model: "provider/model-with-reasoning-default",
  });
  assert.equal(legacy.ok, true, `legacy custom save path should still save: ${JSON.stringify(legacy)}`);
  modelPresets.setActivePreset(legacy.preset.id);
  const legacyEnvBeforeRepair = modelPresets.getUserApiEnv();
  assert.equal(
    legacyEnvBeforeRepair.LILY_OPENCODE_BODY_OVERLAY_JSON,
    undefined,
    "legacy custom presets start without a compatibility overlay",
  );
  const repaired = await modelPresets.repairCustomPresetCompatibilityProfiles({
    activeOnly: true,
    systemPromptProbeText: promptProbeText,
    timeoutMs: 5_000,
  });
  assert.equal(repaired.ok, true, `legacy repair should not fail: ${JSON.stringify(repaired)}`);
  assert.equal(repaired.repairedCount, 1, "legacy repair should profile the active custom model once");
  const legacyEnvAfterRepair = modelPresets.getUserApiEnv();
  assert.equal(
    JSON.parse(legacyEnvAfterRepair.LILY_OPENCODE_BODY_OVERLAY_JSON).chat_template_kwargs.enable_thinking,
    false,
    "legacy repair must persist the discovered overlay into runtime env",
  );

  // A short guide succeeding against an endpoint with ample prompt capacity
  // proves only that the sample fits. It must not turn the sample length into
  // a sticky hard ceiling, and a current no-ceiling profile must not re-probe
  // forever when settings are reopened.
  const amplePromptServer = capabilityMockServer();
  await new Promise((resolve) => amplePromptServer.listen(0, "127.0.0.1", resolve));
  try {
    const amplePort = amplePromptServer.address().port;
    const ampleBaseUrl = `http://127.0.0.1:${amplePort}/v1`;
    const ample = await probeCustomModelProfile({
      protocol: "openai",
      baseUrl: ampleBaseUrl,
      apiKey: "sk-test-probe",
      model: "provider/ample-prompt-capacity",
      systemPromptProbeText: shortPromptProbeText,
      timeoutMs: 5_000,
    });
    assert.equal(ample.ok, true, `ample prompt probe should succeed: ${JSON.stringify(ample)}`);
    assert.equal(ample.profile.prompt, undefined,
      "a successful ~5k sample must not be persisted as an artificial system-prompt ceiling");
    assert.equal(ample.profile.probeVersion, 7,
      "probe profile must carry probeVersion 7 so stored v6 profiles re-probe via the ratchet");

    const ampleLarge = await probeCustomModelProfile({
      protocol: "openai",
      baseUrl: ampleBaseUrl,
      apiKey: "sk-test-probe",
      model: "provider/ample-large-prompt-capacity",
      systemPromptProbeText: largePromptProbeText,
      timeoutMs: 5_000,
    });
    assert.equal(ampleLarge.ok, true, `ample 48 KiB prompt probe should succeed: ${JSON.stringify(ampleLarge)}`);
    assert.equal(ampleLarge.profile.prompt, undefined,
      "an ample endpoint accepting the full 48 KiB guide must not inherit the 32768 probe rung as a ceiling");

    const ampleSaved = modelPresets.saveCustomPreset({
      label: "Ample Prompt Capacity",
      protocol: "openai",
      baseUrl: ampleBaseUrl,
      apiKey: "sk-test-probe",
      model: "provider/ample-prompt-capacity",
      compatibilityProfile: ample.profile,
    });
    assert.equal(ampleSaved.ok, true, `ample profile should persist: ${JSON.stringify(ampleSaved)}`);
    modelPresets.setActivePreset(ampleSaved.preset.id);
    const noReprobe = await modelPresets.repairCustomPresetCompatibilityProfiles({
      activeOnly: true,
      systemPromptProbeText: shortPromptProbeText,
      timeoutMs: 5_000,
    });
    assert.equal(noReprobe.repairedCount, 0,
      "a current profile with no observed prompt ceiling must not be re-probed forever");
    assert.deepEqual(noReprobe.errors, [], "skipping a current no-ceiling profile must make no network repair attempt");
  } finally {
    await new Promise((resolve) => amplePromptServer.close(resolve));
  }
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

const noToolsServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    const parsed = JSON.parse(body || "{}");
    if (parsed.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({
        id: "chatcmpl-no-tools",
        object: "chat.completion.chunk",
        model: parsed.model,
        choices: [{
          index: 0,
          delta: Array.isArray(parsed.tools) ? { content: "I cannot call tools" } : { content: "pong" },
          finish_reason: null,
        }],
      })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl-no-tools",
      object: "chat.completion",
      model: parsed.model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: Array.isArray(parsed.tools) ? "I cannot call tools" : "pong" },
        finish_reason: "stop",
      }],
    }));
  });
});

await new Promise((resolve) => noToolsServer.listen(0, "127.0.0.1", resolve));
try {
  const { port } = noToolsServer.address();
  const result = await probeCustomModelProfile({
    protocol: "openai",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: "sk-test-probe",
    model: "provider/no-tools",
    timeoutMs: 5_000,
  });
  assert.equal(result.ok, false, "probe must reject endpoints that chat but cannot call tools");
  assert.equal(result.error, "MODEL_TOOL_CALLS_UNAVAILABLE", "tool-call failure should be explicit");
} finally {
  await new Promise((resolve) => noToolsServer.close(resolve));
}

// Mirrors the OICM+ gateway family: a single short flat tool works, but any
// request whose tools carry a long function name (>35 chars) or a nested
// object parameter dies with an HTTP 200 + HTML error page.
const toolShapeLimitedServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    const parsed = JSON.parse(body || "{}");
    const tools = Array.isArray(parsed.tools) ? parsed.tools : [];
    const hasNestedObject = (schema) => Object.values(schema?.properties || {})
      .some((prop) => prop?.type === "object" && prop?.properties);
    const rejected = tools.some((tool) =>
      String(tool?.function?.name || "").length > 35 || hasNestedObject(tool?.function?.parameters));
    if (rejected) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!DOCTYPE html><title>Server Unreachable</title>");
      return;
    }
    if (parsed.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      send({
        id: "chatcmpl-shape-limited",
        object: "chat.completion.chunk",
        model: parsed.model,
        choices: [{
          index: 0,
          delta: tools.length
            ? { tool_calls: [{ index: 0, id: "call_probe", type: "function", function: { name: "lily_probe_tool", arguments: "{\"ok\":true}" } }] }
            : { content: "pong" },
          finish_reason: null,
        }],
      });
      send({
        id: "chatcmpl-shape-limited",
        object: "chat.completion.chunk",
        model: parsed.model,
        choices: [{ index: 0, delta: {}, finish_reason: tools.length ? "tool_calls" : "stop" }],
      });
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl-shape-limited",
      object: "chat.completion",
      model: parsed.model,
      choices: [{
        index: 0,
        message: tools.length
          ? { role: "assistant", content: null, tool_calls: [{ id: "call_probe", type: "function", function: { name: "lily_probe_tool", arguments: "{\"ok\":true}" } }] }
          : { role: "assistant", content: "pong" },
        finish_reason: tools.length ? "tool_calls" : "stop",
      }],
    }));
  });
});

await new Promise((resolve) => toolShapeLimitedServer.listen(0, "127.0.0.1", resolve));
try {
  const { port } = toolShapeLimitedServer.address();
  const result = await probeCustomModelProfile({
    protocol: "openai",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: "sk-test-probe",
    model: "provider/tool-shape-limited",
    timeoutMs: 5_000,
  });
  assert.equal(result.ok, true, `shape-limited gateways must save with the compat profile: ${JSON.stringify(result)}`);
  assert.equal(result.profile.toolShapeCompat, true, "probe must flag tool-shape compat so runtime shortens MCP keys");
  assert.equal(result.profile.conformance.toolCalls, true, "simple tool calls still count as conformant under compat");
  assert.equal(result.profile.conformance.toolShape, "compat", "conformance must record the compat contract");
} finally {
  await new Promise((resolve) => toolShapeLimitedServer.close(resolve));
}

// Mirrors the real OICM+ endpoint exactly: thinking-default model (plain
// content probe sees reasoning only) AND the gateway kills Lily-shaped tools.
// The final diagnosis must surface the tool-shape blocker, not reasoning-only.
const thinkingAndShapeLimitedServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    const parsed = JSON.parse(body || "{}");
    const tools = Array.isArray(parsed.tools) ? parsed.tools : [];
    const thinkingDisabled = parsed.chat_template_kwargs?.enable_thinking === false;
    const hasNestedObject = (schema) => Object.values(schema?.properties || {})
      .some((prop) => prop?.type === "object" && prop?.properties);
    const rejected = tools.some((tool) =>
      String(tool?.function?.name || "").length > 35 || hasNestedObject(tool?.function?.parameters));
    if (rejected) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!DOCTYPE html><title>Server Unreachable</title>");
      return;
    }
    if (parsed.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      send({
        id: "chatcmpl-thinking-shape",
        object: "chat.completion.chunk",
        model: parsed.model,
        choices: [{
          index: 0,
          delta: tools.length && thinkingDisabled
            ? { tool_calls: [{ index: 0, id: "call_probe", type: "function", function: { name: "lily_probe_tool", arguments: "{\"ok\":true}" } }] }
            : thinkingDisabled ? { content: "pong" } : { reasoning: "Thinking only" },
          finish_reason: null,
        }],
      });
      send({
        id: "chatcmpl-thinking-shape",
        object: "chat.completion.chunk",
        model: parsed.model,
        choices: [{ index: 0, delta: {}, finish_reason: thinkingDisabled ? (tools.length ? "tool_calls" : "stop") : "length" }],
      });
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl-thinking-shape",
      object: "chat.completion",
      model: parsed.model,
      choices: [{
        index: 0,
        message: tools.length && thinkingDisabled
          ? { role: "assistant", content: null, tool_calls: [{ id: "call_probe", type: "function", function: { name: "lily_probe_tool", arguments: "{\"ok\":true}" } }] }
          : { role: "assistant", content: thinkingDisabled ? "pong" : null, reasoning: thinkingDisabled ? null : "Thinking only" },
        finish_reason: thinkingDisabled ? (tools.length ? "tool_calls" : "stop") : "length",
      }],
    }));
  });
});

await new Promise((resolve) => thinkingAndShapeLimitedServer.listen(0, "127.0.0.1", resolve));
try {
  const { port } = thinkingAndShapeLimitedServer.address();
  const result = await probeCustomModelProfile({
    protocol: "openai",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: "sk-test-probe",
    model: "provider/thinking-and-shape-limited",
    timeoutMs: 5_000,
  });
  assert.equal(result.ok, true, `thinking + shape-limited endpoints must save with overlay + compat: ${JSON.stringify(result)}`);
  assert.deepEqual(
    result.profile.requestBodyOverlay,
    { chat_template_kwargs: { enable_thinking: false } },
    "the thinking overlay must still be discovered on the shape-limited path",
  );
  assert.equal(result.profile.toolShapeCompat, true, "shape evidence discovered during overlay repair must set the compat flag");
} finally {
  await new Promise((resolve) => thinkingAndShapeLimitedServer.close(resolve));
}

// Capability grading (probeVersion 3): the three gateway archetypes from the
// plan — both signals pass → full; only tool_choice:auto passes → standard;
// auto fails → lite; a probe transport error writes NO capability field
// (fail-open = standard, capability-gate Rule 13).
function capabilityMockServer({
  pongReply = "PONG",
  autoToolCalls = true,
  failPongProbe = false,
  failHintedAutoProbe = false,
  promptProbeResponses = [],
} = {}) {
  let promptProbeRequests = 0;
  const mockServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      const hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
      const autoChoice = parsed.tool_choice === "auto";
      const userText = (parsed.messages || [])
        .filter((message) => message?.role === "user")
        .map((message) => String(message.content || ""))
        .join(" ");
      const systemText = (parsed.messages || [])
        .filter((message) => message?.role === "system")
        .map((message) => String(message.content || ""))
        .join(" ");
      // The v7 stress probe also sends a big system prompt but is NOT part of
      // the prompt-ceiling ladder — exclude it via its fixed READY user text.
      const isStressProbe = userText.includes("READY");
      if (!hasTools && !isStressProbe && systemText.length >= 1_000 && promptProbeRequests < promptProbeResponses.length) {
        const response = promptProbeResponses[promptProbeRequests];
        promptProbeRequests += 1;
        if (response) {
          res.writeHead(response.status, { "content-type": response.contentType || "application/json" });
          res.end(response.raw ?? JSON.stringify(response.json || {}));
          return;
        }
      } else if (!hasTools && !isStressProbe && systemText.length >= 1_000) {
        promptProbeRequests += 1;
      }
      const isPongProbe = userText.includes("PONG");
      if (isPongProbe && failPongProbe) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "capability probe unavailable" }));
        return;
      }
      if (hasTools && autoChoice && failHintedAutoProbe && systemText.includes("NATIVE structured function call")) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "hinted auto-tool probe unavailable" }));
        return;
      }
      const wantsToolCall = hasTools && (!autoChoice || autoToolCalls);
      const content = isPongProbe ? pongReply : "pong";
      const toolCall = { id: "call_probe", type: "function", function: { name: "lily_probe_tool", arguments: "{\"ok\":true}" } };
      if (parsed.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
        send({
          id: "chatcmpl-capability",
          object: "chat.completion.chunk",
          model: parsed.model,
          choices: [{
            index: 0,
            delta: wantsToolCall ? { tool_calls: [{ index: 0, ...toolCall }] } : { content },
            finish_reason: null,
          }],
        });
        send({
          id: "chatcmpl-capability",
          object: "chat.completion.chunk",
          model: parsed.model,
          choices: [{ index: 0, delta: {}, finish_reason: wantsToolCall ? "tool_calls" : "stop" }],
        });
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl-capability",
        object: "chat.completion",
        model: parsed.model,
        choices: [{
          index: 0,
          message: wantsToolCall
            ? { role: "assistant", content: null, tool_calls: [toolCall] }
            : { role: "assistant", content },
          finish_reason: wantsToolCall ? "tool_calls" : "stop",
        }],
      }));
    });
  });
  mockServer.promptProbeRequestCount = () => promptProbeRequests;
  return mockServer;
}

async function probeAgainst(server, model, { systemPromptProbeText = "" } = {}) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    return await probeCustomModelProfile({
      protocol: "openai",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: "sk-test-probe",
      model,
      systemPromptProbeText,
      timeoutMs: 5_000,
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

{
  const transientFull = capabilityMockServer({
    promptProbeResponses: [
      { status: 500, json: { error: { message: "Temporary upstream failure" } } },
      null,
    ],
  });
  const result = await probeAgainst(transientFull, "provider/transient-full-prompt", {
    systemPromptProbeText: largePromptProbeText,
  });
  assert.equal(result.ok, true, "a transient prompt-capacity probe failure must not reject a conformant model");
  assert.equal(result.profile.prompt, undefined,
    "a transient full-source 500 must not descend and manufacture a smaller prompt ceiling");
  assert.equal(transientFull.promptProbeRequestCount(), 1,
    "a transient full-source failure stops the prompt ladder after one request");
}

{
  const explicitSizeLimit = capabilityMockServer({
    promptProbeResponses: [
      {
        status: 413,
        json: { error: { code: "context_length_exceeded", message: "Prompt too long; maximum input is 32768 characters." } },
      },
      null,
    ],
  });
  const result = await probeAgainst(explicitSizeLimit, "provider/explicit-prompt-limit", {
    systemPromptProbeText: largePromptProbeText,
  });
  assert.equal(result.profile.prompt?.systemMaxChars, 32768,
    "an explicit structured prompt-size rejection may descend to the first successful smaller rung");
  assert.equal(explicitSizeLimit.promptProbeRequestCount(), 2,
    "an explicit size rejection descends exactly once before the successful rung");
}

{
  const transientSmaller = capabilityMockServer({
    promptProbeResponses: [
      {
        status: 422,
        json: { error: { code: "context_length_exceeded", message: "Input exceeds the maximum context length." } },
      },
      { status: 500, json: { error: { message: "Temporary failure on the smaller request" } } },
      null,
    ],
  });
  const result = await probeAgainst(transientSmaller, "provider/transient-smaller-prompt", {
    systemPromptProbeText: largePromptProbeText,
  });
  assert.equal(result.profile.prompt, undefined,
    "a transient failure on a smaller rung must stop without recording any ceiling");
  assert.equal(transientSmaller.promptProbeRequestCount(), 2,
    "the ladder stops immediately when a smaller candidate fails transiently");
}

for (const [label, response] of [
  ["generic-400", { status: 400, json: { error: { message: "Invalid request" } } }],
  ["generic-input-policy", { status: 400, json: { error: { message: "Input rate limit policy rejected request" } } }],
  ["input-rate-limit-exceeded", { status: 400, json: { error: { message: "Input rate limit exceeded" } } }],
  ["maximum-input-request-rate", { status: 400, json: { error: { message: "Maximum input request rate exceeded" } } }],
  ["input-tokens-per-minute", { status: 400, json: { error: { message: "Too many input tokens per minute" } } }],
  ["maximum-input-tokens-per-minute", { status: 422, json: { error: { message: "Maximum input tokens per minute exceeded" } } }],
  ["tpm-rpm-quota", { status: 400, json: { error: { message: "Input token quota exceeded (TPM/RPM)" } } }],
  ["rate-limit", { status: 429, json: { error: { message: "Rate limit exceeded" } } }],
  ["malformed-success", { status: 200, contentType: "text/html", raw: "<!DOCTYPE html><title>upstream error</title>" }],
]) {
  const ambiguous = capabilityMockServer({ promptProbeResponses: [response, null] });
  const result = await probeAgainst(ambiguous, `provider/${label}`, { systemPromptProbeText: largePromptProbeText });
  assert.equal(result.profile.prompt, undefined, `${label} is ambiguous and must not create a prompt ceiling`);
  assert.equal(ambiguous.promptProbeRequestCount(), 1, `${label} stops the prompt ladder immediately`);
}

{
  const result = await probeAgainst(capabilityMockServer(), "provider/full-capable");
  assert.equal(result.ok, true, `full-capable probe should succeed: ${JSON.stringify(result)}`);
  assert.deepEqual(
    result.profile.capability,
    { grade: "full", signals: { instructionFidelity: true, toolChoiceAuto: true } },
    "exact PONG + volunteered tool call must grade full",
  );
}

{
  const result = await probeAgainst(capabilityMockServer({ pongReply: "Sure! pong." }), "provider/standard-capable");
  assert.equal(result.ok, true, "standard-capable probe should succeed");
  assert.deepEqual(
    result.profile.capability,
    { grade: "standard", signals: { instructionFidelity: false, toolChoiceAuto: true } },
    "chatty PONG reply with working tool_choice:auto must grade standard",
  );
}

{
  const result = await probeAgainst(capabilityMockServer({ autoToolCalls: false }), "provider/lite-capable");
  assert.equal(result.ok, true, "lite-capable probe should still save (conformance uses forced tool_choice)");
  assert.deepEqual(
    result.profile.capability,
    { grade: "lite", confidence: "confirmed", signals: { instructionFidelity: true, toolChoiceAuto: false } },
    "two successful no-call auto-tool responses are confirmed lite evidence",
  );
}

{
  const result = await probeAgainst(
    capabilityMockServer({ autoToolCalls: false, failHintedAutoProbe: true }),
    "provider/ambiguous-auto-tool",
  );
  assert.equal(result.ok, true, "an ambiguous auto-tool confirmation error must not block a conformant model");
  assert.deepEqual(
    result.profile.capability,
    { grade: "standard", signals: { instructionFidelity: true, toolChoiceAuto: false } },
    "one valid no-call response plus a hinted HTTP error is ambiguous and must fail open to standard",
  );
}

{
  const result = await probeAgainst(capabilityMockServer({ failPongProbe: true }), "provider/capability-error");
  assert.equal(result.ok, true, "a capability-probe transport error must not block saving a conformant model");
  assert.equal(result.profile.capability, undefined, "probe error must omit the capability field entirely (fail-open = standard)");
  assert.equal(result.profile.probeVersion, 7, "profile version still advances so the ratchet can re-probe later");
}

// --- v7 large-prompt stress: gateway hangs on big inputs, small requests pass ---
// (the field case: probes always looked green because probe requests are small,
// while every real turn carries the ~21k system guide and intermittently died)
function stressMockServer({ hangLarge = true, failControl = false } = {}) {
  return http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      const hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
      const userText = (parsed.messages || []).filter((m) => m?.role === "user").map((m) => String(m.content || "")).join(" ");
      const systemChars = (parsed.messages || []).filter((m) => m?.role === "system")
        .reduce((sum, m) => sum + String(m.content || "").length, 0);
      const respond = () => {
        const wantsToolCall = hasTools;
        const content = userText.includes("PONG") ? "PONG" : "pong";
        const toolCall = { id: "call_probe", type: "function", function: { name: "lily_probe_tool", arguments: "{\"ok\":true}" } };
        if (parsed.stream) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
          send({ id: "c", object: "chat.completion.chunk", model: parsed.model, choices: [{ index: 0, delta: wantsToolCall ? { tool_calls: [{ index: 0, ...toolCall }] } : { content }, finish_reason: null }] });
          send({ id: "c", object: "chat.completion.chunk", model: parsed.model, choices: [{ index: 0, delta: {}, finish_reason: wantsToolCall ? "tool_calls" : "stop" }] });
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "c", object: "chat.completion", model: parsed.model, choices: [{ index: 0, message: wantsToolCall ? { role: "assistant", content: "", tool_calls: [toolCall] } : { role: "assistant", content }, finish_reason: wantsToolCall ? "tool_calls" : "stop" }] }));
      };
      if (failControl && userText.includes("Say OK.")) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "control probe unavailable" }));
        return;
      }
      if (hangLarge && systemChars > 8_000) {
        // Hold the socket past the stress timeout — a hang, not a rejection.
        setTimeout(respond, 900);
        return;
      }
      respond();
    });
  });
}

{
  process.env.LILY_PROBE_STRESS_TIMEOUT_MS = "250";
  try {
    const result = await probeAgainst(stressMockServer(), "provider/large-prompt-hangs");
    assert.equal(result.ok, true, `stress probe should still save: ${JSON.stringify(result)}`);
    assert.equal(result.profile.capability.signals.largePromptStable, false,
      "a gateway that hangs on large prompts while small requests pass is recorded unstable");
    assert.equal(result.profile.capability.recipes.systemPromptBudget, 12000,
      "instability tightens the system-guide budget to half the failing size");
    const env = modelPresets.buildCompatibilityProfileRuntimeEnv(result.profile);
    assert.equal(env.LILY_OPENCODE_SYSTEM_PROMPT_MAX_CHARS, "12000",
      "the stress budget reaches the runtime truncation env");

    const killed = await (async () => {
      process.env.LILY_PROBE_LARGE_PROMPT_STRESS = "0";
      try {
        return await probeAgainst(stressMockServer(), "provider/large-prompt-hangs-killed");
      } finally {
        delete process.env.LILY_PROBE_LARGE_PROMPT_STRESS;
      }
    })();
    assert.equal(killed.profile.capability.signals.largePromptStable, undefined,
      "kill switch skips the stress measurement entirely");
    assert.equal(killed.profile.capability.recipes?.systemPromptBudget, undefined,
      "kill switch records no budget");

    const ambiguous = await probeAgainst(
      stressMockServer({ failControl: true }),
      "provider/large-prompt-ambiguous",
    );
    assert.equal(ambiguous.profile.capability.signals.largePromptStable, undefined,
      "a failing control request means the endpoint is sick overall — ambiguous, record nothing");
    assert.equal(ambiguous.profile.capability.recipes?.systemPromptBudget, undefined,
      "ambiguous stress evidence must not tighten the guide budget");
  } finally {
    delete process.env.LILY_PROBE_STRESS_TIMEOUT_MS;
  }
}

{
  process.env.LILY_ENABLE_CAPABILITY_GRADING = "0";
  try {
    const result = await probeAgainst(capabilityMockServer(), "provider/grading-killed");
    assert.equal(result.ok, true, "kill switch must not affect conformance probing");
    assert.equal(result.profile.capability, undefined, "LILY_ENABLE_CAPABILITY_GRADING=0 skips capability probing entirely");
  } finally {
    delete process.env.LILY_ENABLE_CAPABILITY_GRADING;
  }
}

// Recipe calibration (probeVersion 4): when a signal fails in its plain form,
// ONE alternate form is tried and the winner is recorded in capability.recipes.
function recipeMockServer({ zhOnlyFidelity = false, autoNeedsHint = false } = {}) {
  return http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      const hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
      const autoChoice = parsed.tool_choice === "auto";
      const userText = (parsed.messages || [])
        .filter((message) => message?.role === "user")
        .map((message) => String(message.content || ""))
        .join(" ");
      const systemText = (parsed.messages || [])
        .filter((message) => message?.role === "system")
        .map((message) => String(message.content || ""))
        .join(" ");
      const isZhPongProbe = userText.includes("只回复");
      const isPongProbe = userText.includes("PONG");
      const systemHasExample = systemText.includes("lily_probe_tool");
      const content = isZhPongProbe
        ? "PONG"
        : isPongProbe
          ? (zhOnlyFidelity ? "Sure thing: pong!" : "PONG")
          : "pong";
      const wantsToolCall = hasTools && (!autoChoice || (autoNeedsHint ? systemHasExample : true));
      const toolCall = { id: "call_probe", type: "function", function: { name: "lily_probe_tool", arguments: "{\"ok\":true}" } };
      if (parsed.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
        send({
          id: "chatcmpl-recipe",
          object: "chat.completion.chunk",
          model: parsed.model,
          choices: [{
            index: 0,
            delta: wantsToolCall ? { tool_calls: [{ index: 0, ...toolCall }] } : { content },
            finish_reason: null,
          }],
        });
        send({
          id: "chatcmpl-recipe",
          object: "chat.completion.chunk",
          model: parsed.model,
          choices: [{ index: 0, delta: {}, finish_reason: wantsToolCall ? "tool_calls" : "stop" }],
        });
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl-recipe",
        object: "chat.completion",
        model: parsed.model,
        choices: [{
          index: 0,
          message: wantsToolCall
            ? { role: "assistant", content: null, tool_calls: [toolCall] }
            : { role: "assistant", content },
          finish_reason: wantsToolCall ? "tool_calls" : "stop",
        }],
      }));
    });
  });
}

{
  const result = await probeAgainst(recipeMockServer({ zhOnlyFidelity: true }), "provider/zh-instruction-follower");
  assert.equal(result.ok, true, "zh-only-fidelity probe should succeed");
  assert.deepEqual(
    result.profile.capability,
    {
      grade: "full",
      signals: { instructionFidelity: true, toolChoiceAuto: true },
      recipes: { instructionLanguage: "zh" },
    },
    "a model that only follows the Chinese instruction gets fidelity credit plus the zh recipe",
  );
}

{
  const result = await probeAgainst(recipeMockServer({ autoNeedsHint: true }), "provider/needs-tool-call-example");
  assert.equal(result.ok, true, "hint-dependent probe should succeed");
  assert.deepEqual(
    result.profile.capability,
    {
      grade: "full",
      signals: { instructionFidelity: true, toolChoiceAuto: true },
      recipes: { toolCallHint: true },
    },
    "a model that volunteers tool calls only WITH the example is upgraded from lite, carrying the recipe the runtime must apply",
  );
}

// Output ceiling (probeVersion 5): a strict-validating gateway that rejects
// oversized max_tokens reveals its ceiling; the highest accepted rung lands in
// recipes. Gateways that accept everything record nothing (strong models and
// silent clampers keep today's behavior).
function ceilingMockServer({ maxTokensLimit = 4096 } = {}) {
  return http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      if (Number(parsed.max_tokens) > maxTokensLimit) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `max_tokens is too large: maximum is ${maxTokensLimit}` } }));
        return;
      }
      const hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
      const userText = (parsed.messages || [])
        .filter((message) => message?.role === "user")
        .map((message) => String(message.content || ""))
        .join(" ");
      const content = userText.includes("PONG") ? "PONG" : "pong";
      const toolCall = { id: "call_probe", type: "function", function: { name: "lily_probe_tool", arguments: "{\"ok\":true}" } };
      if (parsed.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
        send({
          id: "chatcmpl-ceiling",
          object: "chat.completion.chunk",
          model: parsed.model,
          choices: [{ index: 0, delta: hasTools ? { tool_calls: [{ index: 0, ...toolCall }] } : { content }, finish_reason: null }],
        });
        send({
          id: "chatcmpl-ceiling",
          object: "chat.completion.chunk",
          model: parsed.model,
          choices: [{ index: 0, delta: {}, finish_reason: hasTools ? "tool_calls" : "stop" }],
        });
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl-ceiling",
        object: "chat.completion",
        model: parsed.model,
        choices: [{
          index: 0,
          message: hasTools
            ? { role: "assistant", content: null, tool_calls: [toolCall] }
            : { role: "assistant", content },
          finish_reason: hasTools ? "tool_calls" : "stop",
        }],
      }));
    });
  });
}

{
  const result = await probeAgainst(ceilingMockServer({ maxTokensLimit: 4096 }), "provider/low-output-ceiling");
  assert.equal(result.ok, true, `low-ceiling probe should succeed: ${JSON.stringify(result)}`);
  assert.equal(result.profile.capability.recipes.outputTokenCeiling, 4096,
    "a gateway rejecting oversized max_tokens reveals its 4096 ceiling into the recipe");
}

{
  const result = await probeAgainst(ceilingMockServer({ maxTokensLimit: 999999 }), "provider/ample-output-ceiling");
  assert.equal(result.ok, true);
  assert.equal(result.profile.capability.recipes?.outputTokenCeiling, undefined,
    "an ample ceiling records nothing — strong models keep today's behavior");
}

console.log("model-compatibility-probe: ok");
