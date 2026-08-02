"use strict";

const { types: utilTypes } = require("node:util");
const { dedupeBooks } = require("./conversation-config");

const COMPOSITION_SNAPSHOT_SCHEMA_VERSION = 2;
const MAX_ID_BYTES = 512;
const MAX_PROFILE_BYTES = 1024;
const KEYS = new Set([
  "schemaVersion",
  "mode",
  "bindingVersion",
  "previewVersion",
  "characterRevisionId",
  "personaRevisionId",
  "worldBookBindings",
  "compatibilityProfile",
  "greetingIndex",
  "sceneId",
  "groupId",
  "snapshotStatus",
]);

function optionalString(value, maxBytes = MAX_ID_BYTES) {
  if (value == null || value === "") return null;
  if (
    typeof value !== "string"
    || Buffer.byteLength(value, "utf8") > maxBytes
    || /[\u0000-\u001f\u007f]/.test(value)
  ) return undefined;
  return value;
}

function plainFields(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== KEYS.size || keys.some((key) => typeof key !== "string" || !KEYS.has(key))) {
    return null;
  }
  const fields = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return null;
    fields[key] = descriptor.value;
  }
  return fields;
}

function readyCompositionSnapshot(input = {}) {
  if (
    !Number.isInteger(input.bindingVersion)
    || input.bindingVersion < 0
    || !Number.isInteger(input.previewVersion)
    || input.previewVersion < 0
  ) return null;
  const characterRevisionId = optionalString(input.characterRevisionId);
  const personaRevisionId = optionalString(input.personaRevisionId);
  const compatibilityProfile = optionalString(input.compatibilityProfile, MAX_PROFILE_BYTES);
  const sceneId = optionalString(input.sceneId);
  const groupId = optionalString(input.groupId);
  if (
    characterRevisionId === undefined
    || personaRevisionId === undefined
    || compatibilityProfile === undefined
    || sceneId === undefined
    || groupId === undefined
  ) return null;
  let worldBookBindings;
  try {
    worldBookBindings = dedupeBooks(input.worldBookBindings || []);
  } catch {
    return null;
  }
  if (!characterRevisionId && !personaRevisionId && worldBookBindings.length === 0) return null;
  const mode = characterRevisionId ? "character" : "native";
  if (input.mode != null && input.mode !== mode) return null;
  if (characterRevisionId ? !compatibilityProfile : compatibilityProfile !== null) return null;
  const greetingIndex = characterRevisionId
    && Number.isSafeInteger(input.greetingIndex)
    && input.greetingIndex >= 0
    ? input.greetingIndex
    : null;
  return Object.freeze({
    schemaVersion: COMPOSITION_SNAPSHOT_SCHEMA_VERSION,
    mode,
    bindingVersion: input.bindingVersion,
    previewVersion: input.previewVersion,
    characterRevisionId,
    personaRevisionId,
    worldBookBindings,
    compatibilityProfile,
    greetingIndex,
    sceneId: characterRevisionId ? sceneId : null,
    groupId: characterRevisionId ? groupId : null,
    snapshotStatus: "ready",
  });
}

function normalizeCompositionSnapshot(value) {
  const fields = plainFields(value);
  if (
    !fields
    || fields.schemaVersion !== COMPOSITION_SNAPSHOT_SCHEMA_VERSION
    || fields.snapshotStatus !== "ready"
  ) return null;
  return readyCompositionSnapshot(fields);
}

module.exports = {
  COMPOSITION_SNAPSHOT_SCHEMA_VERSION,
  normalizeCompositionSnapshot,
  readyCompositionSnapshot,
};
