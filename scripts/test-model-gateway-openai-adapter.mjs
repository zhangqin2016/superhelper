#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  forwardOpenAi,
  forwardOpenAiChatCompletions,
} from "../server/src/services/model-gateway/openai-adapter.js";
import { scanRealTokenUsage, billableRealTokens } from "../server/src/services/model-gateway/usage.js";

const originalFetch = globalThis.fetch;
let captured = null;

globalThis.fetch = async (url, init) => {
  captured = { url, init, body: JSON.parse(init.body) };
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
};

try {
  await forwardOpenAi(
    {
      type: "openai",
      baseUrl: "http://127.0.0.1:8000/v1",
      apiKey: "test-key",
      model: "/private/Qwen3-Next-80B-A3B-Instruct",
      metadata: {
        models: {
          "/private/Qwen3-Next-80B-A3B-Instruct": { maxOutputTokens: 1024 },
        },
      },
      headers: {},
    },
    {
      model: "/private/Qwen3-Next-80B-A3B-Instruct",
      max_tokens: 32000,
      messages: [{ role: "user", content: "ping" }],
      stream: true,
    },
  );

  assert.equal(captured.url, "http://127.0.0.1:8000/v1/chat/completions");
  assert.equal(captured.body.max_tokens, 1024);
  assert.equal(captured.body.model, "/private/Qwen3-Next-80B-A3B-Instruct");
  assert.equal(captured.body.stream, true);

  await forwardOpenAi(
    {
      type: "openai",
      baseUrl: "http://127.0.0.1:8000/v1",
      apiKey: "test-key",
      model: "/private/Qwen3-Next-80B-A3B-Instruct",
      metadata: {
        models: {
          "/private/Qwen3-Next-80B-A3B-Instruct": { maxOutputTokens: 1024 },
        },
      },
      headers: {},
    },
    {
      model: "another-model",
      max_tokens: 32000,
      messages: [{ role: "user", content: "ping" }],
      stream: true,
    },
  );

  assert.equal(captured.body.max_tokens, 32000, "per-model output cap must not leak to another model");
  assert.equal(captured.body.model, "another-model", "request model should not be overwritten by provider default");

  await forwardOpenAi(
    {
      type: "openai",
      baseUrl: "http://127.0.0.1:8000/v1",
      apiKey: "test-key",
      model: "tight-context",
      metadata: {
        models: {
          "tight-context": { contextWindowTokens: 1200 },
        },
      },
      headers: {},
    },
    {
      model: "tight-context",
      max_tokens: 1000,
      messages: [{ role: "user", content: "x".repeat(4000) }],
      stream: false,
    },
  );

  assert.equal(captured.body.max_tokens, 200, "context window should cap output to remaining budget");

  await forwardOpenAi(
    {
      type: "openai",
      baseUrl: "http://127.0.0.1:8000/v1",
      apiKey: "test-key",
      model: "small",
      metadata: {},
      headers: {},
    },
    {
      model: "small",
      max_tokens: 32000,
      messages: [{ role: "user", content: "ping" }],
      stream: false,
    },
  );

  assert.equal(captured.body.max_tokens, 32000);

  await forwardOpenAi(
    {
      id: "deepseek",
      type: "openai",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "test-key",
      model: "deepseek-v4-pro[1m]",
      models: ["deepseek-v4-pro[1m]"],
      metadata: {},
      headers: {},
    },
    {
      model: "deepseek-v4-pro[1m]",
      max_tokens: 1000,
      messages: [{ role: "user", content: "ping" }],
      stream: false,
    },
  );

  assert.equal(captured.url, "https://api.deepseek.com/v1/chat/completions");
  assert.equal(captured.body.model, "deepseek-v4-pro", "OpenAI DeepSeek route must normalize Anthropic-only model aliases");

  await forwardOpenAiChatCompletions(
    {
      id: "deepseek",
      type: "openai",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "test-key",
      model: "deepseek-v4-pro[1m]",
      metadata: {},
      headers: {},
    },
    {
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "ping" }],
    },
  );

  assert.equal(captured.body.model, "deepseek-v4-pro", "native OpenAI route should normalize DeepSeek flash alias");

  await forwardOpenAiChatCompletions(
    {
      id: "iluvatar-vllm",
      type: "openai",
      baseUrl: "http://127.0.0.1:18000/v1",
      apiKey: "test-key",
      model: "/private/Qwen3.6-27B",
      metadata: {
        contextWindowTokens: 262_144,
        maxOutputTokens: 32_768,
        models: {
          "/private/Qwen3.6-27B": {
            contextWindowTokens: 262_144,
            maxModelLen: 262_144,
            maxOutputTokens: 32_768,
            deploymentProfile: "qwen3.6-27b-256k",
          },
        },
      },
      headers: {},
    },
    {
      model: "/private/Qwen3.6-27B",
      max_tokens: 32_000,
      messages: [{ role: "user", content: "ping" }],
      stream: true,
    },
  );

  assert.equal(captured.body.max_tokens, 4_096, "Iluvatar Qwen3.6-27B default route should cap OpenCode's large output request");

  await forwardOpenAiChatCompletions(
    {
      id: "iluvatar-vllm",
      type: "openai",
      baseUrl: "http://127.0.0.1:18000/v1",
      apiKey: "test-key",
      model: "/private/Qwen3-Coder-Next",
      metadata: {
        models: {
          "/private/Qwen3-Coder-Next": { contextWindowTokens: 65_536, maxOutputTokens: 8_192 },
        },
      },
      headers: {},
    },
    {
      model: "/private/Qwen3-Coder-Next",
      max_tokens: 32_000,
      messages: [{ role: "user", content: "x".repeat(20_000) }],
      stream: true,
    },
  );

  assert.equal(captured.body.max_tokens, 8_192, "native OpenAI gateway route must cap OpenCode's large default output request");
} finally {
  globalThis.fetch = originalFetch;
}

