"use strict";

const crypto = require("node:crypto");
const { serializePreservedJson } = require("./validation");

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

const KNOWN_FIELDS = new Set([
  "name",
  "char_name",
  "description",
  "personality",
  "char_persona",
  "scenario",
  "world_scenario",
  "firstMessage",
  "first_mes",
  "char_greeting",
  "alternateGreetings",
  "alternate_greetings",
  "exampleDialogue",
  "mes_example",
  "example_dialogue",
  "creatorNotes",
  "creator_notes",
  "systemPrompt",
  "system_prompt",
  "postHistoryInstructions",
  "post_history_instructions",
  "tags",
  "creator",
  "characterVersion",
  "character_version",
]);

const ALIAS_GROUPS = [
  ["name", ["name", "char_name"]],
  ["personality", ["personality", "char_persona"]],
  ["scenario", ["scenario", "world_scenario"]],
  ["firstMessage", ["firstMessage", "first_mes", "char_greeting"]],
  ["alternateGreetings", ["alternateGreetings", "alternate_greetings"]],
  ["exampleDialogue", ["exampleDialogue", "mes_example", "example_dialogue"]],
  ["creatorNotes", ["creatorNotes", "creator_notes"]],
  ["systemPrompt", ["systemPrompt", "system_prompt"]],
  ["postHistoryInstructions", [
    "postHistoryInstructions",
    "post_history_instructions",
  ]],
  ["characterVersion", ["characterVersion", "character_version"]],
];

function executableKey(key) {
  return EXECUTABLE_KEYS.has(key.replace(/[\s_-]+/g, "").toLowerCase());
}

function pointerToken(value) {
  return String(value).replace(/~/g, "~0").replace(/\//g, "~1");
}

function inertClone(value, pointer, omitted) {
  if (Array.isArray(value)) {
    return value.map((item, index) => inertClone(
      item,
      `${pointer}/${index}`,
      omitted,
    ));
  }
  if (!value || typeof value !== "object") return value;
  const result = Object.create(null);
  for (const key of Object.keys(value).sort()) {
    const childPointer = `${pointer}/${pointerToken(key)}`;
    if (executableKey(key)) {
      omitted.push(childPointer);
      continue;
    }
    result[key] = inertClone(value[key], childPointer, omitted);
  }
  return result;
}

function canonicalFields(canonical) {
  return {
    name: canonical.name || "",
    description: canonical.description || "",
    personality: canonical.personality || "",
    scenario: canonical.scenario || "",
    first_mes: canonical.firstMessage || "",
    alternate_greetings: Array.isArray(canonical.alternateGreetings)
      ? canonical.alternateGreetings
      : [],
    mes_example: canonical.exampleDialogue || "",
    creator_notes: canonical.creatorNotes || "",
    system_prompt: canonical.systemPrompt || "",
    post_history_instructions: canonical.postHistoryInstructions || "",
    tags: Array.isArray(canonical.tags) ? canonical.tags : [],
    creator: canonical.creator || "",
    character_version: canonical.characterVersion || "",
  };
}

function pointerValue(root, pointer) {
  if (pointer === "") return root;
  let current = root;
  for (const encoded of pointer.slice(1).split("/")) {
    const key = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!current || typeof current !== "object"
        || !Object.prototype.hasOwnProperty.call(current, key)) {
      return { found: false };
    }
    current = current[key];
  }
  return { found: true, value: current };
}

function remapLexemes(entries, format, output) {
  if (!Array.isArray(entries)) return [];
  const remapped = [];
  for (const entry of entries) {
    if (!entry || typeof entry.pointer !== "string" || typeof entry.lexeme !== "string") {
      continue;
    }
    const pointer = format === "v1_json" && entry.pointer
      ? `/data${entry.pointer}`
      : entry.pointer;
    const resolved = pointerValue(output, pointer);
    if (resolved.found && (resolved.value === null || typeof resolved.value === "number")) {
      remapped.push({ pointer, lexeme: entry.lexeme });
    }
  }
  remapped.sort((left, right) => (
    left.pointer < right.pointer ? -1 : left.pointer > right.pointer ? 1 : 0
  ));
  return remapped.filter((entry, index) => (
    index === 0 || entry.pointer !== remapped[index - 1].pointer
  ));
}

