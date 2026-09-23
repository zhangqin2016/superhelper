"use strict";

/**
 * How large is this model's context, really?
 *
 * Lily had exactly one answer to that question — an environment variable the
 * server sends only when an operator has typed the number into provider
 * metadata by hand. Measured across 595 real compaction decisions on one
 * install: 22 knew the model's actual window and 573 fell back to a hardcoded
 * 120,000.
 *
 * That default is not harmless. Compaction triggers at a fraction of the
 * window, so assuming 120,000 for a model that really holds 32,000 sets the
 * trigger far beyond what the model can accept: pressure never registers, the
 * conversation never compacts, and the turn fails on a context overflow that
 * the budget said was impossible. The error is silent and points the wrong way.
 *
 * Meanwhile the number is usually sitting right there. Endpoints advertise it
 * in their own model listing — the relay this install talks to returns
 * `context_window: 272000` — and Lily was discarding it, keeping only the id.
 *
 * So: read it from whatever the endpoint said, under whichever of the half
 * dozen names it used, and remember it per endpoint+model. Operator
 * configuration still wins; this only replaces the hardcoded guess, and only
 * when something real was observed.
 */

// Every spelling seen in the wild, matching what the server already accepts so
// the two ends cannot disagree about which field means the context window.
const WINDOW_FIELDS = Object.freeze([
  "contextWindowTokens",
  "context_window_tokens",
  "context_window",
  "contextWindow",
  "context_length",
  "contextLength",
  "maxContextTokens",
  "max_context_tokens",
  "maxModelLen",
  "max_model_len",
  "maxInputTokens",
  "max_input_tokens",
]);

// Below this a "window" is a unit mix-up (kilobytes, a tier index) rather than
// a token count; above it, a parsing accident. Neither should reach a budget.
const MIN_PLAUSIBLE_TOKENS = 1_024;
const MAX_PLAUSIBLE_TOKENS = 20_000_000;

function plausible(value) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number >= MIN_PLAUSIBLE_TOKENS && number <= MAX_PLAUSIBLE_TOKENS
    ? number
    : 0;
}

/**
 * The context window a model record advertises, or 0 when it advertises none.
 * Nested `limits`/`meta` objects are searched too, since several gateways put
 * it there rather than at the top level.
 */
function readContextWindow(record) {
  if (!record || typeof record !== "object") return 0;
  for (const field of WINDOW_FIELDS) {
    const found = plausible(record[field]);
    if (found) return found;
  }
  for (const nested of ["limits", "meta", "metadata", "capabilities"]) {
    const child = record[nested];
    if (child && typeof child === "object") {
      for (const field of [...WINDOW_FIELDS, "contextTokens", "context_tokens"]) {
        const found = plausible(child[field]);
        if (found) return found;
      }
    }
  }
  return 0;
}

/** Windows keyed by endpoint+model, from whatever listing last reported them. */
const observed = new Map();

function key(baseUrl, modelId) {
  return `${String(baseUrl || "").replace(/\/+$/, "")}::${String(modelId || "")}`;
}

/** Record what an endpoint said about one of its models. A zero is ignored, so
 *  a listing that omits the field never erases a window learned earlier. */
function rememberContextWindow(baseUrl, modelId, tokens) {
  const value = plausible(tokens);
  if (!value || !modelId) return 0;
  observed.set(key(baseUrl, modelId), value);
  return value;
}

/** What this endpoint said, or 0 if it has never said anything. */
function recallContextWindow(baseUrl, modelId) {
  return observed.get(key(baseUrl, modelId)) || 0;
}

function resetObservedContextWindowsForTests() {
  observed.clear();
}

module.exports = {
  MAX_PLAUSIBLE_TOKENS,
  MIN_PLAUSIBLE_TOKENS,
  WINDOW_FIELDS,
  readContextWindow,
  recallContextWindow,
  rememberContextWindow,
  resetObservedContextWindowsForTests,
};
