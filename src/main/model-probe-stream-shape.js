"use strict";

/**
 * What a probe's streamed chat response showed: content, reasoning, tool
 * calls, finish reason, whether usage came back, and whether any chunk lacked
 * `choices` (a usage-only chunk some vLLM deployments send, which the engine's
 * AI SDK rejects mid-turn). Extracted from model-compatibility-probe.js
 * (architecture ratchet).
 */
function streamShape(text) {
  let hasContent = false;
  let hasReasoning = false;
  let hasToolCalls = false;
  let finishReason = "";
  let hasUsage = false;
  let choiceless = false;
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const json = JSON.parse(data);
      if (typeof json?.type === "string" && json.type.startsWith("response.")) { // Responses-surface event
        const evt = require("./model-probe-responses").streamEventSignals(json);
        hasContent ||= evt.hasContent; hasToolCalls ||= evt.hasToolCalls; hasReasoning ||= evt.hasReasoning; if (evt.finishReason) finishReason = evt.finishReason;
        continue;
      }
      if (json && typeof json === "object" && json.usage && typeof json.usage === "object") hasUsage = true;
      // A chat chunk with no `choices` array (a usage-only chunk some vLLM
      // deployments send) is rejected by the engine's AI SDK mid-turn.
      const reply = require("./chat-completion-reply");
      if (reply.isChoicelessChunk(json)) choiceless = true;
      const delta = reply.streamDelta(json);
      if (delta.content.trim()) hasContent = true;
      if (delta.reasoning.trim()) hasReasoning = true;
      if (delta.toolCalls.length) hasToolCalls = true;
      if (delta.finishReason) finishReason = delta.finishReason;
    } catch {
      // Ignore malformed chunks; the caller handles no-content as failure.
    }
  }
  return { hasContent, hasReasoning, hasToolCalls, finishReason, hasUsage, choiceless };
}

module.exports = { streamShape };