function buildCanonicalV3(revision) {
  const source = revision?.source || {};
  const original = source.preserved?.data;
  const omittedExecutable = [];
  const cloned = original && typeof original === "object"
    ? inertClone(original, "", omittedExecutable)
    : Object.create(null);
  const sourceData = source.format === "v1_json"
    ? cloned
    : cloned.data && typeof cloned.data === "object" && !Array.isArray(cloned.data)
      ? cloned.data
      : Object.create(null);
  const data = Object.create(null);
  for (const key of Object.keys(sourceData).sort()) {
    if (!KNOWN_FIELDS.has(key)) data[key] = sourceData[key];
  }
  Object.assign(data, canonicalFields(revision.canonical || {}));

  const output = Object.create(null);
  if (source.format !== "v1_json") {
    for (const key of Object.keys(cloned).sort()) {
      if (key !== "spec" && key !== "spec_version" && key !== "data") {
        output[key] = cloned[key];
      }
    }
  }
  output.spec = "chara_card_v3";
  output.spec_version = "3.0";
  output.data = data;
  const numberLexemes = remapLexemes(
    source.preserved?.numberLexemes,
    source.format,
    output,
  );
  const json = serializePreservedJson({
    schemaVersion: 1,
    data: output,
    numberLexemes,
  });
  return {
    bytes: Buffer.from(`${json}\n`, "utf8"),
    omittedExecutable: [...new Set(omittedExecutable)].sort(),
  };
}

function readExactOriginal(messageStore, revision) {
  const source = revision?.source;
  const original = source?.original;
  if (
    source?.originalCanonicalHash !== revision?.contentHash
    || !original
    || typeof original.hash !== "string"
    || !Number.isSafeInteger(original.bytes)
  ) {
    return null;
  }
  const linked = revision.cardAssets?.some((asset) => (
    asset.purpose === "character-card-original"
    && asset.hash === original.hash
    && asset.bytes === original.bytes
  ));
  if (!linked) return null;
  const bytes = messageStore?.blobs?.read(original.hash);
  if (!Buffer.isBuffer(bytes) || bytes.length !== original.bytes) return null;
  const actual = crypto.createHash("sha256").update(bytes).digest("hex");
  return actual === original.hash ? bytes : null;
}

function pathList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item) => (
    typeof item === "string"
    && item.length <= 4096
    && Buffer.byteLength(item, "utf8") <= 8192
  )))].sort();
}

