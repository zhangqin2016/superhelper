import * as requestShape from "./request-shape.js";
import crypto from "node:crypto";
import { stableStringify } from "../security.js";
import { discoveredModelMetadataSync } from "./model-discovery.js";
import { normalizeModelForProtocol } from "./model-aliases.js";
import { parseJsonEnv, textFromContent } from "./utils.js";
import { resolveModelRuntimeBudget } from "../model-runtime-budget.js";

function openAiContentFromAnthropic(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return textFromContent(content);
  const parts = [];
  for (const part of content) {
    if (part?.type === "text") {
      parts.push({ type: "text", text: part.text || "" });
    } else if (part?.type === "image" && part.source?.type === "base64") {
      parts.push({
        type: "image_url",
        image_url: {
          url: `data:${part.source.media_type || "image/png"};base64,${part.source.data || ""}`,
        },
      });
    }
  }
  return parts.length ? parts : textFromContent(content);
}

function toOpenAiMessages(body) {
  const messages = [];
  const systemText = textFromContent(body.system);
  if (systemText) messages.push({ role: "system", content: systemText });

  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    const role = message.role === "assistant" ? "assistant" : "user";
    const toolResults = Array.isArray(message.content)
      ? message.content.filter((part) => part?.type === "tool_result")
      : [];
    if (toolResults.length) {
      for (const result of toolResults) {
        messages.push({
          role: "tool",
          tool_call_id: String(result.tool_use_id || result.id || "tool_result"),
          content: textFromContent(result.content),
        });
      }
      continue;
    }
    const toolUses = Array.isArray(message.content)
      ? message.content.filter((part) => part?.type === "tool_use")
      : [];
    if (toolUses.length) {
      messages.push({
        role: "assistant",
        content: textFromContent(message.content),
        tool_calls: toolUses.map((part) => ({
          id: String(part.id || part.name || "tool_call"),
          type: "function",
          function: {
            name: String(part.name || "tool"),
            arguments: JSON.stringify(part.input || {}),
          },
        })),
      });
      continue;
    }
    messages.push({ role, content: openAiContentFromAnthropic(message.content) });
  }
  return messages;
}

function toOpenAiTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  return tools
    .filter((tool) => tool?.name)
    .map((tool) => ({
      type: "function",
      function: {
        name: String(tool.name),
        description: String(tool.description || ""),
        parameters: tool.input_schema || { type: "object", properties: {} },
      },
    }));
}

function positiveInt(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.floor(number);
}

function modelMetadata(provider, model) {
  const metadata = provider?.metadata || {};
  const modelId = String(model || provider?.model || "").trim();
  const discovered = discoveredModelMetadataSync(provider, modelId);
  const models = metadata.models && typeof metadata.models === "object" && !Array.isArray(metadata.models)
    ? metadata.models
    : {};
  const modelSpecific = modelId && models[modelId] && typeof models[modelId] === "object" && !Array.isArray(models[modelId])
    ? models[modelId]
    : {};
  return { metadata, discovered, modelSpecific };
}

function providerMaxOutputTokens(provider, model) {
  const { discovered } = modelMetadata(provider, model);
  return positiveInt(resolveModelRuntimeBudget(provider, model, discovered).maxOutputTokens);
}

function providerContextWindowTokens(provider, model) {
  const { metadata, discovered, modelSpecific } = modelMetadata(provider, model);
  return positiveInt(
    modelSpecific.contextWindowTokens ??
      modelSpecific.context_window_tokens ??
      modelSpecific.maxContextTokens ??
      modelSpecific.max_context_tokens ??
      modelSpecific.maxModelLen ??
      modelSpecific.max_model_len ??
      discovered.contextWindowTokens ??
      discovered.context_window_tokens ??
      discovered.maxModelLen ??
      discovered.max_model_len ??
      metadata.contextWindowTokens ??
      metadata.context_window_tokens ??
      metadata.maxContextTokens ??
      metadata.max_context_tokens ??
      metadata.maxModelLen ??
      metadata.max_model_len,
  );
}

function resolveMaxTokens(body, provider) {
  const requested = positiveInt(body.max_tokens);
  const model = normalizeModelForProtocol(provider, body.model || provider.model);
  const outputCap = providerMaxOutputTokens(provider, model);
  const contextWindow = providerContextWindowTokens(provider, model);
  if (!requested) return body.max_tokens;
  let cap = outputCap || requested;
  if (contextWindow) {
    const remaining = Math.max(1, contextWindow - approximateAnthropicInputTokens(body));
    cap = Math.min(cap, remaining);
  }
  return Math.min(requested, cap);
}

