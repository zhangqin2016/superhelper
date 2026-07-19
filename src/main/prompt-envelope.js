"use strict";

const DEFAULT_LAYER_BYTE_LIMITS = Object.freeze({
  platform_context: 32 * 1024,
  extracted_attachments: 512 * 1024,
  execution_constraints: 64 * 1024,
  user_original_request: Infinity,
});

const TRUNCATION_MARKER = "[lily layer truncated to preserve prompt budget]";

function utf8Bytes(value = "") {
  return Buffer.byteLength(String(value || ""), "utf8");
}

function utf8Prefix(value, maxBytes) {
  let out = "";
  let used = 0;
  for (const char of String(value || "")) {
    const size = utf8Bytes(char);
    if (used + size > maxBytes) break;
    out += char;
    used += size;
  }
  return out;
}

function utf8Suffix(value, maxBytes) {
  const chars = [...String(value || "")];
  let out = "";
  let used = 0;
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    const size = utf8Bytes(chars[index]);
    if (used + size > maxBytes) break;
    out = chars[index] + out;
    used += size;
  }
  return out;
}

function boundPromptLayer(title, value, limits = DEFAULT_LAYER_BYTE_LIMITS) {
  const text = String(value || "");
  const maxBytes = Number(limits?.[title]);
  const originalBytes = utf8Bytes(text);
  if (!Number.isFinite(maxBytes) || maxBytes <= 0 || originalBytes <= maxBytes) {
    return { text, truncated: false, originalBytes, bytes: originalBytes, maxBytes };
  }
  const marker = `\n\n${TRUNCATION_MARKER}\n\n`;
  const available = Math.max(0, maxBytes - utf8Bytes(marker));
  const headBudget = Math.floor(available * 0.7);
  const tailBudget = available - headBudget;
  const bounded = `${utf8Prefix(text, headBudget)}${marker}${utf8Suffix(text, tailBudget)}`;
  return {
    text: bounded,
    truncated: true,
    originalBytes,
    bytes: utf8Bytes(bounded),
    maxBytes,
  };
}

function promptEnvelopeDiagnostics(layers = {}, limits = DEFAULT_LAYER_BYTE_LIMITS) {
  const entries = Object.entries(layers).map(([title, value]) => {
    const bounded = boundPromptLayer(title, value, limits);
    return {
      title,
      bytes: bounded.bytes,
      originalBytes: bounded.originalBytes,
      maxBytes: bounded.maxBytes,
      truncated: bounded.truncated,
    };
  });
  return {
    schemaVersion: 1,
    totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    layers: entries,
  };
}

module.exports = {
  DEFAULT_LAYER_BYTE_LIMITS,
  TRUNCATION_MARKER,
  boundPromptLayer,
  promptEnvelopeDiagnostics,
  utf8Bytes,
};
