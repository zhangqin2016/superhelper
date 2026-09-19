"use strict";

/**
 * The one reader for an OpenAI-style chat-completion reply.
 *
 * Every caller that sends a chat completion wants one of a handful of things
 * back — the assistant text, its reasoning, its tool calls, the finish reason,
 * or simply "was this a completion at all". Six modules each read
 * `choices[0].message…` by hand, in six slightly different ways: one dropped
 * content-part arrays, one returned the whole reply object and let a
 * readability check judge `{id, choices, usage}` as empty (the 2026-09-08
 * vision-bridge regression), and one probe treated any HTTP 200 as success —
 * a gateway that answers 200 with an HTML error page passed it.
 *
 * Reading happens here, so a reply is judged the same way everywhere and a
 * shape the transport learns to normalise (Responses API → choices) is
 * understood by every caller at once.
 */

/** Text out of a content field: a string, or content parts (`{type:"text",text}`), or nested. */
function normalizeContent(content) {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part.trim();
        if (!part || typeof part !== "object") return "";
        if (typeof part.text === "string") return part.text.trim();
        if (part.content !== undefined) return normalizeContent(part.content);
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (content && typeof content === "object") {
    if (content.text !== undefined) return normalizeContent(content.text);
    if (content.content !== undefined) return normalizeContent(content.content);
  }
  return "";
}

function firstChoice(json) {
  const choice = json?.choices?.[0];
  return choice && typeof choice === "object" ? choice : null;
}

/**
 * Is this a chat completion at all? An HTML error page parses to null, an
 * error envelope has no choices — neither is "the model answered", whatever
 * the HTTP status said. Content may still be empty (a refusal, a tool call).
 */
function isChatCompletion(json) {
  const choice = firstChoice(json);
  if (!choice) return false;
  return (choice.message !== undefined && choice.message !== null && typeof choice.message === "object")
    || typeof choice.text === "string";
}

/** The assistant text, "" when there is none. */
function replyText(json) {
  const choice = firstChoice(json);
  if (!choice) return "";
  return normalizeContent(choice.message?.content ?? choice.text);
}

/** The reasoning chain, under either name providers use, "" when absent. */
function replyReasoning(json) {
  const message = firstChoice(json)?.message;
  if (!message || typeof message !== "object") return "";
  for (const value of [message.reasoning, message.reasoning_content]) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

function replyToolCalls(json) {
  const calls = firstChoice(json)?.message?.tool_calls;
  return Array.isArray(calls) ? calls : [];
}

function finishReason(json) {
  const reason = firstChoice(json)?.finish_reason;
  return typeof reason === "string" ? reason : "";
}

/** One SSE chunk of a streamed completion, read the same way. */
function streamDelta(chunk) {
  const choice = firstChoice(chunk);
  const delta = choice?.delta && typeof choice.delta === "object" ? choice.delta : {};
  const reasoning = [delta.reasoning, delta.reasoning_content].find((v) => typeof v === "string" && v.trim()) || "";
  return {
    content: typeof delta.content === "string" ? delta.content : "",
    reasoning,
    toolCalls: Array.isArray(delta.tool_calls) ? delta.tool_calls : [],
    finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : "",
  };
}

module.exports = {
  finishReason,
  isChatCompletion,
  normalizeContent,
  replyReasoning,
  replyText,
  replyToolCalls,
  streamDelta,
};
