"use strict";

/**
 * The shape of an OpenAI-style chat request, learned from the server instead of
 * guessed from a model name.
 *
 * Every OpenAI-compatible gateway accepts `max_tokens`; the official API's newer
 * model families reject it ("Unsupported parameter: 'max_tokens' … use
 * 'max_completion_tokens' instead") and refuse any `temperature` but the
 * default. Which side of that line a given endpoint sits on cannot be known from
 * its URL or model id — new ids appear weekly and gateways relabel them — so
 * nothing here is keyed on either. The request is sent in the default shape; a
 * 4xx whose error body names the offending parameter is read, the shape is
 * adapted, the request is re-sent once per adaptation, and the learned shape is
 * remembered for that endpoint+model so the next call starts right. A body that
 * is rejected for any other reason surfaces its real message instead of a bare
 * status code.
 */

const OUTPUT_LIMIT_FIELDS = Object.freeze(["max_tokens", "max_completion_tokens"]);
// `api`: "chat" (/chat/completions, every gateway) or "responses" (/responses —
// the official API's newer reasoning models refuse function tools on chat and
// say so in the 400: "use /v1/responses"). Learned from that sentence, nothing
// else.
const DEFAULT_SHAPE = Object.freeze({ outputLimitField: "max_tokens", temperature: "allowed", api: "chat" });
const MAX_ADAPTATIONS = 3;

function normalizeRequestShape(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    outputLimitField: OUTPUT_LIMIT_FIELDS.includes(source.outputLimitField) ? source.outputLimitField : DEFAULT_SHAPE.outputLimitField,
    temperature: source.temperature === "omit" ? "omit" : DEFAULT_SHAPE.temperature,
    api: source.api === "responses" ? "responses" : DEFAULT_SHAPE.api,
  };
}

function isDefaultShape(shape) {
  const s = normalizeRequestShape(shape);
  return s.outputLimitField === DEFAULT_SHAPE.outputLimitField && s.temperature === DEFAULT_SHAPE.temperature && s.api === DEFAULT_SHAPE.api;
}

/** Only a non-default shape is worth persisting or sending to the runtime. */
function compactRequestShape(shape) {
  return isDefaultShape(shape) ? null : normalizeRequestShape(shape);
}

function shapeFromEnv(env = {}) {
  try {
    const raw = String(env.LILY_MODEL_REQUEST_SHAPE || "").trim();
    return raw ? normalizeRequestShape(JSON.parse(raw)) : normalizeRequestShape(null);
  } catch {
    return normalizeRequestShape(null);
  }
}

