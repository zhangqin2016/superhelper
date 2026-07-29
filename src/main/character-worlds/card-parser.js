"use strict";

const { CompatibilityReport } = require("./compatibility-report");
const {
  CHARACTER_SCHEMA_VERSION,
} = require("./constants");
const { resolveImportLimits } = require("./import-limits");
const { JsonPointerStack } = require("./json-pointer");
const { ParseBudget } = require("./parse-budget");
const { extractEmbeddedCard, isPngSignature } = require("./png-card");
const {
  cardError,
  decodeJsonDocument,
  normalizeString,
  normalizeStringArray,
  stableJson,
} = require("./validation");

const EXECUTABLE_KEYS = new Set([
  "executable",
  "script",
  "scripts",
  "plugin",
  "plugins",
  "regexscript",
  "regexscripts",
  "stscript",
  "quickreply",
  "quickreplies",
]);

const V1_STRONG_FIELDS = new Map([
  ["personality", "string"],
  ["char_persona", "string"],
  ["scenario", "string"],
  ["world_scenario", "string"],
  ["firstMessage", "string"],
  ["first_mes", "string"],
  ["char_greeting", "string"],
  ["exampleDialogue", "string"],
  ["mes_example", "string"],
  ["example_dialogue", "string"],
]);

const FIELD_DEFINITIONS = [
  ["name", "string", [["name", "supported"], ["char_name", "migrated"]]],
  ["description", "string", [["description", "supported"]]],
  ["personality", "string", [
    ["personality", "supported"], ["char_persona", "migrated"],
  ]],
  ["scenario", "string", [
    ["scenario", "supported"], ["world_scenario", "migrated"],
  ]],
  ["firstMessage", "string", [
    ["firstMessage", "supported"], ["first_mes", "migrated"], ["char_greeting", "migrated"],
  ]],
  ["alternateGreetings", "array", [
    ["alternateGreetings", "supported"], ["alternate_greetings", "supported"],
  ]],
  ["exampleDialogue", "string", [
    ["exampleDialogue", "supported"],
    ["mes_example", "migrated"],
    ["example_dialogue", "migrated"],
  ]],
  ["creatorNotes", "string", [
    ["creatorNotes", "supported"], ["creator_notes", "migrated"],
  ]],
  ["systemPrompt", "string", [
    ["systemPrompt", "supported"], ["system_prompt", "migrated"],
  ]],
  ["postHistoryInstructions", "string", [
    ["postHistoryInstructions", "supported"], ["post_history_instructions", "migrated"],
  ]],
  ["tags", "array", [["tags", "supported"]]],
  ["creator", "string", [["creator", "supported"]]],
  ["characterVersion", "string", [
    ["characterVersion", "supported"], ["character_version", "migrated"],
  ]],
].map(([canonical, kind, sources]) => ({ canonical, kind, sources }));

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function validShapeValue(value, expectedType) {
  if (expectedType === "string") return typeof value === "string" && value.trim().length > 0;
  if (expectedType === "array") {
    return Array.isArray(value)
      && value.some((item) => typeof item === "string" && item.trim().length > 0);
  }
  return false;
}

function cardShape(value, requireV1Shape) {
  if (!isPlainObject(value) || (!hasOwn(value, "name") && !hasOwn(value, "char_name"))) {
    return false;
  }
  if (!requireV1Shape) return true;
  let strongFields = 0;
  for (const [field, expectedType] of V1_STRONG_FIELDS) {
    if (hasOwn(value, field) && validShapeValue(value[field], expectedType)) strongFields += 1;
  }
  if (hasOwn(value, "name")) return strongFields >= 2;
  return hasOwn(value, "char_name") && strongFields >= 1;
}

function versionMajor(value, lexeme) {
  const declared = lexeme ?? value;
  if (typeof declared !== "string" && typeof declared !== "number") return null;
  if (typeof declared === "number" && !Number.isFinite(declared)) return null;
  const match = /^(2|3)(?:\.(?:0|[1-9]\d*))?$/.exec(String(declared));
  return match ? Number(match[1]) : null;
}

