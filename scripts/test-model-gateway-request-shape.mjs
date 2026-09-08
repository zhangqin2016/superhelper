#!/usr/bin/env node
/**
 * The platform gateway learns an upstream's request shape from its own 4xx:
 * `max_tokens` refused → re-sent as `max_completion_tokens` and remembered for
 * that provider+model; temperature refused → dropped; any other 4xx/5xx is
 * returned untouched with a single upstream call.
 */
import assert from "node:assert/strict";
import { forwardOpenAiChatCompletions } from "../server/src/services/model-gateway/openai-adapter.js";
import { resetLearnedShapesForTests } from "../server/src/services/model-gateway/request-shape.js";

const OFFICIAL_MAX_TOKENS = { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", type: "invalid_request_error", param: "max_tokens", code: "unsupported_parameter" } };
const OFFICIAL_TEMPERATURE = { error: { message: "Unsupported value: 'temperature' does not support 0 with this model. Only the default (1) value is supported.", type: "invalid_request_error", param: "temperature", code: "unsupported_value" } };
const originalFetch = globalThis.fetch;
const provider = { id: "openai", type: "openai", baseUrl: "https://api.example/v1", apiKey: "k", model: "gpt-x", metadata: { models: { "gpt-x": { maxOutputTokens: 4096 } } }, headers: {} };
let calls = [];
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body); calls.push(body);
  const reply = (status, json) => new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  if (body.model === "missing") return reply(404, { error: { message: "The model `missing` does not exist", code: "model_not_found" } });
  if (body.model === "down") return reply(503, { error: { message: "overloaded" } });
  if ("max_tokens" in body) return reply(400, OFFICIAL_MAX_TOKENS);
  if (body.temperature !== undefined && body.temperature !== 1) return reply(400, OFFICIAL_TEMPERATURE);
  return reply(200, { id: "ok", choices: [{ message: { role: "assistant", content: "pong" } }] });
};
try {
  resetLearnedShapesForTests();
  const first = await forwardOpenAiChatCompletions(provider, { model: "gpt-x", max_tokens: 32000, temperature: 0, messages: [{ role: "user", content: "ping" }] });
  assert.equal(first.status, 200, "the caller sees success, not the upstream's parameter complaint");
  assert.equal(calls.length, 3, "max_tokens refused, temperature refused, then accepted");
  assert.equal(calls[0].max_tokens, 4096, "the provider cap still applies before any lesson");
  assert.equal(calls[2].max_completion_tokens, 4096, "the same capped number rides the field the upstream wants");
  assert.equal("max_tokens" in calls[2], false); assert.equal("temperature" in calls[2], false);

  calls = [];
  const second = await forwardOpenAiChatCompletions(provider, { model: "gpt-x", max_tokens: 100, temperature: 0, messages: [] });
  assert.equal(second.status, 200); assert.equal(calls.length, 1, "remembered: the next request for this provider+model costs one call");
  assert.equal(calls[0].max_completion_tokens, 100);

  calls = [];
  const notFound = await forwardOpenAiChatCompletions(provider, { model: "missing", max_tokens: 10, messages: [] });
  assert.equal(notFound.status, 404, "an unrelated 4xx is passed through"); assert.equal(calls.length, 1);
  assert.match(await notFound.text(), /does not exist/, "the body is still readable by the caller");

  calls = [];
  const down = await forwardOpenAiChatCompletions(provider, { model: "down", max_tokens: 10, messages: [] });
  assert.equal(down.status, 503); assert.equal(calls.length, 1, "a 5xx is never treated as a shape lesson");

  // A different model on the same provider starts from the default again.
  calls = [];
  await forwardOpenAiChatCompletions(provider, { model: "gpt-y", max_tokens: 10, messages: [] });
  assert.equal("max_tokens" in calls[0], true, "lessons are per model, not per provider");
  console.log("model gateway request shape: ok");
} finally {
  globalThis.fetch = originalFetch;
}
