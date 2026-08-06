"use strict";

const crypto = require("node:crypto");
const RUNTIME_CONTRACT = require("../shared/runtime-contract.json");

const RUNTIME_EVENT_SCHEMA_VERSION = RUNTIME_CONTRACT.schemaVersion;
const TERMINAL_EVENT_TYPES = new Set(RUNTIME_CONTRACT.terminalEventTypes);

const USER_BLOCKING_EVENT_TYPES = new Set(RUNTIME_CONTRACT.userBlockingEventTypes);

const RUNTIME_EVENT_TYPES = new Set(RUNTIME_CONTRACT.eventTypes);

const TURN_OPTIONAL_TYPES = new Set(RUNTIME_CONTRACT.turnOptionalEventTypes);

function payloadValueMatchesType(value, expectedType) {
  if (expectedType === "array") return Array.isArray(value);
  if (expectedType === "object") return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  if (expectedType === "integer") return Number.isInteger(value);
  if (expectedType === "number") return Number.isFinite(value);
  return typeof value === expectedType;
}

function assertRuntimePayload(type, payload) {
  const contract = RUNTIME_CONTRACT.payloadContracts?.[type];
  if (!contract) return true;
  for (const key of contract.required || []) {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) {
      throw new Error(`RuntimeEvent ${type} payload requires ${key}`);
    }
  }
  for (const [key, expectedType] of Object.entries(contract.properties || {})) {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) continue;
    if (!payloadValueMatchesType(payload[key], expectedType)) {
      throw new Error(`RuntimeEvent ${type} payload.${key} must be ${expectedType}`);
    }
  }
  if (type === "character.application") {
    const allowedKeys = new Set(Object.keys(contract.properties || {}));
    const statuses = new Set(["native", "applied", "bypassed"]);
    const reasons = new Set([
      "policy_disabled",
      "snapshot_not_ready",
      "revision_missing",
      "identity_missing",
      "budget_zero",
      "provider_unsupported",
      "activation_invalid",
      "prompt_budget_exhausted",
      "request_build_failed",
    ]);
    const profiles = new Set(["immersive", "balanced", "task_preserving"]);
    const fingerprint = /^sha256:[0-9a-f]{64}$/;
    if (!statuses.has(payload.status)) throw new Error("Invalid character application status");
    if (Object.keys(payload).some((key) => !allowedKeys.has(key))) {
      throw new Error("Invalid character application metadata");
    }
    if (payload.reason !== undefined && !reasons.has(payload.reason)) {
      throw new Error("Invalid character application reason");
    }
    if (payload.expressionProfile !== undefined && !profiles.has(payload.expressionProfile)) {
      throw new Error("Invalid character application profile");
    }
    for (const key of ["activationFingerprint", "narrativeFingerprint"]) {
      if (payload[key] !== undefined && !fingerprint.test(payload[key])) {
        throw new Error("Invalid character application fingerprint");
      }
    }
  }
  return true;
}

function createRuntimeEvent(input) {
  const type = String(input?.type || "");
  if (!type) throw new Error("RuntimeEvent type is required");
  if (!RUNTIME_EVENT_TYPES.has(type)) throw new Error(`Unknown RuntimeEvent type: ${type}`);
  const sessionId = String(input?.sessionId || "");
  if (!sessionId) throw new Error(`RuntimeEvent ${type} requires sessionId`);
  const turnId = input?.turnId == null ? null : String(input.turnId);
  if (!turnId && !TURN_OPTIONAL_TYPES.has(type)) {
    throw new Error(`RuntimeEvent ${type} requires turnId`);
  }

  const event = {
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    id: input.id || `evt_${crypto.randomUUID()}`,
    type,
    sessionId,
    turnId,
    seq: Number.isInteger(input.seq) ? input.seq : 0,
    ts: Number.isFinite(input.ts) ? input.ts : Date.now(),
    source: input.source || "runtime",
    payload: input.payload && typeof input.payload === "object" ? input.payload : {},
  };
  for (const key of ["ownerScope", "projectId", "taskId", "attemptId"]) {
    if (typeof input[key] === "string" && input[key]) event[key] = input[key];
  }
  assertRuntimeEvent(event);
  return event;
}

function assertRuntimeEvent(event) {
  if (!event || typeof event !== "object") throw new Error("Invalid RuntimeEvent");
  if (!event.id || typeof event.id !== "string") throw new Error("RuntimeEvent id is required");
  if (!event.type || typeof event.type !== "string") throw new Error("RuntimeEvent type is required");
  if (!RUNTIME_EVENT_TYPES.has(event.type)) throw new Error(`Unknown RuntimeEvent type: ${event.type}`);
  if (!event.sessionId || typeof event.sessionId !== "string") throw new Error("RuntimeEvent sessionId is required");
  if (!Number.isInteger(event.seq)) throw new Error("RuntimeEvent seq must be an integer");
  if (!Number.isFinite(event.ts)) throw new Error("RuntimeEvent ts must be a timestamp");
  if (!event.payload || typeof event.payload !== "object") throw new Error("RuntimeEvent payload must be an object");
  for (const key of ["ownerScope", "projectId", "taskId", "attemptId"]) {
    if (event[key] !== undefined && (typeof event[key] !== "string" || !event[key])) {
      throw new Error(`RuntimeEvent ${key} must be a non-empty string when present`);
    }
  }
  const schemaVersion = Number(event.schemaVersion || RUNTIME_EVENT_SCHEMA_VERSION);
  if (schemaVersion !== RUNTIME_EVENT_SCHEMA_VERSION) {
    throw new Error(`Unsupported RuntimeEvent schemaVersion: ${schemaVersion}`);
  }
  if (!event.turnId && !TURN_OPTIONAL_TYPES.has(event.type)) {
    throw new Error(`RuntimeEvent ${event.type} requires turnId`);
  }
  assertRuntimePayload(event.type, event.payload);
  return true;
}

function isTerminalEvent(event) {
  return TERMINAL_EVENT_TYPES.has(event?.type);
}

function isUserBlockingEvent(event) {
  return USER_BLOCKING_EVENT_TYPES.has(event?.type);
}

module.exports = {
  RUNTIME_EVENT_SCHEMA_VERSION,
  TERMINAL_EVENT_TYPES,
  USER_BLOCKING_EVENT_TYPES,
  RUNTIME_EVENT_TYPES,
  createRuntimeEvent,
  assertRuntimeEvent,
  assertRuntimePayload,
  isTerminalEvent,
  isUserBlockingEvent,
};