function numberLexemeAt(numberLexemes, pointer) {
  return numberLexemes.find((entry) => entry.pointer === pointer)?.lexeme;
}

function detectFormat(root, numberLexemes = []) {
  if (!isPlainObject(root)) return null;
  const hasSpec = hasOwn(root, "spec");
  const hasVersion = hasOwn(root, "spec_version");
  let specMajor = null;
  if (hasSpec) {
    if (root.spec === "chara_card_v2") specMajor = 2;
    else if (root.spec === "chara_card_v3") specMajor = 3;
    else {
      throw cardError("NOT_A_CHARACTER_CARD", "Character card spec is not supported", {
        path: "",
      });
    }
  }
  const declaredMajor = hasVersion
    ? versionMajor(root.spec_version, numberLexemeAt(numberLexemes, "/spec_version"))
    : null;
  if (hasVersion && declaredMajor === null) {
    throw cardError("NOT_A_CHARACTER_CARD", "Character card version is not supported", {
      path: "",
    });
  }
  if (specMajor !== null && declaredMajor !== null && specMajor !== declaredMajor) {
    throw cardError("CARD_FORMAT_CONFLICT", "Character card markers conflict", {
      path: "/spec_version",
    });
  }
  const major = specMajor ?? declaredMajor;
  if (major !== null) {
    if (!cardShape(root.data, false)) {
      throw cardError("NOT_A_CHARACTER_CARD", "Declared character card has no identity", {
        path: "",
      });
    }
    return major === 3 ? "v3_json" : "v2_json";
  }
  if (!cardShape(root, true)) {
    throw cardError("NOT_A_CHARACTER_CARD", "JSON is not a recognizable character card", {
      path: "",
    });
  }
  return "v1_json";
}

function executableKey(key) {
  return EXECUTABLE_KEYS.has(key.replace(/[\s_-]+/g, "").toLowerCase());
}

function chooseSource(source, definition) {
  for (const [field, category] of definition.sources) {
    if (hasOwn(source, field)) return { field, category, value: source[field] };
  }
  return null;
}

function markConsumed(consumed, object, key) {
  let keys = consumed.get(object);
  if (!keys) {
    keys = new Set();
    consumed.set(object, keys);
  }
  keys.add(key);
}

function isConsumed(consumed, object, key) {
  return consumed.get(object)?.has(key) || false;
}

function withToken(pointer, token, action) {
  pointer.push(token);
  try {
    return action();
  } finally {
    pointer.pop();
  }
}

function normalizeArrayField(value, limits, report, pointer) {
  for (let index = 0; index < value.length; index += 1) {
    if (typeof value[index] !== "string") {
      withToken(pointer, index, () => report.add("ignoredInvalid", pointer));
    }
  }
  return normalizeStringArray(value, {
    ...limits,
    maxStringChars: limits.maxCanonicalFieldChars,
  }, pointer.toString());
}

function mapCanonical(source, prefix, limits, report, pointer, consumed, budget) {
  const canonical = Object.create(null);
  canonical.schemaVersion = CHARACTER_SCHEMA_VERSION;
  if (prefix) pointer.push(prefix);
  for (const definition of FIELD_DEFINITIONS) {
    budget.consume(1);
    const selected = chooseSource(source, definition);
    const defaultValue = definition.kind === "array" ? [] : "";
    if (!selected) {
      canonical[definition.canonical] = defaultValue;
      continue;
    }
    markConsumed(consumed, source, selected.field);
    withToken(pointer, selected.field, () => {
      if (definition.kind === "array") {
        if (!Array.isArray(selected.value)) {
          report.add("ignoredInvalid", pointer);
          canonical[definition.canonical] = [];
        } else {
          report.add(selected.category, pointer);
          canonical[definition.canonical] = normalizeArrayField(
            selected.value,
            limits,
            report,
            pointer,
          );
        }
        return;
      }
      const normalized = normalizeString(
        selected.value,
        limits.maxCanonicalFieldChars,
        pointer.toString(),
      );
      if (normalized === null) {
        report.add("ignoredInvalid", pointer);
        canonical[definition.canonical] = "";
      } else {
        report.add(selected.category, pointer);
        canonical[definition.canonical] = definition.canonical === "name"
          ? normalized.trim()
          : normalized;
      }
    });
  }
  if (prefix) pointer.pop();
  return canonical;
}

