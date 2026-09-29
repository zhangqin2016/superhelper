"use strict";

/**
 * How a provider says "the input does not fit the context window".
 *
 * ONE list, whose base is the engine's own: OpenCode maintains the providers'
 * overflow wording upstream (opencode/packages/llm/src/provider-error.ts,
 * `isContextOverflow`), and scripts/test-context-overflow-wording.mjs fails
 * when the vendored engine's list changes and this copy does not follow. Lily
 * adds only wording the engine list does not name, each from a provider's real
 * error. A hand-written list replaced the old broad `maximum.*length` /
 * `max.*tokens` (which caught parameter errors and taught a tiny window) but
 * then missed vLLM's "longer than the maximum model length" (2026-09-29
 * re-review); following the engine's list is what keeps the coverage honest.
 */

// Verbatim from the vendored engine (opencode/packages/llm/src/provider-error.ts).
const ENGINE_PATTERNS = [
  /prompt is too long/i,
  /request_too_large/i,
  /input is too long for requested model/i,
  /exceeds the context window/i,
  /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i,
  /input token count.*exceeds the maximum/i,
  /tokens in request more than max tokens allowed/i,
  /maximum prompt length is \d+/i,
  /reduce the length of the messages/i,
  /maximum context length is \d+ tokens/i,
  /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i,
  /input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i,
  /exceeds the limit of \d+/i,
  /exceeds the available context size/i,
  /greater than the context length/i,
  /context window exceeds limit/i,
  /exceeded model token limit/i,
  /context[_ ]length[_ ]exceeded/i,
  /request entity too large/i,
  /context length is only \d+ tokens/i,
  /input length.*exceeds.*context length/i,
  /prompt too long; exceeded (?:max )?context length/i,
  /too large for model with \d+ maximum context length/i,
  /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i,
  /model_context_window_exceeded/i,
  /too many tokens/i,
  /token limit exceeded/i,
];
const ENGINE_EXCLUSIONS = [/^(throttling error|service unavailable):/i, /rate limit/i, /too many requests/i];
const ENGINE_NO_BODY = /^4(00|13)\s*(status code)?\s*\(no body\)/i;

// Wording the engine list does not name. Each is a real provider message:
//  - DashScope (Qwen): "Range of input length should be [1, 129024]"
//  - DashScope / others: "The input length exceeds the maximum length"
//  - vLLM (V0 and V1): "The decoder prompt (length 5951) is longer than the
//    maximum model length of 4096" / "Prompt length of X is longer than ..."
//  - Gemini: "The input token count (N) exceeds the maximum number of tokens"
//  - Lily's earlier list, kept so nothing it recognised is lost: context
//    length/window wording, "token limit", payload-size replies (413).
const LILY_PATTERNS = [
  /range of input length/i,
  /input length exceeds/i,
  /longer than the maximum model length/i,
  /input token count/i,
  /context length|context window|maximum context/i,
  /token limit/i,
  /input too long/i,
  /request too large|payload too large|entity too large|body too large|content length.*exceed|\b413\b/i,
];

function isContextOverflowText(value) {
  const text = String(value || "");
  if (!text || ENGINE_EXCLUSIONS.some((pattern) => pattern.test(text))) return false;
  return ENGINE_PATTERNS.some((pattern) => pattern.test(text))
    || ENGINE_NO_BODY.test(text)
    || LILY_PATTERNS.some((pattern) => pattern.test(text));
}

/** RegExp-shaped, so the error classification table can hold it as `test`. */
const CONTEXT_OVERFLOW_MATCHER = Object.freeze({ test: isContextOverflowText });

module.exports = { CONTEXT_OVERFLOW_MATCHER, ENGINE_EXCLUSIONS, ENGINE_PATTERNS, LILY_PATTERNS, isContextOverflowText };
