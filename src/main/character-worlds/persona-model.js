"use strict";

/**
 * Bounded normalization of the §7.3 persona revision shape.
 *
 * A persona is narrative context only — a name plus a description. It has no
 * account or authorization fields and can never become an authenticated user
 * (§7.3, §19.2). DECISION (reject-vs-strip): known authorization-shaped keys
 * at the TOP LEVEL of the canonical (accountId, role, permissions, token, …,
 * matched case-insensitively) are REJECTED with PERSONA_DATA_INVALID rather
 * than silently stripped — a caller that tries to attach authority to a
 * persona must fail loud, not succeed with a quieter persona than it asked
 * for. Nested same-named keys inside preserved unknown fields are inert
 * narrative data and are preserved verbatim; only the top level is policed.
 *
 * Otherwise the discipline mirrors the world-book model exactly: known fields
 * are validated and defaulted, unknown top-level fields are preserved inert,
 * and everything passes a bounded trap-free plain-data walk that rejects
 * Proxies, accessors, non-plain objects, dangerous keys, cycles, non-finite
 * numbers, and oversized strings/arrays/counts before any field is read. The
 * revision hash covers canonical data + provenance + linked asset descriptors
 * (the avatar rides the shared CharacterAssetLifecycle with purpose
 * "avatar"), so identical envelopes dedupe and any drift creates a new
 * immutable revision.
 */

const crypto = require("node:crypto");
const util = require("node:util");
const C = require("./constants");
const {
  codedError,
  normalizeSource,
  packJson,
  requiredString,
  stableJson,
} = require("./persistence-codec");

const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);

// Authorization-shaped top-level keys (compared lowercased). A persona can
// never carry these; presence is a caller bug or an authority-smuggling
// attempt and is rejected outright.
const AUTH_SHAPED_KEYS = new Set([
  "account", "accountid", "userid", "role", "roles", "permission",
  "permissions", "token", "tokens", "auth", "authorization", "credential",
  "credentials", "password", "apikey", "secret", "sessionid", "sessiontoken",
]);

const KNOWN_CANONICAL_KEYS = new Set(["schemaVersion", "name", "description"]);

function invalid(message, details = {}) {
  return codedError("PERSONA_DATA_INVALID", message, details);
}

function limit(limitKind, maximum, actual) {
  return codedError(
    "PERSONA_LIMIT_EXCEEDED",
    `Persona ${limitKind} exceeds ${maximum}`,
    {
      limitsVersion: C.MAX_PERSONA_LIMITS_VERSION,
      limitKind,
      limit: maximum,
      actual,
    },
  );
}

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// Bounded plain-data walk. Runs once over the whole input before any field is
// read, so no accessor/Proxy trap is ever invoked during normalization.
function assertPlainData(value, state, depth, path) {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw invalid("Persona data contains a non-finite number", { path });
    }
    return;
  }
  if (typeof value === "string") {
    const chars = [...value].length;
    if (chars > C.MAX_PERSONA_STRING_CHARS) {
      throw limit("stringChars", C.MAX_PERSONA_STRING_CHARS, chars);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    throw invalid("Persona data is not plain JSON data", { path });
  }
  if (util.types.isProxy(value)) {
    throw invalid("Persona data must not contain Proxy objects", { path });
  }
  if (depth > C.MAX_PERSONA_DATA_DEPTH) {
    throw limit("dataDepth", C.MAX_PERSONA_DATA_DEPTH, depth);
  }
  state.nodes += 1;
  if (state.nodes > C.MAX_PERSONA_DATA_NODES) {
    throw limit("dataNodes", C.MAX_PERSONA_DATA_NODES, state.nodes);
  }
  if (state.ancestors.has(value)) {
    throw invalid("Persona data must not contain cycles", { path });
  }
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > C.MAX_PERSONA_DATA_ARRAY_LENGTH) {
        throw limit("dataArrayLength", C.MAX_PERSONA_DATA_ARRAY_LENGTH, value.length);
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
          throw invalid("Persona arrays must contain plain values", { path: `${path}/${index}` });
        }
        assertPlainData(descriptor.value, state, depth + 1, `${path}/${index}`);
      }
      return;
    }
    if (!plainObject(value)) {
      throw invalid("Persona data must contain only plain objects", { path });
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        throw invalid("Persona data contains a symbol key", { path });
      }
      if (DANGEROUS_KEYS.has(key)) {
        throw invalid("Persona data contains a dangerous key", { path: `${path}/${key}` });
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
        throw invalid("Persona properties must be enumerable data values", {
          path: `${path}/${key}`,
        });
      }
      assertPlainData(descriptor.value, state, depth + 1, `${path}/${key}`);
    }
  } finally {
    state.ancestors.delete(value);
  }
}

