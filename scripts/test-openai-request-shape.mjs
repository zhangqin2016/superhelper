#!/usr/bin/env node
/**
 * The request shape is LEARNED from the server, never assumed from a model id.
 * Default is what every OpenAI-compatible gateway accepts (`max_tokens`,
 * temperature allowed). A 4xx whose body names the offending parameter adapts
 * the shape and re-sends; anything else surfaces its real (redacted) message.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const shape = require("../src/main/openai-request-shape.js");

const OFFICIAL_MAX_TOKENS = { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", type: "invalid_request_error", param: "max_tokens", code: "unsupported_parameter" } };
const OFFICIAL_TEMPERATURE = { error: { message: "Unsupported value: 'temperature' does not support 0 with this model. Only the default (1) value is supported.", type: "invalid_request_error", param: "temperature", code: "unsupported_value" } };
const COMPAT_UNKNOWN_FIELD = { error: { message: "Unrecognized request argument supplied: max_completion_tokens" } };

// --- classifier ----------------------------------------------------------
{
  const e = shape.parseOpenAiError(400, OFFICIAL_MAX_TOKENS);
  assert.deepEqual(shape.classifyShapeRejection({ status: 400, error: e, shape: null, sentBody: { max_tokens: 512 } }),
    { shape: { outputLimitField: "max_completion_tokens", temperature: "allowed" }, reason: "unsupported_parameter:max_tokens" }, "official rejection → switch to max_completion_tokens");
  const t = shape.parseOpenAiError(400, OFFICIAL_TEMPERATURE);
  assert.equal(shape.classifyShapeRejection({ status: 400, error: t, shape: { outputLimitField: "max_completion_tokens" }, sentBody: { max_completion_tokens: 8, temperature: 0 } })?.shape.temperature, "omit", "temperature refused → omit it");
  assert.equal(shape.classifyShapeRejection({ status: 400, error: t, shape: null, sentBody: { max_tokens: 8 } }), null, "a temperature complaint when none was sent is not ours to fix");
  const c = shape.parseOpenAiError(400, COMPAT_UNKNOWN_FIELD);
  assert.equal(shape.classifyShapeRejection({ status: 400, error: c, shape: { outputLimitField: "max_completion_tokens" }, sentBody: { max_completion_tokens: 8 } })?.shape.outputLimitField, "max_tokens", "a gateway that does not know the new name gets the old one back");
  assert.equal(shape.classifyShapeRejection({ status: 400, error: shape.parseOpenAiError(400, { error: { message: "The model `gpt-x` does not exist", code: "model_not_found" } }), shape: null, sentBody: { max_tokens: 8 } }), null, "an unrelated 400 is not a shape problem");
  assert.equal(shape.classifyShapeRejection({ status: 500, error: e, shape: null, sentBody: { max_tokens: 8 } }), null, "a 5xx is never a shape problem");
  assert.equal(shape.classifyShapeRejection({ status: 401, error: shape.parseOpenAiError(401, { error: { message: "Incorrect API key provided: sk-abcdefghijklmnopqrstuvwxyz", code: "invalid_api_key" } }), shape: null, sentBody: { max_tokens: 8 } }), null);
  assert.doesNotMatch(shape.parseOpenAiError(401, { error: { message: "Incorrect API key provided: sk-abcdefghijklmnopqrstuvwxyz" } }).message, /abcdefghijklmnop/, "keys are redacted out of error messages");
}

// --- body placement ------------------------------------------------------
{
  const a = shape.applyRequestShape({ model: "m", messages: [] }, null, { maxTokens: 512, temperature: 0 });
  assert.deepEqual(a, { model: "m", messages: [], max_tokens: 512, temperature: 0 });
  const b = shape.applyRequestShape({ model: "m", max_tokens: 99 }, { outputLimitField: "max_completion_tokens", temperature: "omit" }, { maxTokens: 512, temperature: 0 });
  assert.deepEqual(b, { model: "m", max_completion_tokens: 512 }, "learned shape: new field, stale field removed, temperature dropped");
  assert.equal(shape.compactRequestShape(null), null, "default shape is not worth persisting");
  assert.deepEqual(shape.compactRequestShape({ outputLimitField: "max_completion_tokens" }), { outputLimitField: "max_completion_tokens", temperature: "allowed" });
  assert.deepEqual(shape.shapeFromEnv({ LILY_MODEL_REQUEST_SHAPE: JSON.stringify({ outputLimitField: "max_completion_tokens" }) }).outputLimitField, "max_completion_tokens");
  assert.deepEqual(shape.shapeFromEnv({ LILY_MODEL_REQUEST_SHAPE: "not json" }), shape.normalizeRequestShape(null), "garbage env → default, never a throw");
}

// --- the send loop against a strict "official" fake -----------------------
function officialFake(log) {
  return async (url, init) => {
    const body = JSON.parse(init.body); log.push(body);
    const reply = (status, json) => new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
    if ("max_tokens" in body) return reply(400, OFFICIAL_MAX_TOKENS);
    if (body.temperature !== undefined && body.temperature !== 1) return reply(400, OFFICIAL_TEMPERATURE);
    if (body.model === "missing") return reply(404, { error: { message: "The model `missing` does not exist", code: "model_not_found" } });
    return reply(200, { choices: [{ message: { role: "assistant", content: "pong" } }] });
  };
}
{
  shape.resetLearnedShapesForTests();
  const log = []; const learned = [];
  const sent = await shape.sendChatCompletion({ url: "https://api.example/v1/chat/completions", body: { model: "gpt-x", messages: [] }, maxTokens: 512, temperature: 0, fetchFn: officialFake(log), onAdapt: (s, reason) => learned.push(reason) });
  assert.equal(sent.ok, true, "adapts and succeeds without the caller doing anything");
  assert.deepEqual(learned, ["unsupported_parameter:max_tokens", "unsupported_value:temperature"], "each rejection taught exactly one thing, in order");
  assert.equal(log.length, 3, "one request per lesson, then success");
  assert.deepEqual(Object.keys(log[2]).sort(), ["max_completion_tokens", "messages", "model"], "final body: new limit field, no temperature");
  assert.deepEqual(sent.shape, { outputLimitField: "max_completion_tokens", temperature: "omit" });
  assert.equal(sent.json.choices[0].message.content, "pong");
}
{
  // Starting from the learned shape, no lesson is needed at all.
  const log = [];
  const sent = await shape.sendChatCompletion({ url: "https://api.example/v1/chat/completions", body: { model: "gpt-x", messages: [] }, maxTokens: 512, temperature: 0, shape: { outputLimitField: "max_completion_tokens", temperature: "omit" }, fetchFn: officialFake(log) });
  assert.equal(sent.ok, true); assert.equal(log.length, 1, "a remembered shape costs zero extra requests");
}
{
  // An unrelated rejection comes back structured, once, with no resend storm.
  const log = [];
  const sent = await shape.sendChatCompletion({ url: "https://api.example/v1/chat/completions", body: { model: "missing", messages: [] }, maxTokens: 8, shape: { outputLimitField: "max_completion_tokens" }, fetchFn: officialFake(log) });
  assert.equal(sent.ok, false); assert.equal(sent.status, 404); assert.equal(sent.error.code, "model_not_found"); assert.match(sent.error.message, /does not exist/); assert.equal(log.length, 1);
}
{
  // A pathological server that rejects BOTH names cannot make us loop forever.
  let n = 0;
  const flipflop = async () => { n += 1; return new Response(JSON.stringify(n % 2 ? OFFICIAL_MAX_TOKENS : COMPAT_UNKNOWN_FIELD), { status: 400 }); };
  const sent = await shape.sendChatCompletion({ url: "u", body: { model: "m" }, maxTokens: 8, fetchFn: flipflop });
  assert.equal(sent.ok, false); assert.ok(n <= 4, `bounded: ${n} requests`);
}
{
  // Network failure is a structured result, not a rejection.
  const sent = await shape.sendChatCompletion({ url: "u", body: { model: "m" }, maxTokens: 8, fetchFn: async () => { throw new Error("ECONNREFUSED sk-secretsecretsecret"); } });
  assert.equal(sent.ok, false); assert.equal(sent.status, 0); assert.equal(sent.error.code, "NETWORK"); assert.doesNotMatch(sent.error.message, /secretsecret/);
}
{
  // Memory: what one call learned, the next call for the same endpoint+model starts from.
  shape.resetLearnedShapesForTests();
  shape.rememberShape("https://api.example/v1/", "gpt-x", { outputLimitField: "max_completion_tokens" });
  assert.equal(shape.recallShape("https://API.example/v1", "gpt-x").outputLimitField, "max_completion_tokens", "key is case/slash-insensitive on the base URL");
  assert.equal(shape.recallShape("https://api.example/v1", "other").outputLimitField, "max_tokens", "a different model starts from the default");
}
console.log("openai request shape: ok");
