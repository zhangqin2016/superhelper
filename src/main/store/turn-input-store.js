"use strict";

const { types: utilTypes } = require("node:util");
const {
  MAX_CHARACTER_BINDING_BYTES,
} = require("../character-worlds/constants");
const {
  fallbackSnapshot,
  freezeSnapshot,
  normalizeSnapshot,
  readySnapshot,
} = require("../character-worlds/turn-binding-snapshot");
const {
  normalizeQueueRecoveryEnvelope,
} = require("../turn-queue-recovery-envelope");
const {
  TURN_INPUT_MIGRATION_OWNED,
} = require("./turn-admission-migration");
const {
  currentConversationSnapshot,
} = require("./character-worlds-admission-snapshot");

const MAX_TURN_METADATA_BYTES = MAX_CHARACTER_BINDING_BYTES;
const MAX_TURN_METADATA_DEPTH = 12;
const MAX_TURN_METADATA_NODES = 2048;
const INHERITABLE_TURN_STATUSES = new Set([
  "admitted",
  "accepted",
  "dispatching",
  "outcome_unknown",
  "promoted",
  "completed",
  "interrupted",
  "failed",
]);
const DANGEROUS_METADATA_KEYS = new Set([
  "__proto__",
  "prototype",
  "constructor",
  "ownerScope",
  "owner_scope",
]);

function parseJson(text, fallback) {
  try {
    return JSON.parse(text || "");
  } catch {
    return fallback;
  }
}

function stringifyJson(value, fallback) {
  try {
    return JSON.stringify(value ?? fallback);
  } catch {
    return JSON.stringify(fallback);
  }
}

function cloneTurnMetadataResult(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || utilTypes.isProxy(input)) {
    return { ok: false, value: {} };
  }
  const ancestors = new Set();
  let nodes = 0;
  const clone = (value, depth) => {
    nodes += 1;
    if (nodes > MAX_TURN_METADATA_NODES || depth > MAX_TURN_METADATA_DEPTH) {
      throw new TypeError("turn metadata exceeds structural bounds");
    }
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new TypeError("turn metadata number is invalid");
      return value;
    }
    if (typeof value === "string") {
      if (value.length > MAX_TURN_METADATA_BYTES) {
        throw new TypeError("turn metadata string exceeds bounds");
      }
      return value;
    }
    if (!value || typeof value !== "object" || utilTypes.isProxy(value)) {
      throw new TypeError("turn metadata must be plain JSON data");
    }
    if (ancestors.has(value)) throw new TypeError("turn metadata must not contain cycles");
    ancestors.add(value);
    let output;
    if (Array.isArray(value)) {
      if (value.length > MAX_TURN_METADATA_NODES) {
        throw new TypeError("turn metadata array exceeds bounds");
      }
      output = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
          throw new TypeError("turn metadata arrays must be dense values");
        }
        output.push(clone(descriptor.value, depth + 1));
      }
      if (Reflect.ownKeys(value).length !== value.length + 1) {
        throw new TypeError("turn metadata arrays contain unsupported properties");
      }
    } else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError("turn metadata objects must be plain");
      }
      output = {};
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string" || DANGEROUS_METADATA_KEYS.has(key)) {
          throw new TypeError("turn metadata contains a dangerous key");
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
          throw new TypeError("turn metadata properties must be enumerable values");
        }
        output[key] = clone(descriptor.value, depth + 1);
      }
    }
    ancestors.delete(value);
    return output;
  };
  try {
    const value = clone(input, 1);
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_TURN_METADATA_BYTES) {
      return { ok: false, value: {} };
    }
    return { ok: true, value };
  } catch {
    return { ok: false, value: {} };
  }
}

function cloneTurnMetadata(input) {
  return cloneTurnMetadataResult(input).value;
}

function deepFreezeJson(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreezeJson(child);
  return Object.freeze(value);
}

