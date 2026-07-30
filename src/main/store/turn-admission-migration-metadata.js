"use strict";

const {
  normalizeSnapshot,
} = require("../character-worlds/turn-binding-snapshot");

const MIGRATION_METADATA_SCHEMA_VERSION = 1;
const MAX_MIGRATION_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_MIGRATION_STRING_BYTES = 1024 * 1024;
const MAX_MIGRATION_METADATA_DEPTH = 12;
const MAX_MIGRATION_METADATA_NODES = 8192;
const MAX_ADMISSION_KEY_BYTES = 512;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function strictUtf8(value, maxBytes) {
  if (typeof value !== "string" || value.length > maxBytes) return false;
  const bytes = Buffer.from(value, "utf8");
  return bytes.length <= maxBytes && bytes.toString("utf8") === value;
}

function boundedKey(value) {
  return strictUtf8(value, MAX_ADMISSION_KEY_BYTES) && value ? value : null;
}

function parseMigrationMetadata(text) {
  if (
    typeof text !== "string"
    || text.length > MAX_MIGRATION_METADATA_BYTES
  ) return { status: "metadata_oversize", value: null };
  const encoded = Buffer.from(text, "utf8");
  if (encoded.length > MAX_MIGRATION_METADATA_BYTES) {
    return { status: "metadata_oversize", value: null };
  }
  if (encoded.toString("utf8") !== text) {
    return { status: "metadata_invalid_utf8", value: null };
  }
  let root;
  try {
    root = JSON.parse(text);
  } catch {
    return { status: "metadata_corrupt", value: null };
  }
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    return { status: "metadata_invalid", value: null };
  }
  const stack = [{ value: root, depth: 1 }];
  let nodes = 0;
  while (stack.length) {
    const { value, depth } = stack.pop();
    nodes += 1;
    if (
      nodes > MAX_MIGRATION_METADATA_NODES
      || depth > MAX_MIGRATION_METADATA_DEPTH
    ) return { status: "metadata_invalid", value: null };
    if (
      value === null
      || typeof value === "boolean"
      || (typeof value === "number" && Number.isFinite(value))
    ) continue;
    if (typeof value === "string") {
      if (!strictUtf8(value, MAX_MIGRATION_STRING_BYTES)) {
        return { status: "metadata_invalid", value: null };
      }
      continue;
    }
    if (!value || typeof value !== "object") {
      return { status: "metadata_invalid", value: null };
    }
    const prototype = Object.getPrototypeOf(value);
    if (
      !Array.isArray(value)
      && prototype !== Object.prototype
      && prototype !== null
    ) return { status: "metadata_invalid", value: null };
    for (const key of Object.keys(value)) {
      if (
        DANGEROUS_KEYS.has(key)
        || !strictUtf8(key, MAX_MIGRATION_STRING_BYTES)
      ) return { status: "metadata_invalid", value: null };
      stack.push({ value: value[key], depth: depth + 1 });
    }
  }
  return { status: "ok", value: root };
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function candidateFacts(values) {
  const provided = values.filter((value) => value !== null && value !== undefined);
  return {
    values: [...new Set(provided.map(boundedKey).filter(Boolean))],
    present: provided.length > 0,
    invalid: provided.some((value) => !boundedKey(value)),
  };
}

function firstOrNull(values) {
  return values.length === 1 ? values[0] : null;
}

function legacyAdmissionFacts(metadataText) {
  const parsed = parseMigrationMetadata(metadataText);
  if (!parsed.value) {
    return {
      metadataStatus: parsed.status,
      scheduledTaskRunId: null,
      scheduledTaskRunIds: [],
      scheduledTaskId: null,
      scheduledHint: false,
      externalCommandId: null,
      externalCommandIds: [],
      externalIdempotencyKey: null,
      externalPayloadHash: null,
      externalHint: false,
      identityConflict: false,
      characterRevisionId: null,
    };
  }
  const metadata = parsed.value;
  const recovery = plainObject(metadata.queueRecovery)
    && [1, 2].includes(metadata.queueRecovery.schemaVersion)
    && metadata.queueRecovery.kind === "durable_queue"
    && plainObject(metadata.queueRecovery.options)
    ? metadata.queueRecovery
    : null;
  const options = recovery?.options || {};
  const external = plainObject(options.externalCommand)
    ? options.externalCommand
    : {};
  const scheduledRuns = candidateFacts([
    metadata.scheduledTaskRunId,
    options.scheduledTaskRunId,
  ]);
  const scheduledTasks = candidateFacts([
    metadata.scheduledTaskId,
    options.scheduledTaskId,
  ]);
  const externalCommands = candidateFacts([
    metadata.externalCommandId,
    metadata.commandId,
    external.commandId,
  ]);
  const externalIdempotency = candidateFacts([
    metadata.externalIdempotencyKey,
    metadata.idempotencyKey,
    external.idempotencyKey,
  ]);
  const externalPayloads = candidateFacts([
    metadata.externalPayloadHash,
    metadata.payloadHash,
    external.payloadHash,
  ]);
  const externalDesktopDevices = candidateFacts([
    metadata.externalDesktopDeviceId,
    metadata.desktopDeviceId,
    external.desktopDeviceId,
  ]);
  const externalMobileDevices = candidateFacts([
    metadata.externalMobileDeviceId,
    metadata.mobileDeviceId,
    external.mobileDeviceId,
  ]);
  const scheduledTaskRunIds = scheduledRuns.values;
  const scheduledTaskIds = scheduledTasks.values;
  const externalCommandIds = externalCommands.values;
  const externalIdempotencyKeys = externalIdempotency.values;
  const externalPayloadHashes = externalPayloads.values;
  const externalDesktopDeviceIds = externalDesktopDevices.values;
  const externalMobileDeviceIds = externalMobileDevices.values;
  const snapshot = normalizeSnapshot(metadata.characterWorlds);
  return {
    metadataStatus: parsed.status,
    scheduledTaskRunId: firstOrNull(scheduledTaskRunIds),
    scheduledTaskRunIds,
    scheduledTaskId: firstOrNull(scheduledTaskIds),
    scheduledHint: scheduledRuns.present
      || scheduledTasks.present
      || metadata.queueOrigin === "scheduled_task"
      || options.queueOrigin === "scheduled_task",
    externalCommandId: firstOrNull(externalCommandIds),
    externalCommandIds,
    externalIdempotencyKey: firstOrNull(externalIdempotencyKeys),
    externalPayloadHash: firstOrNull(externalPayloadHashes),
    externalDesktopDeviceId: firstOrNull(externalDesktopDeviceIds),
    externalMobileDeviceId: firstOrNull(externalMobileDeviceIds),
    externalHint: externalCommands.present,
    identityConflict: scheduledRuns.invalid
      || scheduledTasks.invalid
      || externalCommands.invalid
      || externalIdempotency.invalid
      || externalPayloads.invalid
      || externalDesktopDevices.invalid
      || externalMobileDevices.invalid
      || scheduledTaskRunIds.length > 1
      || scheduledTaskIds.length > 1
      || externalCommandIds.length > 1
      || externalIdempotencyKeys.length > 1
      || externalPayloadHashes.length > 1
      || externalDesktopDeviceIds.length > 1
      || externalMobileDeviceIds.length > 1,
    characterRevisionId: snapshot?.snapshotStatus === "ready"
      ? snapshot.characterRevisionId
      : null,
  };
}

module.exports = {
  MAX_MIGRATION_METADATA_BYTES,
  MIGRATION_METADATA_SCHEMA_VERSION,
  legacyAdmissionFacts,
  parseMigrationMetadata,
};
