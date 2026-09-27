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
const observed = new Map(); // key -> { tokens, source }
let loadedFrom = null;

// Where a learned window came from. A listing or an error naming the limit is
// the endpoint's own statement; a "ceiling" is the largest request this model
// was seen to accept before one failed for size without saying its limit — a
// lower bound, so it rises when a larger request later succeeds.
const LEARNED_SOURCES = new Set(["listing", "overflow", "ceiling"]);

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
      const tokens = plausible(v?.tokens ?? v);
      const source = LEARNED_SOURCES.has(v?.source) ? v.source : "listing";
      if (tokens && !observed.has(k)) observed.set(k, { tokens, source });
    }
  } catch (err) {
    console.warn("[model-context-window] stored windows unreadable, starting empty:", err?.message || err);
  }
}

function persist() {
  const file = storePath();
  if (!file) return;
  try {
    const windows = Object.fromEntries([...observed.entries()].map(([k, entry]) => [k, { ...entry }]));
    require("./json-file").writeJson(file, { schemaVersion: 2, windows }, { newline: true });
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
function rememberContextWindow(baseUrl, modelId, tokens, source = "listing") {
  const value = plausible(tokens);
  if (!value || !modelId) return 0;
  load();
  const k = key(baseUrl, modelId);
  const entry = { tokens: value, source: LEARNED_SOURCES.has(source) ? source : "listing" };
  const prev = observed.get(k);
  if (prev?.tokens !== entry.tokens || prev?.source !== entry.source) {
    observed.set(k, entry);
    persist();
  }
  return value;
}

/** What this endpoint said, or null if it has never said anything — the same
 *  "unspecified" the model config uses for a window nobody configured, so an
 *  unknown window stays unknown rather than becoming a claim of zero. */
function recallContextWindow(baseUrl, modelId) {
  load();
  return observed.get(key(baseUrl, modelId))?.tokens || null;
}

/**
 * A request of `tokens` just succeeded. A ceiling below it was too low — the
 * model holds at least this much — so it rises. A stated window is left alone.
 */
function observeAcceptedRequest(baseUrl, modelId, tokens) {
  const value = plausible(tokens);
  if (!value || !modelId) return 0;
  load();
  const prev = observed.get(key(baseUrl, modelId));
  if (prev?.source !== "ceiling" || value <= prev.tokens) return 0;
  return rememberContextWindow(baseUrl, modelId, value, "ceiling");
}

// The bundled models.dev snapshot names the window of most public models. It
// is a prior, not a measurement: a gateway may deploy the same model with a
// smaller window, and the first overflow then teaches the real one.
let catalogWindows = null;
function catalogIndex() {
  if (catalogWindows) return catalogWindows;
  catalogWindows = new Map();
  try {
    const fs = require("node:fs");
    const path = require("node:path");
    const candidates = [];
    if (typeof process.resourcesPath === "string") candidates.push(path.join(process.resourcesPath, "resources", "model-catalog.json"));
    candidates.push(path.join(__dirname, "..", "..", "resources", "model-catalog.json"));
    const file = candidates.find((p) => fs.existsSync(p));
    const data = file ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
    for (const provider of Array.isArray(data?.providers) ? data.providers : []) {
      for (const model of Array.isArray(provider?.models) ? provider.models : []) {
        const id = catalogKey(model?.id);
        const tokens = plausible(model?.contextLimit);
        // Providers that disagree about one id: the smaller window is the one
        // every deployment of it can hold.
        if (id && tokens) catalogWindows.set(id, Math.min(tokens, catalogWindows.get(id) || tokens));
      }
    }
  } catch (err) {
    console.warn("[model-context-window] bundled model catalog unreadable:", err?.message || err);
  }
  return catalogWindows;
}

// The exact id only. A self-hosted deployment names a model by its path
// ("/private/Qwen3-Next-80B-A3B-Instruct") and sets its own max length, so a
// name that merely resembles a catalogued model is not that model's window.
function catalogKey(modelId) {
  return String(modelId || "").trim().toLowerCase();
}

/** The window the bundled catalog lists for this model id, or 0. */
function catalogContextWindow(modelId) {
  return catalogIndex().get(catalogKey(modelId)) || 0;
}

/**
 * This model's context window and where it came from, in order of authority:
 * configured (operator or the preset's own field, both arriving as
 * LILY_CONTEXT_WINDOW_TOKENS), learned from this endpoint, listed in the
 * bundled catalog. Otherwise unknown — and unknown stays unknown: it is not
 * replaced by a guess, because a guessed window changes what the model is
 * shown (2026-09-27: a 1M model budgeted as 120,000 had the user's question
 * trimmed out of its own message).
 */
function resolveContextWindow({ configured, baseUrl = "", modelId = "" } = {}) {
  const fromConfig = plausible(configured);
  if (fromConfig) return { tokens: fromConfig, source: "configured" };
  load();
  const learned = observed.get(key(baseUrl, modelId));
  if (learned?.tokens) return { tokens: learned.tokens, source: learned.source === "listing" ? "listing" : `learned_${learned.source}` };
  const listed = catalogContextWindow(modelId);
  if (listed) return { tokens: listed, source: "catalog" };
  return { tokens: 0, source: "unknown" };
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
  // The limit-naming phrasings the engine itself recognises as an overflow.
  /longer than the model'?s context length \((\d[\d,]*) tokens\)/i,
  /context length is only (\d[\d,]*) tokens/i,
  /configured context size is (\d[\d,]*) tokens/i,
  /maximum allowed input length of (\d[\d,]*) tokens/i,
  /too large for model with (\d[\d,]*) maximum context length/i,
  /maximum context length(?: of|\s*\()\s*(\d[\d,]*)/i,
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

/** The window the engine will use for a model preset (`env` already in Lily form). */
function presetContextWindow(preset = {}, env = {}) {
  try {
    return resolveContextWindow({
      configured: preset.capabilities?.contextWindowTokens || env.LILY_CONTEXT_WINDOW_TOKENS,
      baseUrl: preset.baseUrl || env.LILY_API_BASE_URL || "",
      modelId: preset.model || env.LILY_MODEL || "",
    });
  } catch (err) {
    console.warn(`[model-context-window] window lookup for preset ${preset?.id || "-"} failed open:`, err?.message || err);
    return { tokens: 0, source: "unknown" };
  }
}

/**
 * A context-overflow failure teaches the model's real window. The limit the
 * error names wins; an error that names none still bounds it from above, and
 * the largest request the model accepted before (`acceptedTokens`) is then the
 * best known window — kept as a ceiling that rises with later successes.
 * Anything that is not an overflow teaches nothing.
 */
function learnFromOverflowFailure({ classified = null, raw = "", baseUrl = "", modelId = "", acceptedTokens = 0 } = {}) {
  if (classified?.code !== "CONTEXT_LIMIT" || !modelId) return 0;
  const stated = contextWindowFromOverflowError(raw);
  const ceiling = stated ? 0 : plausible(acceptedTokens);
  if (!stated && !ceiling) {
    console.warn(`[model-context-window] ${modelId} overflowed without naming its limit and no accepted request size is known; window stays unknown`);
    return 0;
  }
  if (ceiling) {
    load();
    const prev = observed.get(key(baseUrl, modelId));
    // A stated window at or below what was accepted already explains the failure.
    if (prev && prev.source !== "ceiling" && prev.tokens <= ceiling) return prev.tokens;
  }
  const learned = rememberContextWindow(baseUrl, modelId, stated || ceiling, stated ? "overflow" : "ceiling");
  if (learned) console.warn(`[model-context-window] learned ${modelId} window ${learned} (${stated ? "stated by the overflow error" : "largest accepted request"})`);
  return learned;
}

function resetObservedContextWindowsForTests() {
  observed.clear();
  loadedFrom = null;
  catalogWindows = null;
}

module.exports = {
  MAX_PLAUSIBLE_TOKENS,
  MIN_PLAUSIBLE_TOKENS,
  WINDOW_FIELDS,
  catalogContextWindow,
  contextWindowFromOverflowError,
  learnFromOverflowFailure,
  observeAcceptedRequest,
  presetContextWindow,
  readContextWindow,
  recallContextWindow,
  rememberContextWindow,
  resetObservedContextWindowsForTests,
  resolveContextWindow,
};
