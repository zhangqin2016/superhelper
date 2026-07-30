"use strict";

const { types: utilTypes } = require("node:util");
const {
  MAX_CHARACTER_BINDING_BYTES,
} = require("./character-worlds/constants");

const QUEUE_RECOVERY_SCHEMA_VERSION = 2;
const QUEUE_RECOVERY_KIND = "durable_queue";
const MAX_QUEUE_ITEM_ID_BYTES = 512;
const MAX_FILE_REF_COUNT = 64;
const MAX_FILE_REF_STRING_BYTES = 8192;
const MAX_QUEUE_ENVELOPE_DEPTH = 12;
const MAX_QUEUE_ENVELOPE_NODES = 2048;
const ENVELOPE_KEYS = new Set([
  "schemaVersion",
  "kind",
  "queueItemId",
  "fileRefs",
  "options",
]);
const LEGACY_ENVELOPE_KEYS = new Set([
  "schemaVersion",
  "kind",
  "queueItemId",
  "displayFiles",
  "options",
]);
const FILE_REF_KEYS = new Set([
  "id",
  "name",
  "path",
  "sourcePath",
  "staged",
  "pathOnly",
  "readable",
  "kind",
  "isDirectory",
  "extension",
  "type",
  "size",
  "isImage",
  "dimensions",
  "capabilityId",
]);
const OPTION_KEYS = new Set([
  "engineText",
  "recordUser",
  "recovery",
  "localAssistant",
  "reloadSkillsBeforeStart",
  "spawnEngine",
  "skipPreflight",
  "skipVision",
  "skipDocument",
  "scheduledTaskId",
  "scheduledTaskRunId",
  "scheduledTaskTitle",
  "nonInteractive",
  "permissionMode",
  "queueOrigin",
  "queueVisibility",
  "expectedArtifactPaths",
  "documentDeliveryRecovery",
  "externalCommand",
  "sourceTurnId",
]);
const DANGEROUS_KEYS = new Set([
  "__proto__",
  "prototype",
  "constructor",
  "ownerScope",
  "owner_scope",
]);

function boundedString(value, maxBytes) {
  if (typeof value !== "string" || !value || value.length > maxBytes) return null;
  return Buffer.byteLength(value, "utf8") <= maxBytes ? value : null;
}

function cloneBoundedJson(value) {
  const ancestors = new Set();
  let nodes = 0;
  const clone = (current, depth) => {
    nodes += 1;
    if (nodes > MAX_QUEUE_ENVELOPE_NODES || depth > MAX_QUEUE_ENVELOPE_DEPTH) {
      throw new TypeError("queue recovery envelope exceeds structural bounds");
    }
    if (current === null || typeof current === "boolean") return current;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new TypeError("queue recovery number is invalid");
      return current;
    }
    if (typeof current === "string") {
      if (
        current.length > MAX_CHARACTER_BINDING_BYTES
        || Buffer.byteLength(current, "utf8") > MAX_CHARACTER_BINDING_BYTES
      ) throw new TypeError("queue recovery string exceeds byte bounds");
      return current;
    }
    if (!current || typeof current !== "object" || utilTypes.isProxy(current)) {
      throw new TypeError("queue recovery envelope must be plain JSON data");
    }
    if (ancestors.has(current)) throw new TypeError("queue recovery envelope contains a cycle");
    ancestors.add(current);
    let output;
    if (Array.isArray(current)) {
      output = [];
      for (let index = 0; index < current.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
          throw new TypeError("queue recovery arrays must be dense values");
        }
        output.push(clone(descriptor.value, depth + 1));
      }
      if (Reflect.ownKeys(current).length !== current.length + 1) {
        throw new TypeError("queue recovery arrays contain unsupported properties");
      }
    } else {
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError("queue recovery objects must be plain");
      }
      output = {};
      for (const key of Reflect.ownKeys(current)) {
        if (typeof key !== "string" || DANGEROUS_KEYS.has(key)) {
          throw new TypeError("queue recovery envelope contains a dangerous key");
        }
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
          throw new TypeError("queue recovery properties must be enumerable values");
        }
        output[key] = clone(descriptor.value, depth + 1);
      }
    }
    ancestors.delete(current);
    return output;
  };
  const cloned = clone(value, 1);
  if (Buffer.byteLength(JSON.stringify(cloned), "utf8") > MAX_CHARACTER_BINDING_BYTES) {
    throw new TypeError("queue recovery envelope exceeds byte bounds");
  }
  return cloned;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function safeFileRefs(files) {
  if (!Array.isArray(files) || files.length > MAX_FILE_REF_COUNT) return null;
  const refs = [];
  try {
    for (const file of files) {
      if (
        !file
        || typeof file !== "object"
        || Array.isArray(file)
        || utilTypes.isProxy(file)
      ) return null;
      const prototype = Object.getPrototypeOf(file);
      if (prototype !== Object.prototype && prototype !== null) return null;
      const ref = {};
      for (const key of FILE_REF_KEYS) {
        const descriptor = Object.getOwnPropertyDescriptor(file, key);
        if (!descriptor) continue;
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) return null;
        if (
          typeof descriptor.value === "string"
          && (
            descriptor.value.length > MAX_FILE_REF_STRING_BYTES
            || Buffer.byteLength(descriptor.value, "utf8") > MAX_FILE_REF_STRING_BYTES
          )
        ) return null;
        ref[key] = cloneBoundedJson(descriptor.value);
      }
      refs.push(ref);
    }
  } catch {
    return null;
  }
  return refs;
}

function normalizeQueueRecoveryEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  let cloned;
  try {
    cloned = cloneBoundedJson(value);
  } catch {
    return null;
  }
  const keys = Object.keys(cloned);
  const legacy = cloned.schemaVersion === 1;
  const allowedKeys = legacy ? LEGACY_ENVELOPE_KEYS : ENVELOPE_KEYS;
  const sourceFiles = legacy ? cloned.displayFiles : cloned.fileRefs;
  const fileRefs = safeFileRefs(sourceFiles);
  if (
    keys.length !== allowedKeys.size
    || keys.some((key) => !allowedKeys.has(key))
    || (!legacy && cloned.schemaVersion !== QUEUE_RECOVERY_SCHEMA_VERSION)
    || cloned.kind !== QUEUE_RECOVERY_KIND
    || !boundedString(cloned.queueItemId, MAX_QUEUE_ITEM_ID_BYTES)
    || !fileRefs
    || !cloned.options
    || typeof cloned.options !== "object"
    || Array.isArray(cloned.options)
    || Object.keys(cloned.options).some((key) => !OPTION_KEYS.has(key))
  ) return null;
  return deepFreeze({
    schemaVersion: QUEUE_RECOVERY_SCHEMA_VERSION,
    kind: QUEUE_RECOVERY_KIND,
    queueItemId: cloned.queueItemId,
    fileRefs,
    options: cloned.options,
  });
}

function createQueueRecoveryEnvelope({ item, options }) {
  const fileRefs = safeFileRefs(
    Array.isArray(item?.displayFiles) ? item.displayFiles : [],
  );
  if (!fileRefs) throw new TypeError("queue recovery file references are invalid");
  const normalized = normalizeQueueRecoveryEnvelope({
    schemaVersion: QUEUE_RECOVERY_SCHEMA_VERSION,
    kind: QUEUE_RECOVERY_KIND,
    queueItemId: String(item?.id || ""),
    fileRefs,
    options: options || {},
  });
  if (!normalized) throw new TypeError("failed to create a bounded queue recovery envelope");
  return normalized;
}

module.exports = {
  QUEUE_RECOVERY_KIND,
  QUEUE_RECOVERY_SCHEMA_VERSION,
  createQueueRecoveryEnvelope,
  normalizeQueueRecoveryEnvelope,
};