function boundedString(value, limitKind, maximum) {
  const chars = [...value].length;
  if (chars > maximum) throw limit(limitKind, maximum, chars);
  return value;
}

function preservedUnknown(input, knownKeys) {
  const preserved = {};
  for (const key of Object.keys(input)) {
    if (!knownKeys.has(key)) preserved[key] = input[key];
  }
  return preserved;
}

function normalizePersonaCanonical(input) {
  assertPlainData(input, { nodes: 0, ancestors: new Set() }, 1, "");
  if (!plainObject(input)) {
    throw invalid("Persona canonical data must be a plain object", { path: "" });
  }
  // Fail loud on authority claims (§7.3/§19.2): the walk above already ran,
  // so Object.keys is trap-free here.
  for (const key of Object.keys(input)) {
    if (AUTH_SHAPED_KEYS.has(key.toLowerCase())) {
      throw invalid(
        "Persona data must not contain authorization-shaped fields: a persona is narrative context only",
        { key },
      );
    }
  }
  const name = requiredString(input.name, "persona name");
  boundedString(name, "nameChars", C.MAX_PERSONA_NAME_CHARS);
  const description = typeof input.description === "string" ? input.description : "";
  boundedString(description, "descriptionChars", C.MAX_PERSONA_DESCRIPTION_CHARS);
  return {
    schemaVersion: C.PERSONA_SCHEMA_VERSION,
    name,
    description,
    ...preservedUnknown(input, KNOWN_CANONICAL_KEYS),
  };
}

// Mirrors the world-book codec: the revision hash covers the normalized
// canonical data, the provenance envelope, and the linked asset descriptors
// (avatar included), so identical envelopes dedupe and any drift creates a
// new immutable revision.
function preparePersonaRevision(canonical, source, kind, assets) {
  const canonicalData = packJson(
    canonical, C.MAX_PERSONA_CANONICAL_BYTES, "persona canonical",
    "PERSONA_DATA_TOO_LARGE",
  );
  // Walk the RAW source before normalizeSource: its spread reads properties
  // directly, which would fire accessors/Proxy traps. Plain-data first means
  // no trap ever runs.
  if (source && typeof source === "object") {
    assertPlainData(source, { nodes: 0, ancestors: new Set() }, 1, "");
  }
  const sourceValue = normalizeSource(source, kind);
  const sourceData = packJson(
    sourceValue, C.MAX_PERSONA_SOURCE_BYTES, "persona source",
    "PERSONA_DATA_TOO_LARGE",
  );
  const descriptors = assets.map(({ data, ...descriptor }) => descriptor);
  const sourceOriginal = sourceValue.original;
  let originalHash = null;
  if (
    sourceOriginal
    && typeof sourceOriginal === "object"
    && typeof sourceOriginal.hash === "string"
  ) {
    const linked = descriptors.some((asset) => (
      asset.hash === sourceOriginal.hash
      && asset.purpose === "persona-original"
      && asset.bytes === sourceOriginal.bytes
    ));
    if (linked && /^[a-f0-9]{64}$/.test(sourceOriginal.hash)) {
      originalHash = sourceOriginal.hash;
    }
  }
  return {
    displayName: canonical.name,
    canonicalData,
    sourceValue,
    sourceData,
    originalHash,
    canonicalHash: `sha256:${crypto.createHash("sha256").update(canonicalData.json).digest("hex")}`,
    revisionHash: `sha256:${crypto.createHash("sha256").update(stableJson({
      canonical: JSON.parse(canonicalData.json),
      source: JSON.parse(sourceData.json),
      assets: descriptors,
    })).digest("hex")}`,
  };
}

module.exports = {
  normalizePersonaCanonical,
  preparePersonaRevision,
};