function comparable(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function aliasConflicts(source) {
  const root = source?.preserved?.data;
  if (!root || typeof root !== "object" || Array.isArray(root)) return [];
  const prefix = source.format === "v1_json" ? "" : "/data";
  const data = source.format === "v1_json" ? root : root.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  const conflicts = [];
  for (const [canonicalField, aliases] of ALIAS_GROUPS) {
    const present = aliases.filter((alias) => (
      Object.prototype.hasOwnProperty.call(data, alias)
    ));
    if (present.length < 2) continue;
    const selected = present[0];
    const selectedValue = comparable(data[selected]);
    for (const alias of present.slice(1)) {
      if (comparable(data[alias]) === selectedValue) continue;
      conflicts.push({
        canonicalField,
        selectedPath: `${prefix}/${pointerToken(selected)}`,
        omittedPath: `${prefix}/${pointerToken(alias)}`,
      });
    }
  }
  return conflicts.sort((left, right) => (
    left.omittedPath < right.omittedPath
      ? -1
      : left.omittedPath > right.omittedPath
        ? 1
        : 0
  ));
}

function conversionEntries(source) {
  const conversions = [];
  if (source.format !== "v3_json") {
    conversions.push({
      kind: "format_version",
      from: source.format || "unknown",
      to: "v3_json",
      lossy: true,
    });
  }
  if (source.container && source.container !== "json") {
    conversions.push({
      kind: "container",
      from: source.container,
      to: "json",
      lossy: true,
    });
  }
  return conversions;
}

function buildExportLossReport(revision, {
  mode,
  omittedExecutable = [],
} = {}) {
  const source = revision?.source || {};
  const compatibility = source.compatibility || {};
  const preservedInertSource = pathList(compatibility.preservedInert);
  if (mode === "original") {
    return {
      schemaVersion: 1,
      lossy: false,
      preservedOriginal: true,
      sourceFormat: source.format || "unknown",
      outputFormat: source.format || "unknown",
      unknownFields: "preserved_original",
      executableFields: "preserved_original_inert_in_lily",
      omittedExecutable: [],
      ignoredInvalid: [],
      aliasConflicts: [],
      conversions: [],
      unpreserved: [],
      preservedInert: preservedInertSource,
      entries: [],
    };
  }

  const ignoredInvalid = pathList(compatibility.ignoredInvalid);
  const executable = pathList([
    ...pathList(compatibility.rejectedExecutable),
    ...pathList(omittedExecutable),
  ]);
  const aliases = aliasConflicts(source);
  const conversions = conversionEntries(source);
  const migrated = pathList(compatibility.migrated);
  const entries = [
    ...ignoredInvalid.map((path) => ({
      kind: "ignored_invalid",
      path,
      lossy: true,
    })),
    ...aliases.map((conflict) => ({
      kind: "alias_conflict",
      path: conflict.omittedPath,
      selectedPath: conflict.selectedPath,
      canonicalField: conflict.canonicalField,
      lossy: true,
    })),
    ...executable.map((path) => ({
      kind: "omitted_executable",
      path,
      lossy: true,
    })),
    ...migrated.map((path) => ({
      kind: "field_migration",
      path,
      lossy: false,
    })),
    ...conversions.map((conversion) => ({
      kind: conversion.kind === "format_version"
        ? "format_conversion"
        : "container_conversion",
      from: conversion.from,
      to: conversion.to,
      lossy: conversion.lossy,
    })),
  ];

  const counts = compatibility.counts || {};
  const representedIgnored = ignoredInvalid.length;
  const representedExecutable = executable.length;
  const hiddenLosses = Math.max(
    0,
    Number(counts.ignoredInvalid || 0) - representedIgnored,
  ) + Math.max(
    0,
    Number(counts.rejectedExecutable || 0) - representedExecutable,
  );
  if (hiddenLosses > 0 || compatibility.truncation?.omittedEntries > 0) {
    entries.push({
      kind: "compatibility_report_truncated",
      omittedEntries: Math.max(
        hiddenLosses,
        Number(compatibility.truncation?.omittedEntries || 0),
      ),
      lossy: hiddenLosses > 0,
    });
  }

  const unpreserved = [...new Set([
    ...ignoredInvalid,
    ...aliases.map((conflict) => conflict.omittedPath),
    ...executable,
  ])].sort();
  const preservedInert = preservedInertSource.filter(
    (path) => !unpreserved.includes(path),
  );
  const lossy = entries.some((entry) => entry.lossy === true);
  return {
    schemaVersion: 1,
    lossy,
    preservedOriginal: false,
    sourceFormat: source.format || "unknown",
    outputFormat: "v3_json",
    unknownFields: "preserved_inert",
    executableFields: executable.length > 0 ? "omitted_inert" : "none_omitted",
    omittedExecutable: executable,
    ignoredInvalid,
    aliasConflicts: aliases,
    conversions,
    unpreserved,
    preservedInert,
    entries,
  };
}

module.exports = {
  buildCanonicalV3,
  buildExportLossReport,
  readExactOriginal,
};
