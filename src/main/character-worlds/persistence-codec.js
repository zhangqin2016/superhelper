"use strict";

const crypto = require("node:crypto");
const zlib = require("node:zlib");
const C = require("./constants");

function codedError(code, message, details = {}) {
  return Object.assign(new Error(message), { code }, details);
}

function requiredString(value, name) {
  const text = String(value || "");
  if (!text) throw new TypeError(`${name} is required`);
  return text;
}

function stableJson(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("JSON values must be finite");
    return JSON.stringify(value);
  }
  if (!value || typeof value !== "object") {
    throw new TypeError("Value must be JSON-serializable");
  }
  if (seen.has(value)) throw new TypeError("JSON values must not be cyclic");
  seen.add(value);
  let json;
  if (Array.isArray(value)) {
    json = `[${value.map((item) => stableJson(item, seen)).join(",")}]`;
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("JSON objects must be plain objects");
    }
    json = `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key], seen)}`
    )).join(",")}}`;
  }
  seen.delete(value);
  return json;
}

function packJson(value, maxBytes, label) {
  const json = stableJson(value);
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > maxBytes) {
    throw codedError("CHARACTER_DATA_TOO_LARGE", `${label} exceeds ${maxBytes} bytes`, {
      limit: maxBytes,
      actual: bytes,
    });
  }
  return { json, packed: zlib.gzipSync(Buffer.from(json, "utf8")) };
}

function unpackJson(value) {
  return JSON.parse(zlib.gunzipSync(Buffer.from(value)).toString("utf8"));
}

function isoTime(value) {
  return value == null ? null : new Date(Number(value)).toISOString();
}

function displayNameOf(canonical) {
  const name = requiredString(
    canonical?.displayName || canonical?.name || canonical?.profile?.name,
    "canonical display name",
  );
  const bytes = Buffer.byteLength(name, "utf8");
  if (bytes > C.MAX_CHARACTER_TEXT_FIELD_BYTES) {
    throw codedError("CHARACTER_DATA_TOO_LARGE", "display name is too large", {
      limit: C.MAX_CHARACTER_TEXT_FIELD_BYTES,
      actual: bytes,
    });
  }
  return name;
}

function normalizeSource(source, kind = "edited") {
  const value = source && typeof source === "object"
    ? source
    : { kind, format: "lily", container: "json" };
  return {
    ...value,
    kind: requiredString(value.kind || kind, "source.kind"),
    format: requiredString(value.format || "lily", "source.format"),
    container: requiredString(value.container || "json", "source.container"),
  };
}

function prepareRevision(canonical, source, kind, assets) {
  const canonicalData = packJson(canonical, C.MAX_CHARACTER_CANONICAL_BYTES, "canonical");
  const sourceValue = normalizeSource(source, kind);
  const sourceData = packJson(sourceValue, C.MAX_CHARACTER_SOURCE_BYTES, "source");
  const descriptors = assets.map(({ data, ...descriptor }) => descriptor);
  return {
    displayName: displayNameOf(canonical),
    canonicalData,
    sourceValue,
    sourceData,
    canonicalHash: `sha256:${crypto.createHash("sha256").update(canonicalData.json).digest("hex")}`,
    revisionHash: `sha256:${crypto.createHash("sha256").update(stableJson({
      canonical: JSON.parse(canonicalData.json),
      source: JSON.parse(sourceData.json),
      assets: descriptors,
    })).digest("hex")}`,
  };
}

module.exports = {
  codedError,
  isoTime,
  prepareRevision,
  requiredString,
  stableJson,
  unpackJson,
};
