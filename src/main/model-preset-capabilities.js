"use strict";

// Normalizes a custom preset's multimodal capabilities (vision, file-part MIME
// allow-list) into the compact shape stored on the preset and surfaced to the
// runtime. Kept separate so model-presets.js stays under its architecture
// ratchet and the capability shape has one authority.
//
// `previous` lets an update carry forward the stored capabilities when the
// caller passes only a partial object (or nothing). Returns null when nothing
// is set, so callers can spread `...(caps ? { capabilities: caps } : {})` and
// never persist an empty object.
function plausibleWindow(value) {
  const { MIN_PLAUSIBLE_TOKENS, MAX_PLAUSIBLE_TOKENS } = require("./model-context-window");
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number >= MIN_PLAUSIBLE_TOKENS && number <= MAX_PLAUSIBLE_TOKENS ? number : 0;
}

function normalizePresetCapabilities(value, previous = null) {
  const src = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  const prev = previous && typeof previous === "object" ? previous : {};
  const vision = src && "vision" in src ? Boolean(src.vision) : Boolean(prev.vision);
  // imageGen: this model can PRODUCE images (e.g. a Codex-relay endpoint that
  // injects the Responses image_generation tool on its chat path). When set,
  // image generation follows THIS model's own connection instead of a separate
  // standard media provider — the relay is not one of our standard services.
  const imageGen = src && "imageGen" in src ? Boolean(src.imageGen) : Boolean(prev.imageGen);
  const rawMimes = src && "filePartMimes" in src ? src.filePartMimes : prev.filePartMimes;
  const filePartMimes = Array.isArray(rawMimes)
    ? [...new Set(rawMimes.map((m) => String(m || "").trim().toLowerCase()).filter(Boolean))].slice(0, 12)
    : [];
  // The model's context window in tokens, as the user (or the endpoint, or an
  // overflow error — model-context-window) told us. Custom presets had no place
  // for it, so every custom model was budgeted as 120,000: a 1M model compacted
  // at 8% of its window, a 32K one overflowed before compaction (2026-09-27).
  // An explicit empty/0 clears it; absent keeps the stored value.
  const rawWindow = src && "contextWindowTokens" in src ? src.contextWindowTokens : prev.contextWindowTokens;
  const contextWindowTokens = plausibleWindow(rawWindow);
  const out = {};
  if (vision) out.vision = true;
  if (imageGen) out.imageGen = true;
  if (filePartMimes.length) out.filePartMimes = filePartMimes;
  if (contextWindowTokens) out.contextWindowTokens = contextWindowTokens;
  return Object.keys(out).length ? out : null;
}

// Spread helper for the persisted entry: returns { capabilities } only when
// something is set, so callers stay one line and normalize just once.
function capabilitiesEntry(value, previous = null) {
  const caps = normalizePresetCapabilities(value, previous);
  return caps ? { capabilities: caps } : {};
}

module.exports = { normalizePresetCapabilities, capabilitiesEntry };
