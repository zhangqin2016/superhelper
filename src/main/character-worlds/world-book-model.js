"use strict";

/**
 * Bounded normalization of the §7.4 world-book revision shape.
 *
 * The normalized canonical document is pure inert data: known fields are
 * validated and defaulted, unknown fields at every level are preserved
 * verbatim (the activation resolver ignores them), and everything passes a
 * bounded plain-data walk that rejects Proxies, accessors, non-plain objects,
 * dangerous keys, cycles, and oversized strings/arrays/counts. The revision
 * hash mirrors the character codec: canonical data + provenance + assets.
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
const {
  resolveEntryDecorators,
} = require("./world-book-decorators");

const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);

const SELECTIVE_LOGICS = new Set(["and_any", "and_all", "not_any", "not_all"]);
const INSERTION_POSITIONS = new Set([
  "before_character",
  "after_character",
  "before_examples",
  "after_examples",
  "author_note_top",
  "author_note_bottom",
  "at_depth",
  "outlet",
]);
const INSERTION_ROLES = new Set(["system", "user", "assistant"]);
const CHARACTER_FILTER_MODES = new Set(["include", "exclude"]);
const FORCE_STATES = new Set(["none", "activate", "suppress"]);
const STATEFUL_MATCHES = new Set(["none", "keep", "suppress"]);

const KNOWN_CANONICAL_KEYS = new Set([
  "schemaVersion", "name", "displayName", "entries", "scanPolicy",
]);
const KNOWN_ENTRY_KEYS = new Set([
  "id", "enabled", "content", "activation", "insertion", "recursion",
  "decorators", "preservedDecorators", "preservedExtensions",
]);
const KNOWN_ACTIVATION_KEYS = new Set([
  "constant", "primaryKeys", "secondaryKeys", "selective", "selectiveLogic",
  "useRegex", "vectorized", "caseSensitive", "matchWholeWords", "probability",
  "inclusionGroups", "groupWeight", "prioritizeInclusion", "useGroupScoring",
  "characterFilter", "generationTriggers", "matchSources",
  "delayMessages", "stickyMessages", "cooldownMessages",
  "forceState", "activateOnlyAfter", "greetingIndex", "scanDepthMessages",
  "statefulMatch",
]);
const KNOWN_CHARACTER_FILTER_KEYS = new Set([
  "mode", "names", "tags", "characterNames", "characterTags",
]);
const KNOWN_INSERTION_KEYS = new Set([
  "position", "depth", "role", "outletName", "order", "priority",
  "reverseDepth",
]);
const KNOWN_RECURSION_KEYS = new Set([
  "preventFurtherRecursion", "excludeFromRecursion", "delayUntilRecursion",
  "recursionLevel",
]);
const KNOWN_SCAN_POLICY_KEYS = new Set([
  "scanDepthMessages", "includeParticipantNames", "tokenBudget", "recursive",
  "maxRecursionSteps", "minActivations", "maxDepthMessages",
]);

function invalid(message, details = {}) {
  return codedError("WORLD_BOOK_DATA_INVALID", message, details);
}

function limit(limitKind, maximum, actual) {
  return codedError(
    "WORLD_BOOK_LIMIT_EXCEEDED",
    `World book ${limitKind} exceeds ${maximum}`,
    {
      limitsVersion: C.MAX_WORLD_BOOK_LIMITS_VERSION,
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
      throw invalid("World book data contains a non-finite number", { path });
    }
    return;
  }
  if (typeof value === "string") {
    const chars = [...value].length;
    if (chars > C.MAX_WORLD_BOOK_STRING_CHARS) {
      throw limit("stringChars", C.MAX_WORLD_BOOK_STRING_CHARS, chars);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    throw invalid("World book data is not plain JSON data", { path });
  }
  if (util.types.isProxy(value)) {
    throw invalid("World book data must not contain Proxy objects", { path });
  }
  if (depth > C.MAX_WORLD_BOOK_DATA_DEPTH) {
    throw limit("dataDepth", C.MAX_WORLD_BOOK_DATA_DEPTH, depth);
  }
  state.nodes += 1;
  if (state.nodes > C.MAX_WORLD_BOOK_DATA_NODES) {
    throw limit("dataNodes", C.MAX_WORLD_BOOK_DATA_NODES, state.nodes);
  }
  if (state.ancestors.has(value)) {
    throw invalid("World book data must not contain cycles", { path });
  }
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > C.MAX_WORLD_BOOK_DATA_ARRAY_LENGTH) {
        throw limit("dataArrayLength", C.MAX_WORLD_BOOK_DATA_ARRAY_LENGTH, value.length);
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
          throw invalid("World book arrays must contain plain values", { path: `${path}/${index}` });
        }
        assertPlainData(descriptor.value, state, depth + 1, `${path}/${index}`);
      }
      return;
    }
    if (!plainObject(value)) {
      throw invalid("World book data must contain only plain objects", { path });
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        throw invalid("World book data contains a symbol key", { path });
      }
      if (DANGEROUS_KEYS.has(key)) {
        throw invalid("World book data contains a dangerous key", { path: `${path}/${key}` });
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
        throw invalid("World book properties must be enumerable data values", {
          path: `${path}/${key}`,
        });
      }
      assertPlainData(descriptor.value, state, depth + 1, `${path}/${key}`);
    }
  } finally {
    state.ancestors.delete(value);
  }
}

function boolAt(object, key, fallback) {
  const value = object[key];
  return typeof value === "boolean" ? value : fallback;
}

function intAt(object, key, fallback, maximum) {
  const raw = object[key];
  // Explicit null falls back to the field default; Number(null) === 0 would
  // silently turn "absent" into a real zero.
  if (raw == null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(Math.floor(value), maximum));
}

function probabilityAt(object, key, fallback) {
  const raw = object[key];
  if (raw == null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(value, 100));
}

// Like intAt but "absent" stays null (no directive) instead of a numeric
// default; Number(null) === 0 would silently turn "absent" into a real zero.
function nullableIntAt(object, key, maximum) {
  const raw = object[key];
  if (raw == null) return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(Math.floor(value), maximum));
}

function enumAt(object, key, allowed, fallback) {
  const value = object[key];
  return typeof value === "string" && allowed.has(value) ? value : fallback;
}

function boundedString(value, limitKind, maximum) {
  const chars = [...value].length;
  if (chars > maximum) throw limit(limitKind, maximum, chars);
  return value;
}

function stringAt(object, key, fallback, maximum, limitKind) {
  const value = object[key];
  if (typeof value !== "string") return fallback;
  return boundedString(value, limitKind, maximum);
}

function stringArrayAt(object, key, maximumItems, limitKind) {
  const value = object[key];
  if (!Array.isArray(value)) return [];
  if (value.length > maximumItems) throw limit(limitKind, maximumItems, value.length);
  return value
    .filter((item) => typeof item === "string")
    .map((item) => boundedString(item, limitKind, C.MAX_WORLD_BOOK_SHORT_STRING_CHARS));
}

// Merges the primary and alias spellings of a string list (§7.4 stores
// characterNames/characterTags; some formats spell them names/tags) into one
// deduplicated list, first occurrence winning.
function mergedStringArray(primary, alias, maximumItems, limitKind) {
  const merged = [];
  const seen = new Set();
  for (const value of [primary, alias]) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item !== "string" || seen.has(item)) continue;
      seen.add(item);
      merged.push(boundedString(item, limitKind, C.MAX_WORLD_BOOK_SHORT_STRING_CHARS));
    }
  }
  if (merged.length > maximumItems) throw limit(limitKind, maximumItems, merged.length);
  return merged;
}

function preservedUnknown(input, knownKeys) {
  const preserved = {};
  for (const key of Object.keys(input)) {
    if (!knownKeys.has(key)) preserved[key] = input[key];
  }
  return preserved;
}

function normalizeCharacterFilter(input) {
  const filter = plainObject(input) ? input : {};
  return {
    mode: enumAt(filter, "mode", CHARACTER_FILTER_MODES, "include"),
    characterNames: mergedStringArray(
      filter.characterNames, filter.names, C.MAX_WORLD_BOOK_FILTER_ITEMS, "characterFilterItems",
    ),
    characterTags: mergedStringArray(
      filter.characterTags, filter.tags, C.MAX_WORLD_BOOK_FILTER_ITEMS, "characterFilterItems",
    ),
    ...preservedUnknown(filter, KNOWN_CHARACTER_FILTER_KEYS),
  };
}

function normalizeActivation(input) {
  const activation = plainObject(input) ? input : {};
  return {
    constant: boolAt(activation, "constant", false),
    primaryKeys: stringArrayAt(
      activation, "primaryKeys", C.MAX_WORLD_BOOK_KEYS_PER_ENTRY, "activationKeys",
    ),
    secondaryKeys: stringArrayAt(
      activation, "secondaryKeys", C.MAX_WORLD_BOOK_KEYS_PER_ENTRY, "activationKeys",
    ),
    selective: boolAt(activation, "selective", false),
    selectiveLogic: enumAt(activation, "selectiveLogic", SELECTIVE_LOGICS, "and_any"),
    useRegex: boolAt(activation, "useRegex", false),
    vectorized: boolAt(activation, "vectorized", false),
    caseSensitive: boolAt(activation, "caseSensitive", false),
    matchWholeWords: boolAt(activation, "matchWholeWords", false),
    probability: probabilityAt(activation, "probability", 100),
    inclusionGroups: stringArrayAt(
      activation, "inclusionGroups", C.MAX_WORLD_BOOK_INCLUSION_GROUPS, "inclusionGroups",
    ),
    groupWeight: intAt(activation, "groupWeight", 100, C.MAX_WORLD_BOOK_GROUP_WEIGHT),
    prioritizeInclusion: boolAt(activation, "prioritizeInclusion", false),
    useGroupScoring: boolAt(activation, "useGroupScoring", false),
    characterFilter: normalizeCharacterFilter(activation.characterFilter),
    generationTriggers: stringArrayAt(
      activation, "generationTriggers", C.MAX_WORLD_BOOK_GENERATION_TRIGGERS, "generationTriggers",
    ),
    matchSources: stringArrayAt(
      activation, "matchSources", C.MAX_WORLD_BOOK_MATCH_SOURCES, "matchSources",
    ),
    delayMessages: intAt(activation, "delayMessages", 0, C.MAX_WORLD_BOOK_MESSAGE_COUNT),
    stickyMessages: intAt(activation, "stickyMessages", 0, C.MAX_WORLD_BOOK_MESSAGE_COUNT),
    cooldownMessages: intAt(activation, "cooldownMessages", 0, C.MAX_WORLD_BOOK_MESSAGE_COUNT),
    // V3 decorator-compiled fields (§10.4.7); defaults mean "no directive".
    forceState: enumAt(activation, "forceState", FORCE_STATES, "none"),
    activateOnlyAfter: intAt(activation, "activateOnlyAfter", 0, C.MAX_WORLD_BOOK_MESSAGE_COUNT),
    greetingIndex: nullableIntAt(activation, "greetingIndex", C.MAX_WORLD_BOOK_MESSAGE_COUNT),
    scanDepthMessages: intAt(activation, "scanDepthMessages", 0, C.MAX_WORLD_BOOK_MESSAGE_COUNT),
    statefulMatch: enumAt(activation, "statefulMatch", STATEFUL_MATCHES, "none"),
    ...preservedUnknown(activation, KNOWN_ACTIVATION_KEYS),
  };
}

function normalizeInsertion(input) {
  const insertion = plainObject(input) ? input : {};
  // null/undefined means "no explicit priority"; Number(null) === 0 would
  // silently turn an absent priority into a real one on re-normalization.
  const priority = insertion.priority == null ? Number.NaN : Number(insertion.priority);
  return {
    position: enumAt(insertion, "position", INSERTION_POSITIONS, "before_character"),
    depth: intAt(insertion, "depth", 4, C.MAX_WORLD_BOOK_DEPTH),
    role: enumAt(insertion, "role", INSERTION_ROLES, "system"),
    outletName: stringAt(
      insertion, "outletName", "", C.MAX_WORLD_BOOK_SHORT_STRING_CHARS, "outletNameChars",
    ),
    order: intAt(insertion, "order", 100, C.MAX_WORLD_BOOK_ORDER),
    priority: Number.isFinite(priority)
      ? Math.max(0, Math.min(Math.floor(priority), C.MAX_WORLD_BOOK_ORDER))
      : null,
    reverseDepth: boolAt(insertion, "reverseDepth", false),
    ...preservedUnknown(insertion, KNOWN_INSERTION_KEYS),
  };
}

function normalizeRecursion(input) {
  const recursion = plainObject(input) ? input : {};
  return {
    preventFurtherRecursion: boolAt(recursion, "preventFurtherRecursion", false),
    excludeFromRecursion: boolAt(recursion, "excludeFromRecursion", false),
    delayUntilRecursion: boolAt(recursion, "delayUntilRecursion", false),
    recursionLevel: intAt(recursion, "recursionLevel", 0, C.MAX_WORLD_BOOK_RECURSION_STEPS),
    ...preservedUnknown(recursion, KNOWN_RECURSION_KEYS),
  };
}

function normalizeEntry(input, index) {
  if (!plainObject(input)) {
    throw invalid("World book entries must be plain objects", { path: `/entries/${index}` });
  }
  const rawContent = typeof input.content === "string" ? input.content : "";
  const contentChars = [...rawContent].length;
  if (contentChars > C.MAX_WORLD_BOOK_CONTENT_CHARS) {
    throw limit("entryContentChars", C.MAX_WORLD_BOOK_CONTENT_CHARS, contentChars);
  }
  const rawId = typeof input.id === "string" && input.id ? input.id : `entry-${index}`;
  const id = boundedString(rawId, "entryIdChars", C.MAX_WORLD_BOOK_ENTRY_ID_CHARS);
  // V3 decorator compilation (§10.4.7) happens here, at immutable
  // revision-index build time; see world-book-decorators.js.
  const decorated = resolveEntryDecorators(input, rawContent);
  const activationRaw = plainObject(input.activation) ? input.activation : {};
  const insertionRaw = plainObject(input.insertion) ? input.insertion : {};
  return {
    id,
    enabled: boolAt(input, "enabled", true),
    content: decorated.content,
    // Decorator field overrides are validated by the compiler and then
    // re-validated by the field normalizers after the merge.
    activation: normalizeActivation({ ...activationRaw, ...decorated.record.applied.activation }),
    insertion: normalizeInsertion({ ...insertionRaw, ...decorated.record.applied.insertion }),
    recursion: normalizeRecursion(input.recursion),
    decorators: decorated.record,
    preservedDecorators: decorated.preservedDecorators,
    preservedExtensions: plainObject(input.preservedExtensions)
      ? input.preservedExtensions
      : {},
    ...preservedUnknown(input, KNOWN_ENTRY_KEYS),
  };
}

function normalizeScanPolicy(input) {
  const policy = plainObject(input) ? input : {};
  return {
    scanDepthMessages: intAt(policy, "scanDepthMessages", 8, C.MAX_WORLD_BOOK_MESSAGE_COUNT),
    includeParticipantNames: boolAt(policy, "includeParticipantNames", true),
    tokenBudget: intAt(policy, "tokenBudget", 0, C.MAX_WORLD_BOOK_TOKEN_BUDGET),
    recursive: boolAt(policy, "recursive", true),
    maxRecursionSteps: intAt(policy, "maxRecursionSteps", 4, C.MAX_WORLD_BOOK_RECURSION_STEPS),
    minActivations: intAt(policy, "minActivations", 0, C.MAX_WORLD_BOOK_ENTRIES),
    maxDepthMessages: intAt(policy, "maxDepthMessages", 0, C.MAX_WORLD_BOOK_MESSAGE_COUNT),
    ...preservedUnknown(policy, KNOWN_SCAN_POLICY_KEYS),
  };
}

function normalizeWorldBookCanonical(input) {
  assertPlainData(input, { nodes: 0, ancestors: new Set() }, 1, "");
  if (!plainObject(input)) {
    throw invalid("World book canonical data must be a plain object", { path: "" });
  }
  const name = requiredString(input.name || input.displayName, "world book name");
  if ([...name].length > C.MAX_WORLD_BOOK_NAME_CHARS) {
    throw limit("nameChars", C.MAX_WORLD_BOOK_NAME_CHARS, [...name].length);
  }
  const rawEntries = input.entries == null ? [] : input.entries;
  if (!Array.isArray(rawEntries)) {
    throw invalid("World book entries must be an array", { path: "/entries" });
  }
  if (rawEntries.length > C.MAX_WORLD_BOOK_ENTRIES) {
    throw limit("entries", C.MAX_WORLD_BOOK_ENTRIES, rawEntries.length);
  }
  const entries = rawEntries.map((entry, index) => normalizeEntry(entry, index));
  const seenIds = new Set();
  for (const entry of entries) {
    if (seenIds.has(entry.id)) {
      throw invalid("World book entry ids must be unique", { entryId: entry.id });
    }
    seenIds.add(entry.id);
  }
  return {
    schemaVersion: C.WORLD_BOOK_SCHEMA_VERSION,
    name,
    entries,
    scanPolicy: normalizeScanPolicy(input.scanPolicy),
    ...preservedUnknown(input, KNOWN_CANONICAL_KEYS),
  };
}

// Mirrors the character codec's prepareRevision: the revision hash covers the
// normalized canonical data, the provenance envelope, and the linked asset
// descriptors, so identical envelopes dedupe and any drift creates a new
// immutable revision.
function prepareWorldBookRevision(canonical, source, kind, assets) {
  const canonicalData = packJson(
    canonical, C.MAX_WORLD_BOOK_CANONICAL_BYTES, "world book canonical",
    "WORLD_BOOK_DATA_TOO_LARGE",
  );
  // Walk the RAW source before normalizeSource: its spread reads properties
  // directly, which would fire accessors/Proxy traps. Plain-data first means
  // no trap ever runs.
  if (source && typeof source === "object") {
    assertPlainData(source, { nodes: 0, ancestors: new Set() }, 1, "");
  }
  const sourceValue = normalizeSource(source, kind);
  const sourceData = packJson(
    sourceValue, C.MAX_WORLD_BOOK_SOURCE_BYTES, "world book source",
    "WORLD_BOOK_DATA_TOO_LARGE",
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
      && asset.purpose === "world-book-original"
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
  normalizeWorldBookCanonical,
  prepareWorldBookRevision,
};