function toOpenAiBody(body, provider) {
  const tools = toOpenAiTools(body.tools);
  const model = normalizeModelForProtocol(provider, body.model || provider.model);
  return {
    ...(model ? { model } : {}),
    messages: toOpenAiMessages(body),
    max_tokens: resolveMaxTokens(body, provider),
    temperature: body.temperature,
    top_p: body.top_p,
    stop: body.stop_sequences,
    stream: Boolean(body.stream),
    // Ask OpenAI-compatible providers to append a final usage chunk to the
    // stream so metered billing can reconcile against real prompt/completion
    // tokens instead of a char-count estimate.
    ...(body.stream ? { stream_options: { include_usage: true } } : {}),
    ...(tools?.length ? { tools } : {}),
  };
}

function anthropicMessageFromOpenAi(data, body) {
  const choice = data?.choices?.[0] || {};
  const message = choice.message || {};
  const content = [];
  if (message.content) content.push({ type: "text", text: String(message.content) });
  for (const call of message.tool_calls || []) {
    content.push({
      type: "tool_use",
      id: String(call.id || call.function?.name || "tool_call"),
      name: String(call.function?.name || "tool"),
      input: parseJsonEnv(call.function?.arguments || "{}", {}),
    });
  }
  return {
    id: data.id || `msg_${crypto.randomUUID().replace(/-/g, "")}`,
    type: "message",
    role: "assistant",
    model: body.model || data.model || "",
    content,
    stop_reason: choice.finish_reason === "tool_calls" ? "tool_use" : choice.finish_reason || "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: Number(data?.usage?.prompt_tokens || 0),
      output_tokens: Number(data?.usage?.completion_tokens || 0),
    },
  };
}

export async function forwardOpenAi(provider, body) {
  return forwardOpenAiChatCompletions(provider, toOpenAiBody(body, provider));
}

export async function forwardOpenAiChatCompletions(provider, body) {
  const target = `${provider.baseUrl}/chat/completions`;
  const base = body && typeof body === "object" && !Array.isArray(body) ? { ...body } : {};
  const model = normalizeModelForProtocol(provider, base.model || provider.model);
  if (model) base.model = model;
  base.max_tokens = resolveMaxTokens(base, provider);
  // Streamed passthrough: request the final usage chunk so metered billing can
  // reconcile against real prompt/completion tokens.
  if (base.stream) base.stream_options = { include_usage: true, ...(base.stream_options || {}) };
  const send = (payload) => fetch(target, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${provider.apiKey}`,
      ...provider.headers,
    },
    body: JSON.stringify(payload),
  });
  // The output-limit field (and whether temperature is accepted) is whatever
  // this upstream has taught us, learned from its own 4xx rather than assumed
  // from the model id. One adaptation per distinct rejection, bounded.
  let shape = requestShape.recallShape(provider, model);
  for (let attempt = 0; ; attempt += 1) {
    const payload = requestShape.applyRequestShape(base, shape);
    const upstream = await send(payload);
    if (upstream.ok || upstream.status < 400 || upstream.status >= 500 || attempt >= 2) return upstream;
    const text = await upstream.clone().text().catch(() => "");
    let json = null; try { json = JSON.parse(text); } catch { json = null; }
    const adaptation = requestShape.classifyShapeRejection({ status: upstream.status, error: requestShape.parseOpenAiError(upstream.status, json, text), shape, sentBody: payload });
    if (!adaptation) return upstream;
    shape = adaptation.shape;
    requestShape.rememberShape(provider, model, shape);
  }
}

export async function forwardOpenAiModels(provider) {
  return fetch(`${provider.baseUrl}/models`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
      ...provider.headers,
    },
  });
}

// Proxy an OpenAI-compatible /embeddings request. The client-specified embedding
// model (e.g. text-embedding-v3) passes through unchanged — do NOT substitute the
// provider's chat model, and do not apply chat-only fields (max_tokens/stream).
export async function forwardOpenAiEmbeddings(provider, body) {
  const target = `${provider.baseUrl}/embeddings`;
  const payload = body && typeof body === "object" && !Array.isArray(body) ? { ...body } : {};
  return fetch(target, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${provider.apiKey}`,
      ...provider.headers,
    },
    body: JSON.stringify(payload),
  });
}

