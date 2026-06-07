import crypto from "node:crypto";
import { stableStringify } from "../security.js";
import { parseJsonEnv, textFromContent } from "./utils.js";

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

function toOpenAiBody(body, provider) {
  const tools = toOpenAiTools(body.tools);
  return {
    model: provider.model || body.model,
    messages: toOpenAiMessages(body),
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    stop: body.stop_sequences,
    stream: Boolean(body.stream),
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
  const target = `${provider.baseUrl}/chat/completions`;
  return fetch(target, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${provider.apiKey}`,
      ...provider.headers,
    },
    body: JSON.stringify(toOpenAiBody(body, provider)),
  });
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

export async function pipeOpenAiStreamAsAnthropic(upstream, reply, body) {
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

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let stopReason = "end_turn";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let chunk;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      const choice = chunk.choices?.[0] || {};
      const text = choice.delta?.content || "";
      if (choice.finish_reason) stopReason = choice.finish_reason === "tool_calls" ? "tool_use" : choice.finish_reason;
      if (text) {
        writeSse(reply, "content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text },
        });
      }
    }
  }
  writeSse(reply, "content_block_stop", { type: "content_block_stop", index: 0 });
  writeSse(reply, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 0 },
  });
  writeSse(reply, "message_stop", { type: "message_stop" });
  reply.raw.end();
}

export async function sendJsonFromOpenAi(upstream, reply, body) {
  const text = await upstream.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return reply.code(upstream.status).send({ error: { type: "upstream_error", message: text } });
  }
  if (!upstream.ok) return reply.code(upstream.status).send(data);
  return reply.code(upstream.status).send(anthropicMessageFromOpenAi(data, body));
}
