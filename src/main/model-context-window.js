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

/**
 * Windows keyed by endpoint+model, from whatever the endpoint last said — its
 * model listing, or a context-overflow error naming its limit. Kept on disk:
 * held only in memory, a window learned from one listing was gone after the
 * next restart, and every compaction decision on this install fell back to
 * 120,000 (2026-09-27). Without a writable user-data directory (a helper
 * process, a test) it stays in memory, as before.
 */
const observed = new Map();
let loadedFrom = null;

function storePath() {
  try { return require("./config").userDataPath("model-context-windows.json"); } catch { return ""; }
}

function load() {
  const file = storePath();
  if (loadedFrom === file) return;
  loadedFrom = file;
  if (!file) return;
  try {
    const saved = require("./json-file").readJson(file, null);
    for (const [k, v] of Object.entries(saved?.windows || {})) {
      const value = plausible(v?.tokens ?? v);
      if (value && !observed.has(k)) observed.set(k, value);
    }
  } catch (err) {
    console.warn("[model-context-window] stored windows unreadable, starting empty:", err?.message || err);
  }
}

function persist() {
  const file = storePath();
  if (!file) return;
  try {
    const windows = Object.fromEntries([...observed.entries()].map(([k, tokens]) => [k, { tokens }]));
    require("./json-file").writeJson(file, { schemaVersion: 1, windows }, { newline: true });
  } catch (err) {
    console.warn("[model-context-window] could not store learned windows:", err?.message || err);
  }
}

/** One endpoint, one key: "https://h/v1/" and "https://h" name the same service
 *  (a listing and the engine config spell its base URL differently). */
function key(baseUrl, modelId) {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "").replace(/\/(?:v1|chat\/completions|responses)$/i, "").replace(/\/+$/, "").toLowerCase();
  return `${base}::${String(modelId || "")}`;
}

/** Record what an endpoint said about one of its models. A zero is ignored, so
 *  a listing that omits the field never erases a window learned earlier. */
function rememberContextWindow(baseUrl, modelId, tokens) {
  const value = plausible(tokens);
  if (!value || !modelId) return 0;
  load();
  const k = key(baseUrl, modelId);
  if (observed.get(k) !== value) {
    observed.set(k, value);
    persist();
  }
  return value;
}

/** What this endpoint said, or null if it has never said anything — the same
 *  "unspecified" the model config uses for a window nobody configured, so an
 *  unknown window stays unknown rather than becoming a claim of zero. */
function recallContextWindow(baseUrl, modelId) {
  load();
  return observed.get(key(baseUrl, modelId)) || null;
}

// How providers state the limit when a request exceeds it. Only phrases that
// name the model's window — never the request's own size, which the same
// errors also quote ("... but you requested 131072 tokens").
const OVERFLOW_LIMIT_PATTERNS = Object.freeze([
  /maximum context length (?:is|of) (\d[\d,]*) tokens/i,
  /context (?:length|window) (?:is|of) (\d[\d,]*)(?: tokens)?/i,
  /max(?:imum)?_?model_?len(?:gth)?\D{0,20}(\d[\d,]*)/i,
  /maximum (?:input|prompt) length (?:is|of) (\d[\d,]*)/i,
  /exceeds? the (?:model'?s? )?(?:context|token) (?:limit|window) of (\d[\d,]*)/i,
  /(?:上下文|最大)(?:长度|窗口)(?:为|是|限制为)?\s*(\d[\d,]*)/,
]);

/** The window an overflow error states, or 0 when it states none. */
function contextWindowFromOverflowError(text) {
  const value = String(text || "");
  for (const pattern of OVERFLOW_LIMIT_PATTERNS) {
    const match = pattern.exec(value);
    if (match) {
      const tokens = plausible(String(match[1]).replace(/,/g, ""));
      if (tokens) return tokens;
    }
  }
  return 0;
}

/**
 * A context-overflow failure teaches the model's real window: the next budget
 * compacts before the limit instead of at a guessed 120,000. Called for every
 * visible failure; anything that is not an overflow naming a limit is ignored.
 */
function learnFromOverflowFailure({ classified = null, raw = "", baseUrl = "", modelId = "" } = {}) {
  if (classified?.code !== "CONTEXT_LIMIT" || !modelId) return 0;
  const tokens = contextWindowFromOverflowError(raw);
  if (!tokens) return 0;
  const learned = rememberContextWindow(baseUrl, modelId, tokens);
  if (learned) console.warn(`[model-context-window] learned ${modelId} window ${learned} from an overflow error`);
  return learned;
}

function resetObservedContextWindowsForTests() {
  observed.clear();
  loadedFrom = null;
}

module.exports = {
  MAX_PLAUSIBLE_TOKENS,
  MIN_PLAUSIBLE_TOKENS,
  WINDOW_FIELDS,
  contextWindowFromOverflowError,
  learnFromOverflowFailure,
  readContextWindow,
  recallContextWindow,
  rememberContextWindow,
  resetObservedContextWindowsForTests,
};
