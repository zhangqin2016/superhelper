"use strict";

/**
 * Tool-conformance probe over the OpenAI Responses API (/responses). Used only
 * after the endpoint itself said its chat/completions surface will not run
 * function tools for this model ("use /v1/responses"). Same questions as the
 * chat probe — does a forced call come back, does a stream carry it — same
 * budget ladder, same decoy tools, expressed in the Responses tool format.
 */
const requestShape = require("./openai-request-shape");
const { OUTPUT_BUDGET_LADDER } = require("./model-probe-tools");

function trimUrl(value = "") { return String(value || "").replace(/\/+$/, ""); }

/** chat-style tool defs ({type:"function", function:{name,…}}) → Responses style (flat). */
function toResponsesTools(tools = []) {
  return (tools || []).map((tool) => {
    const fn = tool?.function || tool || {};
    return { type: "function", name: fn.name, description: fn.description || "", parameters: fn.parameters || { type: "object", properties: {} } };
  });
}

function responseShape(json) {
  const output = Array.isArray(json?.output) ? json.output : [];
  const calls = output.filter((item) => item?.type === "function_call");
  const text = output.filter((item) => item?.type === "message").flatMap((item) => item.content || []).map((c) => (typeof c?.text === "string" ? c.text : "")).join("");
  const incomplete = json?.status === "incomplete" ? String(json?.incomplete_details?.reason || "incomplete") : "";
  return { hasContent: text.trim().length > 0, hasToolCalls: calls.length > 0, hasReasoning: output.some((item) => item?.type === "reasoning"), finishReason: incomplete === "max_output_tokens" ? "length" : (json?.status || "") };
}

function streamResponseShape(text) {
  let hasToolCalls = false, hasContent = false, finishReason = "";
  for (const line of String(text || "").split(/\r?\n/)) {
    const t = line.trim(); if (!t.startsWith("data:")) continue;
    const data = t.slice(5).trim(); if (!data || data === "[DONE]") continue;
    try {
      const evt = JSON.parse(data);
      if (evt.type === "response.function_call_arguments.delta" || evt.type === "response.function_call_arguments.done") hasToolCalls = true;
      if (evt.type === "response.output_item.done" && evt.item?.type === "function_call") hasToolCalls = true;
      if (evt.type === "response.output_text.delta" && String(evt.delta || "").trim()) hasContent = true;
      if (evt.type === "response.completed") finishReason = evt.response?.status === "incomplete" && evt.response?.incomplete_details?.reason === "max_output_tokens" ? "length" : "stop";
    } catch { /* ignore malformed chunks */ }
  }
  return { hasContent, hasToolCalls, hasReasoning: false, finishReason };
}

async function postResponses({ baseUrl, apiKey, model, tools, toolChoice, maxTokens, stream, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("MODEL_PROBE_TIMEOUT")), Math.max(500, timeoutMs));
  try {
    const body = { model, input: "Call lily_probe_tool with ok=true.", max_output_tokens: maxTokens, tools, tool_choice: toolChoice, ...(stream ? { stream: true } : {}) };
    const response = await fetch(`${trimUrl(baseUrl)}/responses`, { method: "POST", headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) }, body: JSON.stringify(body), signal: controller.signal });
    const text = await response.text();
    let json = null; try { json = JSON.parse(text); } catch { json = null; }
    if (!response.ok) return { ok: false, status: response.status, json, detail: requestShape.parseOpenAiError(response.status, json, text) };
    return { ok: true, status: response.status, json, shape: stream ? streamResponseShape(text) : responseShape(json) };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  } finally { clearTimeout(timer); }
}

function exhausted(shape) { return Boolean(shape && !shape.hasContent && !shape.hasToolCalls && shape.finishReason === "length"); }

async function probeToolsViaResponses({ baseUrl, apiKey, model, timeoutMs, extraTools = [] }) {
  const tools = toResponsesTools([{ type: "function", function: { name: "lily_probe_tool", description: "Return a probe result.", parameters: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } } }, ...extraTools]);
  let toolChoice = { type: "function", name: "lily_probe_tool" };
  let maxTokens = OUTPUT_BUDGET_LADDER[0];
  let nonStream = await postResponses({ baseUrl, apiKey, model, tools, toolChoice, maxTokens, timeoutMs });
  if (!nonStream.ok && nonStream.status && nonStream.status < 500 && /tool[_\s-]?choice/i.test(nonStream.detail?.message || "")) {
    toolChoice = "auto";
    nonStream = await postResponses({ baseUrl, apiKey, model, tools, toolChoice, maxTokens, timeoutMs });
  }
  for (const next of OUTPUT_BUDGET_LADDER.slice(1)) {
    if (!(nonStream.ok && exhausted(nonStream.shape))) break;
    const retry = await postResponses({ baseUrl, apiKey, model, tools, toolChoice, maxTokens: next, timeoutMs });
    if (!retry.ok) break;
    nonStream = retry; maxTokens = next;
  }
  if (!nonStream.ok) return { ok: false, api: "responses", error: nonStream.error || `HTTP_${nonStream.status || 0}`, detail: nonStream.detail || null };
  const stream = await postResponses({ baseUrl, apiKey, model, tools, toolChoice, maxTokens, stream: true, timeoutMs });
  if (!stream.ok) return { ok: false, api: "responses", error: stream.error || `HTTP_${stream.status || 0}`, detail: stream.detail || null };
  return {
    ok: true,
    api: "responses",
    toolChoice: toolChoice === "auto" ? "auto" : "forced",
    maxTokens,
    nonStreamShape: nonStream.shape,
    streamShape: stream.shape,
    hasToolCalls: Boolean(nonStream.shape?.hasToolCalls && stream.shape?.hasToolCalls),
  };
}

/** The chat tools probe was refused with "use /v1/responses" (or the shape
 *  learner already switched the api for this endpoint+model). */
function wantsResponsesApi(result, baseUrl, model) {
  if (requestShape.recallShape(baseUrl, model).api === "responses") return true;
  const text = String(result?.detail?.message || "");
  return Boolean(result && !result.ok && Number(result.status) >= 400 && Number(result.status) < 500 && /\/v1\/responses\b|responses api/i.test(text));
}

module.exports = { probeToolsViaResponses, wantsResponsesApi, toResponsesTools, responseShape, streamResponseShape };