// Keys and bearer tokens must never ride an error message into a log or toast.
function redactSecrets(text) {
  return String(text || "")
    .replace(/\b(sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, "$1-***")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer ***");
}

/** Structured view of an OpenAI-style error body; never throws. */
function parseOpenAiError(status, json, text = "") {
  const err = json && typeof json === "object" ? (json.error ?? json) : null;
  const pick = (v) => (typeof v === "string" && v.trim() ? v.trim() : "");
  const message = pick(err?.message) || pick(typeof err === "string" ? err : "") || pick(json?.message) || pick(text).slice(0, 300);
  return {
    status: Number(status) || 0,
    code: pick(err?.code) || pick(err?.type) || "",
    type: pick(err?.type),
    param: pick(err?.param),
    message: redactSecrets(message).slice(0, 300),
  };
}

function mentions(text, field) {
  return new RegExp(`(^|[^a-z_])${field}([^a-z_]|$)`).test(text);
}
const UNSUPPORTED_RE = /unsupported|not supported|unrecognized|unknown (?:parameter|argument|field)|invalid (?:parameter|argument)|not allowed|does not support|is not permitted|only the default/;

/**
 * Decide how to change the shape after a rejection. Returns null when the
 * error is about something else — that is the caller's problem to report, not
 * a reason to keep resending.
 */
function classifyShapeRejection({ status, error, shape, sentBody }) {
  const s = Number(status) || 0;
  if (s < 400 || s >= 500) return null;
  const current = normalizeRequestShape(shape);
  const info = error || {};
  const text = `${info.code} ${info.type} ${info.param} ${info.message}`.toLowerCase();
  const param = String(info.param || "").toLowerCase();
  const unsupported = UNSUPPORTED_RE.test(text) || /unsupported_(parameter|value)/.test(param);
  // Which parameter is being refused. Prefer the server's own `param`; fall
  // back to the parameter it names in the sentence. The official message names
  // BOTH fields ("'max_tokens' … use 'max_completion_tokens'"), so the one
  // being refused is the one actually present in what we sent.
  const sentLimit = OUTPUT_LIMIT_FIELDS.find((field) => sentBody && Object.prototype.hasOwnProperty.call(sentBody, field)) || current.outputLimitField;
  const refusedLimit = OUTPUT_LIMIT_FIELDS.includes(param) ? param
    : (mentions(text, sentLimit) && unsupported ? sentLimit : "");
  if (refusedLimit && (unsupported || mentions(text, "max_completion_tokens") || mentions(text, "max_tokens"))) {
    const next = refusedLimit === "max_tokens" ? "max_completion_tokens" : "max_tokens";
    if (next !== current.outputLimitField || refusedLimit === current.outputLimitField) {
      return { shape: { ...current, outputLimitField: next }, reason: `unsupported_parameter:${refusedLimit}` };
    }
  }
  // "To use function tools, use /v1/responses …": the server names the surface
  // that works. Only relevant when tools were sent; a plain chat still works.
  if (current.api === "chat" && /v1\/responses\b|responses api|responses endpoint/i.test(text)) {
    return { shape: { ...current, api: "responses" }, reason: "use_responses_api" };
  }
  const sentTemperature = sentBody && sentBody.temperature !== undefined;
  if (sentTemperature && current.temperature !== "omit" && (param === "temperature" || (mentions(text, "temperature") && unsupported))) {
    return { shape: { ...current, temperature: "omit" }, reason: "unsupported_value:temperature" };
  }
  return null;
}

/** Write the output limit and temperature the way this shape wants them. */
function applyRequestShape(body, shape, { maxTokens = undefined, temperature = undefined } = {}) {
  const s = normalizeRequestShape(shape);
  const out = { ...(body || {}) };
  for (const field of OUTPUT_LIMIT_FIELDS) delete out[field];
  const limit = Number(maxTokens);
  if (Number.isFinite(limit) && limit > 0) out[s.outputLimitField] = Math.floor(limit);
  delete out.temperature;
  if (temperature !== undefined && temperature !== null && s.temperature !== "omit") out.temperature = temperature;
  return out;
}

/** /chat/completions → /responses on the same base. */
function responsesUrl(url) {
  return String(url || "").replace(/\/chat\/completions\/?$/, "/responses");
}

function toResponsesContent(content, role) {
  const textType = role === "assistant" ? "output_text" : "input_text";
  if (typeof content === "string") return [{ type: textType, text: content }];
  if (!Array.isArray(content)) return [];
  return content.map((part) => {
    if (!part || typeof part !== "object") return null;
    if (part.type === "text") return { type: textType, text: String(part.text || "") };
    if (part.type === "image_url") {
      const image = part.image_url && typeof part.image_url === "object" ? part.image_url : { url: part.image_url };
      return { type: "input_image", image_url: String(image?.url || ""), ...(image?.detail ? { detail: image.detail } : {}) };
    }
    return null;
  }).filter(Boolean);
}

/** A chat-completions body, expressed for the Responses surface. System
 *  messages become `instructions`; tools/tool_choice flatten; the output limit
 *  becomes max_output_tokens; chat-only knobs are dropped. */
function toResponsesBody(body) {
  const b = body || {};
  const messages = Array.isArray(b.messages) ? b.messages : [];
  const instructions = messages.filter((m) => m?.role === "system" || m?.role === "developer").map((m) => (typeof m.content === "string" ? m.content : toResponsesContent(m.content, "user").map((p) => p.text || "").join("\n"))).filter(Boolean).join("\n\n");
  const input = messages.filter((m) => m && m.role !== "system" && m.role !== "developer").map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: toResponsesContent(m.content, m.role) }));
  const out = { model: b.model, input };
  if (instructions) out.instructions = instructions;
  const limit = Number(b.max_completion_tokens ?? b.max_tokens);
  if (Number.isFinite(limit) && limit > 0) out.max_output_tokens = Math.floor(limit);
  if (b.temperature !== undefined) out.temperature = b.temperature;
  if (b.stream) out.stream = true;
  if (Array.isArray(b.tools)) {
    out.tools = b.tools.map((tool) => { const fn = tool?.function || tool || {}; return { type: "function", name: fn.name, description: fn.description || "", parameters: fn.parameters || { type: "object", properties: {} } }; });
  }
  if (b.tool_choice !== undefined) {
    out.tool_choice = b.tool_choice && typeof b.tool_choice === "object" ? { type: "function", name: b.tool_choice.function?.name || b.tool_choice.name } : b.tool_choice;
  }
  return out;
}

