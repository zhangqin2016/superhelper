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
const N = (v) => shape.normalizeRequestShape(v);

const OFFICIAL_MAX_TOKENS = { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", type: "invalid_request_error", param: "max_tokens", code: "unsupported_parameter" } };
const OFFICIAL_TEMPERATURE = { error: { message: "Unsupported value: 'temperature' does not support 0 with this model. Only the default (1) value is supported.", type: "invalid_request_error", param: "temperature", code: "unsupported_value" } };
const COMPAT_UNKNOWN_FIELD = { error: { message: "Unrecognized request argument supplied: max_completion_tokens" } };

// --- classifier ----------------------------------------------------------
{
  const e = shape.parseOpenAiError(400, OFFICIAL_MAX_TOKENS);
  assert.deepEqual(shape.classifyShapeRejection({ status: 400, error: e, shape: null, sentBody: { max_tokens: 512 } }),
    { shape: N({ outputLimitField: "max_completion_tokens" }), reason: "unsupported_parameter:max_tokens" }, "official rejection → switch to max_completion_tokens");
  const t = shape.parseOpenAiError(400, OFFICIAL_TEMPERATURE);
  assert.equal(shape.classifyShapeRejection({ status: 400, error: t, shape: { outputLimitField: "max_completion_tokens" }, sentBody: { max_completion_tokens: 8, temperature: 0 } })?.shape.temperature, "omit", "temperature refused → omit it");
  assert.equal(shape.classifyShapeRejection({ status: 400, error: t, shape: null, sentBody: { max_tokens: 8 } }), null, "a temperature complaint when none was sent is not ours to fix");
  const c = shape.parseOpenAiError(400, COMPAT_UNKNOWN_FIELD);
  assert.equal(shape.classifyShapeRejection({ status: 400, error: c, shape: { outputLimitField: "max_completion_tokens" }, sentBody: { max_completion_tokens: 8 } })?.shape.outputLimitField, "max_tokens", "a gateway that does not know the new name gets the old one back");
  // --- generic lessons, read straight from the sentence -------------------
  const omitted = shape.classifyShapeRejection({ status: 400, error: shape.parseOpenAiError(400, { error: { message: "Unsupported parameter: 'top_p' is not supported with this model.", param: "top_p", code: "unsupported_parameter" } }), shape: null, sentBody: { max_tokens: 8, top_p: 0.9 } });
  assert.deepEqual(omitted, { shape: N({ omit: ["top_p"] }), reason: "omit:top_p" }, "any refused field we sent is dropped");
  assert.equal(shape.classifyShapeRejection({ status: 400, error: shape.parseOpenAiError(400, { error: { message: "Unsupported parameter: 'messages'", param: "messages" } }), shape: null, sentBody: { messages: [] } }), null, "essential fields are never dropped");
  const renamed = shape.classifyShapeRejection({ status: 400, error: shape.parseOpenAiError(400, { error: { message: "Unsupported parameter: 'stop' is not supported. Use 'stop_sequences' instead.", code: "unsupported_parameter" } }), shape: null, sentBody: { max_tokens: 8, stop: ["x"] } });
  assert.deepEqual(renamed, { shape: N({ rename: { stop: "stop_sequences" } }), reason: "rename:stop->stop_sequences" }, "'use X instead' renames any field, not just the output limit");
  const auto = shape.classifyShapeRejection({ status: 400, error: shape.parseOpenAiError(400, { error: { message: "tool_choice only supports 'auto' for this model", code: "1210" } }), shape: null, sentBody: { max_tokens: 8, tools: [{}], tool_choice: { type: "function", function: { name: "f" } } } });
  assert.deepEqual(auto, { shape: N({ toolChoice: "auto" }), reason: "tool_choice:auto" }, "a forced tool_choice the gateway refuses falls back to auto");
  const gemini = shape.classifyShapeRejection({ status: 400, error: shape.parseOpenAiError(400, { error: { message: "Invalid JSON payload received. Unknown name \"additionalProperties\" at 'tools[0].function.parameters': Cannot find field.", status: "INVALID_ARGUMENT" } }), shape: null, sentBody: { max_tokens: 8, tools: [{ type: "function", function: { name: "f", parameters: { type: "object", properties: {}, additionalProperties: false } } }] } });
  assert.deepEqual(gemini, { shape: N({ stripSchemaKeywords: ["additionalProperties"] }), reason: "strip_schema_keyword:additionalProperties" }, "a schema keyword the gateway refuses is stripped from tool parameters");
  const applied = shape.applyRequestShape({ model: "m", tools: [{ type: "function", function: { name: "f", parameters: { type: "object", properties: { a: { type: "string", additionalProperties: false } }, additionalProperties: false } } }], tool_choice: { type: "function", function: { name: "f" } }, stop: ["x"], top_p: 0.9 }, N({ stripSchemaKeywords: ["additionalProperties"], toolChoice: "auto", rename: { stop: "stop_sequences" }, omit: ["top_p"] }), { maxTokens: 8 });
  assert.equal(JSON.stringify(applied).includes("additionalProperties"), false, "keyword stripped at every depth"); assert.equal(applied.tool_choice, "auto"); assert.deepEqual(applied.stop_sequences, ["x"]); assert.equal("stop" in applied, false); assert.equal("top_p" in applied, false);
  // --- server-delivered hints for quirks no built-in knows -----------------
  shape.setRemoteHintsProviderForTests(() => [{ id: "acme-logprobs", when: { message: "logprobs.*not available" }, then: { omit: ["logprobs"] } }, { id: "bad-regex", when: { message: "(" }, then: { omit: ["x"] } }]);
  const hinted = shape.classifyShapeRejection({ status: 400, error: shape.parseOpenAiError(400, { error: { message: "The logprobs feature is not available on this deployment" } }), shape: null, sentBody: { max_tokens: 8, logprobs: true } });
  assert.deepEqual(hinted, { shape: N({ omit: ["logprobs"] }), reason: "hint:acme-logprobs" }, "a remote hint teaches what no built-in rule knows, without a release");
  shape.setRemoteHintsProviderForTests(() => { throw new Error("boom"); });
  assert.equal(shape.classifyShapeRejection({ status: 400, error: shape.parseOpenAiError(400, { error: { message: "something odd" } }), shape: null, sentBody: { max_tokens: 8 } }), null, "a broken hint provider never breaks the classifier");
  shape.setRemoteHintsProviderForTests(() => []);
  assert.equal(shape.classifyShapeRejection({ status: 400, error: shape.parseOpenAiError(400, { error: { message: "The model `gpt-x` does not exist", code: "model_not_found" } }), shape: null, sentBody: { max_tokens: 8 } }), null, "an unrelated 400 is not a shape problem");
  assert.equal(shape.classifyShapeRejection({ status: 500, error: e, shape: null, sentBody: { max_tokens: 8 } }), null, "a 5xx is never a shape problem");
  const useResponses = shape.parseOpenAiError(400, { error: { message: "Function tools with reasoning_effort are not supported for gpt-x in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.", type: "invalid_request_error", param: "reasoning_effort", code: null } });
  assert.deepEqual(shape.classifyShapeRejection({ status: 400, error: useResponses, shape: null, sentBody: { max_completion_tokens: 8, tools: [{}] } }), { shape: N({ api: "responses" }), reason: "use_responses_api" }, "the server names the surface that runs tools → learn it");
  assert.equal(shape.classifyShapeRejection({ status: 404, error: shape.parseOpenAiError(404, { error: { message: "This model is not supported in the v1/chat/completions endpoint. Use the v1/responses endpoint instead.", code: null } }), shape: null, sentBody: { max_completion_tokens: 8 } })?.shape.api, "responses", "a Responses-only model says so on a plain request too (codex family, 404)");
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
  assert.deepEqual(shape.compactRequestShape({ outputLimitField: "max_completion_tokens" }), { outputLimitField: "max_completion_tokens", temperature: "allowed", api: "chat" }, "compact form omits empty generic lists");
  assert.deepEqual(shape.compactRequestShape({ omit: ["top_p"] }).omit, ["top_p"]);
  assert.deepEqual(shape.shapeFromEnv({ LILY_MODEL_REQUEST_SHAPE: JSON.stringify({ outputLimitField: "max_completion_tokens" }) }).outputLimitField, "max_completion_tokens");
  assert.deepEqual(shape.shapeFromEnv({ LILY_MODEL_REQUEST_SHAPE: "not json" }), shape.normalizeRequestShape(null), "garbage env → default, never a throw");
}

// --- translation to and from the Responses surface ------------------------
{
  const chat = { model: "m", messages: [{ role: "system", content: "Be terse." }, { role: "user", content: [{ type: "text", text: "what is this" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAA", detail: "low" } }] }],
    max_completion_tokens: 300, temperature: 0, stream: true, tools: [{ type: "function", function: { name: "f", description: "d", parameters: { type: "object", properties: {} } } }], tool_choice: { type: "function", function: { name: "f" } }, chat_template_kwargs: { enable_thinking: false } };
  const r = shape.toResponsesBody(chat);
  assert.equal(r.instructions, "Be terse."); assert.equal(r.max_output_tokens, 300); assert.equal(r.temperature, 0); assert.equal(r.stream, true);
  assert.deepEqual(r.input, [{ role: "user", content: [{ type: "input_text", text: "what is this" }, { type: "input_image", image_url: "data:image/png;base64,AAA", detail: "low" }] }]);
  assert.deepEqual(r.tools, [{ type: "function", name: "f", description: "d", parameters: { type: "object", properties: {} } }]);
  assert.deepEqual(r.tool_choice, { type: "function", name: "f" }); assert.equal("chat_template_kwargs" in r, false, "chat-only knobs are dropped"); assert.equal("messages" in r, false);
  const back = shape.fromResponsesJson({ id: "resp", model: "m", status: "completed", output: [{ type: "reasoning", summary: [{ text: "thought" }] }, { type: "function_call", call_id: "c1", name: "f", arguments: "{\"a\":1}" }], usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } });
  assert.equal(back.choices[0].finish_reason, "tool_calls"); assert.deepEqual(back.choices[0].message.tool_calls, [{ id: "c1", type: "function", function: { name: "f", arguments: "{\"a\":1}" } }]); assert.equal(back.choices[0].message.reasoning, "thought"); assert.equal(back.usage.prompt_tokens, 3);
  const cut = shape.fromResponsesJson({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] });
  assert.equal(cut.choices[0].finish_reason, "length", "an exhausted Responses answer reads as finish_reason=length");
  assert.equal(shape.fromResponsesJson({ output: [{ type: "message", content: [{ type: "output_text", text: "pong" }] }] }).choices[0].message.content, "pong");
  assert.equal(shape.responsesUrl("https://api.example/v1/chat/completions"), "https://api.example/v1/responses");
}
{
  // Responses-only endpoint: chat says "use v1/responses" (404) → same loop re-sends there, caller still reads chat shape.
  const log = [];
  const fake = async (url, init) => { const body = JSON.parse(init.body); log.push({ url, body });
    if (url.endsWith("/chat/completions")) return new Response(JSON.stringify({ error: { message: "This model is not supported in the v1/chat/completions endpoint. Use the v1/responses endpoint instead." } }), { status: 404 });
    return new Response(JSON.stringify({ id: "r", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "pong" }] }], usage: {} }), { status: 200 }); };
  const sent = await shape.sendChatCompletion({ url: "https://api.example/v1/chat/completions", body: { model: "codex", messages: [{ role: "user", content: "Say pong only." }] }, maxTokens: 64, fetchFn: fake });
  assert.equal(sent.ok, true); assert.equal(sent.api, "responses"); assert.equal(sent.json.choices[0].message.content, "pong", "caller reads a chat-shaped answer");
  assert.equal(log[1].url, "https://api.example/v1/responses"); assert.equal(log[1].body.max_output_tokens, 64); assert.equal(log.length, 2);
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
  assert.deepEqual(sent.shape, N({ outputLimitField: "max_completion_tokens", temperature: "omit" }));
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