// Real-usage metering: streamed OpenAI-compatible calls must request the final
// usage chunk, and the scanner must recover real input+output tokens (Anthropic
// or OpenAI shaped) so metered billing reconciles against actual usage — not the
// input-only char/4 estimate.
{
  const originalFetch2 = globalThis.fetch;
  let streamBody = null;
  globalThis.fetch = async (_url, init) => {
    streamBody = JSON.parse(init.body);
    return new Response("", { status: 200 });
  };
  try {
    await forwardOpenAiChatCompletions(
      { type: "openai", baseUrl: "http://127.0.0.1:8000/v1", apiKey: "k", model: "m" },
      { model: "m", messages: [{ role: "user", content: "hi" }], stream: true },
    );
    assert.deepEqual(streamBody.stream_options, { include_usage: true }, "streamed calls must opt into a final usage chunk");
  } finally {
    globalThis.fetch = originalFetch2;
  }

  // Anthropic SSE: input_tokens in message_start, cumulative output across deltas.
  let acc = null;
  for (const part of [
    'data: {"message":{"usage":{"input_tokens":1200,"output_tokens":1}}}',
    'data: {"usage":{"output_tokens":40}}',
    'data: {"usage":{"output_tokens":350}}',
  ]) {
    acc = scanRealTokenUsage(part, acc);
  }
  assert.equal(acc.inputTokens, 1200, "input tokens taken from message_start");
  assert.equal(acc.outputTokens, 350, "output tokens track the cumulative maximum, not the initial 1");
  assert.equal(billableRealTokens(acc), 1550, "billable = real input + real output");

  const openai = scanRealTokenUsage('{"usage":{"prompt_tokens":800,"completion_tokens":220}}');
  assert.equal(billableRealTokens(openai), 1020, "OpenAI prompt/completion tokens are also recognized");
  assert.equal(scanRealTokenUsage("event: ping").seen, false, "a body with no usage is flagged unseen so billing falls back to the estimate");
}

console.log("model gateway OpenAI adapter: ok");
