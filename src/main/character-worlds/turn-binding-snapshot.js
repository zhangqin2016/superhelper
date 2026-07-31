"use strict";

const { types: utilTypes } = require("node:util");
const C = require("./constants");

const SNAPSHOT_SCHEMA_VERSION = 1;
const MAX_SNAPSHOT_ID_BYTES = 512;
const MAX_COMPATIBILITY_PROFILE_BYTES = 1024;
const SNAPSHOT_KEYS = new Set([
  "schemaVersion",
  "mode",
  "bindingVersion",
  "characterRevisionId",
  "personaRevisionId",
  "compatibilityProfile",
  "snapshotStatus",
]);
// Snapshots persisted before the persona pin (Phase 2B P2B-2) lack the
// personaRevisionId key; they normalize cleanly with personaRevisionId null.
const LEGACY_SNAPSHOT_KEYS = new Set([...SNAPSHOT_KEYS].filter((key) => key !== "personaRevisionId"));

function boundedString(value, maxBytes) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxBytes) return null;
  return Buffer.byteLength(value, "utf8") <= maxBytes ? value : null;
}

function fallbackSnapshot() {
  return Object.freeze({
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    mode: "native",
    bindingVersion: 0,
    characterRevisionId: null,
    personaRevisionId: null,
    compatibilityProfile: null,
    snapshotStatus: "fallback",
  });
}

function readySnapshot({
  bindingVersion,
  characterRevisionId,
  personaRevisionId = null,
  compatibilityProfile,
}) {
  if (!Number.isInteger(bindingVersion) || bindingVersion < 1) return null;
  const revisionId = boundedString(characterRevisionId, MAX_SNAPSHOT_ID_BYTES);
  const personaId = personaRevisionId == null
    ? null
    : boundedString(personaRevisionId, MAX_SNAPSHOT_ID_BYTES);
  const profile = boundedString(compatibilityProfile, MAX_COMPATIBILITY_PROFILE_BYTES);
  if (!revisionId || (personaRevisionId != null && !personaId) || !profile) return null;
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    mode: "character",
    bindingVersion,
    characterRevisionId: revisionId,
    personaRevisionId: personaId,
    compatibilityProfile: profile,
    snapshotStatus: "ready",
  };
}

function normalizeSnapshot(value, { allowFallback = true } = {}) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || utilTypes.isProxy(value)
  ) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const keys = Reflect.ownKeys(value);
  const keySet = keys.length === SNAPSHOT_KEYS.size
    ? SNAPSHOT_KEYS
    : keys.length === LEGACY_SNAPSHOT_KEYS.size
      ? LEGACY_SNAPSHOT_KEYS
      : null;
  if (
    !keySet
    || keys.some((key) => typeof key !== "string" || !keySet.has(key))
  ) return null;
  const fields = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return null;
    fields[key] = descriptor.value;
  }
  if (keySet === LEGACY_SNAPSHOT_KEYS) fields.personaRevisionId = null;
  if (
    fields.schemaVersion !== SNAPSHOT_SCHEMA_VERSION
    || !Number.isInteger(fields.bindingVersion)
    || fields.bindingVersion < 0
  ) return null;
  if (fields.snapshotStatus === "fallback" && allowFallback) {
    return fields.mode === "native"
      && fields.bindingVersion === 0
      && fields.characterRevisionId === null
      && fields.personaRevisionId === null
      && fields.compatibilityProfile === null
      ? fallbackSnapshot()
      : null;
  }
  if (fields.mode !== "character" || fields.snapshotStatus !== "ready") return null;
  return readySnapshot(fields);
}

function freezeSnapshot(value) {
  const normalized = normalizeSnapshot(value);
  return normalized ? Object.freeze(normalized) : null;
}

function snapshotFromMetadata(metadata) {
  if (
    !metadata
    || typeof metadata !== "object"
    || Array.isArray(metadata)
    || utilTypes.isProxy(metadata)
  ) return null;
  const prototype = Object.getPrototypeOf(metadata);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const descriptor = Object.getOwnPropertyDescriptor(metadata, "characterWorlds");
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return null;
  const snapshot = descriptor.value;
  const normalized = normalizeSnapshot(snapshot);
  if (!normalized) return null;
  if (
    Object.isFrozen(snapshot)
    && snapshot.schemaVersion === normalized.schemaVersion
    && snapshot.mode === normalized.mode
    && snapshot.bindingVersion === normalized.bindingVersion
    && snapshot.characterRevisionId === normalized.characterRevisionId
    && snapshot.personaRevisionId === normalized.personaRevisionId
    && snapshot.compatibilityProfile === normalized.compatibilityProfile
    && snapshot.snapshotStatus === normalized.snapshotStatus
  ) return snapshot;
  return Object.freeze(normalized);
}

function snapshotJsonBytes(snapshot) {
  if (!snapshot) return 0;
  return Buffer.byteLength(JSON.stringify(snapshot), "utf8");
}

if (snapshotJsonBytes(fallbackSnapshot()) > C.MAX_CHARACTER_BINDING_BYTES) {
  throw new Error("Character Worlds fallback snapshot exceeds persistence bound");
}

module.exports = {
  SNAPSHOT_SCHEMA_VERSION,
  fallbackSnapshot,
  freezeSnapshot,
  normalizeSnapshot,
  readySnapshot,
  snapshotFromMetadata,
};
