"use strict";

// Small HTTP-body helpers shared by the model-compatibility probes. Kept in one
// place so the vision probe and the request-shape probe agree byte-for-byte on
// how a base body is trimmed and how a request-body overlay is merged onto it.

function trimUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function mergeBody(base, overlay) {
  if (!overlay || typeof overlay !== "object" || Array.isArray(overlay)) return { ...base };
  const out = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    // `null` removes a key. Without this an overlay could add a field but never
    // take one away, so a gateway that rejects a default field was unfixable.
    if (value === null) { delete out[key]; continue; }
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      out[key] &&
      typeof out[key] === "object" &&
      !Array.isArray(out[key])
    ) {
      out[key] = mergeBody(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

module.exports = { trimUrl, mergeBody };