function parseBoundedTurnMetadata(text) {
  if (
    typeof text !== "string"
    || text.length > MAX_TURN_METADATA_BYTES
    || Buffer.byteLength(text, "utf8") > MAX_TURN_METADATA_BYTES
  ) return { ok: false, value: {} };
  let parsed;
  try {
    parsed = JSON.parse(text || "");
  } catch {
    return { ok: false, value: {} };
  }
  return cloneTurnMetadataResult(parsed);
}

function serializeTurnMetadata(
  input,
  characterWorldsSnapshot = null,
  queueRecoveryEnvelope = null,
) {
  const metadata = cloneTurnMetadata(input);
  delete metadata.characterWorlds;
  delete metadata.queueRecovery;
  if (characterWorldsSnapshot) metadata.characterWorlds = characterWorldsSnapshot;
  const queueRecovery = normalizeQueueRecoveryEnvelope(queueRecoveryEnvelope);
  if (queueRecovery) metadata.queueRecovery = queueRecovery;
  let json = JSON.stringify(metadata);
  if (Buffer.byteLength(json, "utf8") <= MAX_TURN_METADATA_BYTES) return json;
  const systemMetadata = {};
  if (characterWorldsSnapshot) systemMetadata.characterWorlds = characterWorldsSnapshot;
  if (queueRecovery) systemMetadata.queueRecovery = queueRecovery;
  json = JSON.stringify(systemMetadata);
  return Buffer.byteLength(json, "utf8") <= MAX_TURN_METADATA_BYTES ? json : "{}";
}

function hydrateTurnMetadata(text) {
  const parsed = parseBoundedTurnMetadata(text);
  if (!parsed.ok) return Object.freeze({});
  const metadata = parsed.value;
  if (Object.hasOwn(metadata, "characterWorlds")) {
    metadata.characterWorlds = freezeSnapshot(metadata.characterWorlds)
      || Object.freeze(fallbackSnapshot());
  }
  if (Object.hasOwn(metadata, "queueRecovery")) {
    const queueRecovery = normalizeQueueRecoveryEnvelope(metadata.queueRecovery);
    if (queueRecovery) metadata.queueRecovery = queueRecovery;
    else delete metadata.queueRecovery;
  }
  return deepFreezeJson(metadata);
}

function mergeTurnMetadata(currentText, patch) {
  const current = hydrateTurnMetadata(currentText);
  const currentSnapshot = current.characterWorlds || null;
  const currentQueueRecovery = current.queueRecovery || null;
  const safePatch = cloneTurnMetadata(patch);
  delete safePatch.characterWorlds;
  delete safePatch.queueRecovery;
  return serializeTurnMetadata(
    { ...current, ...safePatch },
    currentSnapshot,
    currentQueueRecovery,
  );
}

function fallbackOrNativeSnapshot(db, sessionId, ownerScope) {
  const anyBinding = db.get(
    `SELECT 1 AS present FROM character_session_bindings
     WHERE session_id = ? LIMIT 1`,
    sessionId,
  );
  return anyBinding && ownerScope ? fallbackSnapshot() : null;
}

function snapshotCurrentCharacterBinding(db, sessionId, ownerScope) {
  try {
    return currentConversationSnapshot(db, sessionId, ownerScope);
  } catch {
    return fallbackSnapshot();
  }
}