export function approximateAnthropicInputTokens(body) {
  const text = [
    textFromContent(body.system),
    ...(Array.isArray(body.messages) ? body.messages.map((message) => textFromContent(message.content)) : []),
    ...(Array.isArray(body.tools)
      ? body.tools.map((tool) => `${tool.name || ""}\n${tool.description || ""}\n${stableStringify(tool.input_schema || {})}`)
      : []),
  ]
    .filter(Boolean)
    .join("\n");
  return Math.max(1, Math.ceil(text.length / 4));
}

function writeSse(reply, event, data) {
  reply.raw.write(`event: ${event}\n`);
  reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
}

export async function pipeOpenAiStreamAsAnthropic(upstream, reply, body, { onUsage } = {}) {
  reply.raw.writeHead(upstream.status, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const messageId = `msg_${crypto.randomUUID().replace(/-/g, "")}`;
  writeSse(reply, "message_start", {
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      model: body.model || "",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  writeSse(reply, "content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });

  const decoder = new TextDecoder();
  let buffer = "";
  let stopReason = "end_turn";
  let sawCompletion = false;
  let eventName = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let sawUsage = false;
  let reader;
  const processLine = (line) => {
    if (!line) { eventName = ""; return; }
    if (line.startsWith("event:")) { eventName = line.slice(6).trim(); return; }
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (eventName === "error") throw new Error("Upstream stream error");
    if (!payload) return;
    if (payload === "[DONE]") { sawCompletion = true; return; }
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      throw new Error("Malformed upstream stream data");
    }
    if (chunk?.error || chunk?.type === "error") throw new Error("Upstream stream error");
    // Final include_usage chunk (choices may be empty) carries real usage.
    if (chunk.usage) {
      inputTokens = Number(chunk.usage.prompt_tokens || 0);
      outputTokens = Number(chunk.usage.completion_tokens || 0);
      sawUsage = true;
    }
    const choice = chunk.choices?.[0] || {};
    const text = choice.delta?.content || "";
    if (text) {
      writeSse(reply, "content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      });
    }
    if (choice.finish_reason != null) {
      if (!["stop", "length", "tool_calls", "function_call", "content_filter"].includes(choice.finish_reason)) {
        throw new Error("Invalid upstream finish reason");
      }
      sawCompletion = true;
      stopReason = ["tool_calls", "function_call"].includes(choice.finish_reason) ? "tool_use"
        : choice.finish_reason === "stop" ? "end_turn"
        : choice.finish_reason === "length" ? "max_tokens" : choice.finish_reason;
    }
  };
  try {
    reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) processLine(line);
      if (done) {
        if (buffer) processLine(buffer);
        break;
      }
    }
    // A clean transport EOF does not establish that generation completed.
    if (!sawCompletion) throw new Error("Upstream stream ended without completion");
  } catch {
    writeSse(reply, "error", {
      type: "error",
      error: { type: "api_error", message: "Upstream stream interrupted before a complete response was received." },
    });
    reply.raw.end();
    if (typeof onUsage === "function") onUsage({ inputTokens, outputTokens, seen: sawUsage });
    return;
  } finally {
    // Error events can arrive before EOF; release the upstream connection too.
    if (reader) {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  writeSse(reply, "content_block_stop", { type: "content_block_stop", index: 0 });
  writeSse(reply, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  });
  writeSse(reply, "message_stop", { type: "message_stop" });
  reply.raw.end();
  if (typeof onUsage === "function") onUsage({ inputTokens, outputTokens, seen: sawUsage });
}

export async function sendJsonFromOpenAi(upstream, reply, body, { onUsage } = {}) {
  const text = await upstream.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return reply.code(upstream.status).send({ error: { type: "upstream_error", message: text } });
  }
  if (!upstream.ok) return reply.code(upstream.status).send(data);
  if (typeof onUsage === "function" && data?.usage) {
    onUsage({
      inputTokens: Number(data.usage.prompt_tokens || 0),
      outputTokens: Number(data.usage.completion_tokens || 0),
      seen: true,
    });
  }
  return reply.code(upstream.status).send(anthropicMessageFromOpenAi(data, body));
}
