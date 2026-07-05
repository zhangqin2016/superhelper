#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRequire } from "node:module";

process.env.MODEL_GATEWAY_TOKEN_SECRET = "test-openai-route-secret";
process.env.ACCOUNT_USAGE_ENFORCEMENT = "false";
process.env.MODEL_GATEWAY_PROVIDERS = JSON.stringify({
  "iluvatar-vllm": {
    type: "openai",
    baseUrl: "http://127.0.0.1:18000/v1",
    apiKey: "sk-test-vllm",
    model: "/private/Qwen3-Next-80B-A3B-Instruct",
    models: ["/private/Qwen3-Next-80B-A3B-Instruct"],
  },
  anthropic_only: {
    type: "anthropic",
    baseUrl: "https://anthropic-upstream.test",
    apiKey: "sk-test-anthropic",
    model: "claude-test",
    models: ["claude-test"],
  },
});

const requireServer = createRequire(new URL("../server/package.json", import.meta.url));
const Fastify = requireServer("fastify");
const { modelGatewayRoutes, signModelGatewayToken } = await import("../server/src/services/model-gateway.js");

const app = Fastify({ logger: false });
await app.register(modelGatewayRoutes);
await app.ready();

const token = signModelGatewayToken({
  deviceId: "device-openai-route-test",
  licenseId: "license-openai-route-test",
  providerId: "iluvatar-vllm",
});

const originalFetch = globalThis.fetch;
const upstreamRequests = [];

globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  upstreamRequests.push({ url: String(url), init, body });
  if (body.stream) {
    return new Response(
      [
        "data: {\"id\":\"chatcmpl-stream\",\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"list_files\",\"arguments\":\"{\\\"path\\\":\\\".\\\"}\"}}]},\"finish_reason\":null}]}",
        "",
        "data: {\"id\":\"chatcmpl-stream\",\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}",
        "",
        "data: [DONE]",
        "",
      ].join("\n"),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  }
  return new Response(JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion",
    model: body.model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "list_files", arguments: "{\"path\":\".\"}" },
        }],
      },
      finish_reason: "tool_calls",
    }],
  }), { status: 200, headers: { "content-type": "application/json" } });
};

try {
  const payload = {
    model: "/private/Qwen3-Next-80B-A3B-Instruct",
    messages: [{ role: "user", content: "查看当前目录内容" }],
    tools: [{
      type: "function",
      function: {
        name: "list_files",
        description: "List files",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    }],
    tool_choice: "auto",
    stream: false,
  };
  const response = await app.inject({
    method: "POST",
    url: "/llm/iluvatar-vllm/v1/chat/completions",
    headers: { Authorization: `Bearer ${token}` },
    payload,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(upstreamRequests[0].url, "http://127.0.0.1:18000/v1/chat/completions");
  assert.deepEqual(upstreamRequests[0].body.tools, payload.tools, "OpenAI tools must pass through without Anthropic conversion");
  assert.equal(upstreamRequests[0].body.tool_choice, "auto");
  assert.equal(response.json().choices[0].finish_reason, "tool_calls");
  assert.equal(response.json().choices[0].message.tool_calls[0].function.name, "list_files");

  const streamResponse = await app.inject({
    method: "POST",
    url: "/llm/iluvatar-vllm/v1/chat/completions",
    headers: { Authorization: `Bearer ${token}` },
    payload: { ...payload, stream: true },
  });
  assert.equal(streamResponse.statusCode, 200);
  assert.match(streamResponse.body, /"delta":\{"tool_calls"/, "streaming OpenAI tool_call delta must pass through");
  assert.doesNotMatch(streamResponse.body, /content_block_start/, "OpenAI route must not emit Anthropic SSE events");

  const wrongToken = signModelGatewayToken({
    deviceId: "device-openai-route-test",
    licenseId: "license-openai-route-test",
    providerId: "anthropic_only",
  });
  const wrongProvider = await app.inject({
    method: "POST",
    url: "/llm/anthropic_only/v1/chat/completions",
    headers: { Authorization: `Bearer ${wrongToken}` },
    payload,
  });
  assert.equal(wrongProvider.statusCode, 400);
} finally {
  globalThis.fetch = originalFetch;
  await app.close();
}

console.log("model gateway OpenAI route: ok");