function snapshotInheritedCharacterBinding(db, sessionId, sourceTurnId, ownerScope) {
  if (
    typeof sourceTurnId !== "string"
    || !sourceTurnId
    || typeof ownerScope !== "string"
    || !ownerScope
  ) return fallbackSnapshot();
  try {
    const source = db.get(
      `SELECT status, metadata_json, character_worlds_snapshot_json FROM turn_inputs
       WHERE turn_id = ? AND session_id = ? AND owner_scope = ?
         AND migration_status = ?`,
      sourceTurnId,
      sessionId,
      ownerScope,
      TURN_INPUT_MIGRATION_OWNED,
    );
    if (!source || !INHERITABLE_TURN_STATUSES.has(source.status)) return fallbackSnapshot();
    let normalized = null;
    if (typeof source.character_worlds_snapshot_json === "string") {
      normalized = normalizeSnapshot(parseJson(source.character_worlds_snapshot_json, null));
      if (!normalized) return fallbackSnapshot();
    } else {
      const parsed = parseBoundedTurnMetadata(source.metadata_json);
      if (!parsed.ok) return fallbackSnapshot();
      const metadata = parsed.value;
      if (!Object.hasOwn(metadata, "characterWorlds")) return null;
      normalized = normalizeSnapshot(metadata.characterWorlds);
    }
    if (!normalized) return fallbackSnapshot();
    if (normalized.snapshotStatus === "fallback") return fallbackSnapshot();
    if (!normalized.characterRevisionId) return normalized;
    const revision = db.get(
      `SELECT 1 AS present FROM character_revisions
       WHERE id = ? AND owner_scope = ?`,
      normalized.characterRevisionId,
      ownerScope,
    );
    return revision ? normalized : fallbackSnapshot();
  } catch {
    return fallbackSnapshot();
  }
}

function hydrateTurnInput(row) {
  let metadata = hydrateTurnMetadata(row.metadata_json);
  if (typeof row.character_worlds_snapshot_json === "string") {
    const snapshot = normalizeSnapshot(parseJson(row.character_worlds_snapshot_json, null))
      || fallbackSnapshot();
    metadata = deepFreezeJson({ ...metadata, characterWorlds: snapshot });
  }
  return Object.freeze({
    sessionId: row.session_id,
    admittedSeq: row.admitted_seq,
    turnId: row.turn_id,
    delivery: row.delivery,
    status: row.status,
    userText: row.user_text,
    files: parseJson(row.files_json, []),
    metadata,
    createdAt: row.created_at,
    dispatchAttemptId: row.dispatch_attempt_id || null,
    dispatchStartedAt: row.dispatch_started_at || null,
    acceptedAt: row.accepted_at || null,
    promotedAt: row.promoted_at,
    terminalAt: row.terminal_at,
    terminalType: row.terminal_type || null,
    errorCode: row.error_code || null,
    ownerScope: row.owner_scope || null,
    scheduledTaskRunId: row.scheduled_task_run_id || null,
    externalCommandId: row.external_command_id || null,
    externalIdempotencyKey: row.external_idempotency_key || null,
    externalPayloadHash: row.external_payload_hash || null,
    externalDesktopDeviceId: row.external_desktop_device_id || null,
    externalMobileDeviceId: row.external_mobile_device_id || null,
  });
}

function getTurnInputByTurnId(turnId, ownerScope = null) {
  const owner = typeof ownerScope === "string" && ownerScope ? ownerScope : null;
  const row = this.db.get(
    `SELECT * FROM turn_inputs
     WHERE turn_id = ? AND migration_status = ?
       AND (? IS NULL OR owner_scope = ?)`,
    String(turnId || ""),
    TURN_INPUT_MIGRATION_OWNED,
    owner,
    owner,
  );
  return row ? hydrateTurnInput(row) : null;
}

const dispatchMethods = require("./turn-dispatch-store").createTurnDispatchStoreMethods({
  hydrateTurnInput,
  mergeTurnMetadata,
  normalizeQueueRecoveryEnvelope,
});
const admissionMethods = require("./turn-admission-store").createTurnAdmissionStoreMethods({
  hydrateTurnInput,
  normalizeQueueRecoveryEnvelope,
  serializeTurnMetadata,
  snapshotCurrentCharacterBinding,
  snapshotInheritedCharacterBinding,
  stringifyJson,
});
const terminalMethods = require("./turn-terminal-store").createTurnTerminalStoreMethods({
  hydrateTurnInput,
  mergeTurnMetadata,
});

module.exports = {
  ...admissionMethods,
  ...dispatchMethods,
  ...terminalMethods,
  getTurnInputByTurnId,
};