/** A Responses result, expressed the way chat-completions callers read it. */
function fromResponsesJson(json) {
  if (!json || typeof json !== "object" || !Array.isArray(json.output)) return json;
  const output = json.output;
  const text = output.filter((item) => item?.type === "message").flatMap((item) => Array.isArray(item.content) ? item.content : []).map((c) => (c?.type === "output_text" && typeof c.text === "string" ? c.text : "")).join("");
  const toolCalls = output.filter((item) => item?.type === "function_call").map((item) => ({ id: item.call_id || item.id, type: "function", function: { name: item.name, arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {}) } }));
  const reasoning = output.filter((item) => item?.type === "reasoning").flatMap((item) => item.summary || []).map((s) => s?.text || "").join("\n");
  const cutOff = json.status === "incomplete" && json.incomplete_details?.reason === "max_output_tokens";
  const usage = json.usage || {};
  return {
    id: json.id, object: "chat.completion", model: json.model,
    choices: [{ index: 0, message: { role: "assistant", content: text || (toolCalls.length ? null : ""), ...(toolCalls.length ? { tool_calls: toolCalls } : {}), ...(reasoning ? { reasoning } : {}) },
      finish_reason: cutOff ? "length" : toolCalls.length ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: usage.input_tokens, completion_tokens: usage.output_tokens, total_tokens: usage.total_tokens, completion_tokens_details: usage.output_tokens_details },
    _responses: json,
  };
}

// What an endpoint+model taught us, for the life of this process. Persistence
// across restarts is the caller's (the preset's) business.
const learned = new Map();
const shapeKey = (baseUrl, model) => `${String(baseUrl || "").replace(/\/+$/, "").toLowerCase()}|${String(model || "")}`;
function recallShape(baseUrl, model, fallback = null) {
  return learned.get(shapeKey(baseUrl, model)) || normalizeRequestShape(fallback);
}
function rememberShape(baseUrl, model, shape) {
  learned.set(shapeKey(baseUrl, model), normalizeRequestShape(shape));
}
function resetLearnedShapesForTests() { learned.clear(); }

/**
 * Send one chat request, adapting the shape on a parameter rejection.
 * `body` carries everything except the output limit and temperature, which are
 * placed by the shape. Resolves — never rejects — with:
 *   { ok:true,  response, json|null, shape, adaptations }   (json parsed unless stream)
 *   { ok:false, status, error:{code,param,message}, shape, adaptations, response }
 *   { ok:false, status:0, error:{code:"NETWORK",message}, shape, adaptations }
 */
async function sendChatCompletion({
  url, headers = {}, body = {}, maxTokens, temperature, shape = null, stream = false,
  fetchFn = globalThis.fetch, signal = undefined, onAdapt = null, maxAdaptations = MAX_ADAPTATIONS,
} = {}) {
  let current = normalizeRequestShape(shape);
  const adaptations = [];
  for (let attempt = 0; ; attempt += 1) {
    const chatPayload = applyRequestShape({ ...body, ...(stream ? { stream: true } : {}) }, current, { maxTokens, temperature });
    const viaResponses = current.api === "responses";
    const payload = viaResponses ? toResponsesBody(chatPayload) : chatPayload;
    const target = viaResponses ? responsesUrl(url) : url;
    let response;
    try {
      response = await fetchFn(target, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(payload), signal });
    } catch (err) {
      return { ok: false, status: 0, error: { code: "NETWORK", param: "", message: redactSecrets(err?.message || String(err)) }, shape: current, adaptations };
    }
    if (response.ok) {
      let json = null;
      if (!stream) { try { json = await response.json(); } catch { json = null; } if (viaResponses) json = fromResponsesJson(json); }
      return { ok: true, response, json, shape: current, adaptations, sentBody: payload, api: current.api };
    }
    const text = await response.text().catch(() => "");
    let json = null; try { json = JSON.parse(text); } catch { json = null; }
    const error = parseOpenAiError(response.status, json, text);
    const adaptation = adaptations.length < maxAdaptations
      ? classifyShapeRejection({ status: response.status, error, shape: current, sentBody: payload })
      : null;
    if (!adaptation) return { ok: false, status: response.status, error, shape: current, adaptations, response, json };
    adaptations.push(adaptation.reason);
    current = normalizeRequestShape(adaptation.shape);
    try { onAdapt?.(current, adaptation.reason); } catch { /* observers never break the send */ }
    // (A surface switch is re-sent by the same loop: the next iteration goes to /responses.)
  }
}

module.exports = {
  DEFAULT_SHAPE,
  OUTPUT_LIMIT_FIELDS,
  normalizeRequestShape,
  isDefaultShape,
  compactRequestShape,
  shapeFromEnv,
  parseOpenAiError,
  classifyShapeRejection,
  applyRequestShape,
  sendChatCompletion,
  toResponsesBody,
  fromResponsesJson,
  responsesUrl,
  recallShape,
  rememberShape,
  resetLearnedShapesForTests,
  redactSecrets,
};