function classifyPreserved(
  value,
  report,
  pointer,
  consumed,
  budget,
  unknownEligible = true,
) {
  budget.consume(1);
  if (Array.isArray(value)) {
    if (value.length === 0 && unknownEligible) report.add("preservedInert", pointer);
    for (let index = 0; index < value.length; index += 1) {
      withToken(pointer, index, () => (
        classifyPreserved(value[index], report, pointer, consumed, budget, unknownEligible)
      ));
    }
    return;
  }
  if (!isPlainObject(value)) {
    if (unknownEligible) report.add("preservedInert", pointer);
    return;
  }
  const keys = Object.keys(value).sort();
  if (keys.length === 0 && unknownEligible) report.add("preservedInert", pointer);
  for (const key of keys) {
    withToken(pointer, key, () => {
      if (executableKey(key)) {
        report.add("rejectedExecutable", pointer);
        return;
      }
      classifyPreserved(
        value[key],
        report,
        pointer,
        consumed,
        budget,
        unknownEligible && !isConsumed(consumed, value, key),
      );
    });
  }
}

function addMarkerReports(root, report, pointer, consumed) {
  for (const marker of ["spec", "spec_version"]) {
    if (!hasOwn(root, marker)) continue;
    markConsumed(consumed, root, marker);
    withToken(pointer, marker, () => report.add("supported", pointer));
  }
}

// Synchronous bounded primitive; Task 5 should invoke it inside a cancellable worker.
function parseJsonCharacterCard(buffer, options = {}) {
  const limits = resolveImportLimits(options.limits);
  const budget = new ParseBudget(limits);
  const preserved = decodeJsonDocument(buffer, limits, budget);
  const root = preserved.data;
  if (!isPlainObject(root)) {
    throw cardError("CARD_ROOT_INVALID", "Character card JSON root must be an object", {
      path: "",
    });
  }
  const format = detectFormat(root, preserved.numberLexemes);
  const prefix = format === "v1_json" ? "" : "data";
  const source = prefix ? root.data : root;
  const report = new CompatibilityReport(limits);
  const pointer = new JsonPointerStack();
  const consumed = new WeakMap();
  if (prefix) addMarkerReports(root, report, pointer, consumed);
  const canonical = mapCanonical(
    source,
    prefix,
    limits,
    report,
    pointer,
    consumed,
    budget,
  );
  const selectedName = chooseSource(source, FIELD_DEFINITIONS[0]);
  if (!selectedName || !canonical.name) {
    throw cardError("CARD_ROOT_INVALID", "Character card name must be a non-empty string", {
      path: selectedName
        ? `/${prefix ? `${prefix}/` : ""}${selectedName.field}`
        : "",
    });
  }
  classifyPreserved(preserved.data, report, pointer, consumed, budget);
  const canonicalJson = stableJson(canonical);
  const canonicalBytes = Buffer.byteLength(canonicalJson, "utf8");
  if (canonicalBytes > limits.maxCanonicalBytes) {
    throw cardError("CARD_LIMIT_EXCEEDED", "Canonical character data is too large", {
      limit: "maxCanonicalBytes",
      maximum: limits.maxCanonicalBytes,
      actual: canonicalBytes,
      path: "",
    });
  }
  budget.check(true);
  return {
    ok: true,
    format,
    canonical,
    preserved,
    compatibility: report.finalize(),
  };
}

function parseCharacterCard(buffer, options = {}) {
  if (!isPngSignature(buffer)) return parseJsonCharacterCard(buffer, options);
  const embedded = extractEmbeddedCard(buffer, options.limits);
  const parsed = embedded.parsed;
  return {
    ...parsed,
    container: embedded.container,
    compatibility: {
      ...parsed.compatibility,
      warnings: [...parsed.compatibility.warnings, ...embedded.warnings],
    },
  };
}

module.exports = {
  detectFormat,
  parseCharacterCard,
  parseJsonCharacterCard,
};
