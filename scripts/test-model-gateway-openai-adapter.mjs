#!/usr/bin/env node
import assert from "node:assert/strict";
import { forwardOpenAi } from "../server/src/services/model-gateway/openai-adapter.js";

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
} finally {
  globalThis.fetch = originalFetch;
}

console.log("model gateway OpenAI adapter: ok");
