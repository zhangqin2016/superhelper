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
function normalizePresetCapabilities(value, previous = null) {
  const src = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  const prev = previous && typeof previous === "object" ? previous : {};
  const vision = src && "vision" in src ? Boolean(src.vision) : Boolean(prev.vision);
  const rawMimes = src && "filePartMimes" in src ? src.filePartMimes : prev.filePartMimes;
  const filePartMimes = Array.isArray(rawMimes)
    ? [...new Set(rawMimes.map((m) => String(m || "").trim().toLowerCase()).filter(Boolean))].slice(0, 12)
    : [];
  const out = {};
  if (vision) out.vision = true;
  if (filePartMimes.length) out.filePartMimes = filePartMimes;
  return Object.keys(out).length ? out : null;
}

// Spread helper for the persisted entry: returns { capabilities } only when
// something is set, so callers stay one line and normalize just once.
function capabilitiesEntry(value, previous = null) {
  const caps = normalizePresetCapabilities(value, previous);
  return caps ? { capabilities: caps } : {};
}

module.exports = { normalizePresetCapabilities, capabilitiesEntry };
