"use strict";

const crypto = require("node:crypto");

const MAX_COMPONENTS = 256;
const MAX_EFFECTS = 512;

function codedError(code, message = code) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

function bounded(value, name, max = 256) {
  const text = String(value || "").trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) {
    throw codedError("RUNTIME_CHECKPOINT_FIELD_INVALID", name);
  }
  return text;
}

function optional(value, name, max = 256) {
  if (value == null || value === "") return "";
  return bounded(value, name, max);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeComponent(input = {}) {
  const hash = bounded(input.hash, "component.hash", 64).toLowerCase();
  const version = Math.floor(Number(input.version ?? 1));
  if (!/^[a-f0-9]{64}$/.test(hash) || version < 1) {
    throw codedError("RUNTIME_CHECKPOINT_COMPONENT_INVALID");
  }
  return {
    type: bounded(input.type, "component.type", 80),
    refId: bounded(input.refId, "component.refId"),
    version,
    hash,
    reversible: input.reversible === true,
  };
}

function normalizeEffect(input = {}) {
  return {
    tool: bounded(input.tool || "unknown", "effect.tool", 120),
    refId: bounded(input.refId, "effect.refId"),
    reversible: input.reversible === true,
    status: bounded(input.status || "observed", "effect.status", 80),
    compensationRef: optional(input.compensationRef, "effect.compensationRef"),
  };
}

function sortRecords(records) {
  return records.sort((a, b) => `${a.type || a.tool}:${a.refId}`.localeCompare(`${b.type || b.tool}:${b.refId}`));
}

function checkpointHash(value) {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function createRuntimeCheckpointManifest(input = {}) {
  const components = Array.isArray(input.components) ? input.components : [];
  const effects = Array.isArray(input.effects) ? input.effects : [];
  if (components.length > MAX_COMPONENTS || effects.length > MAX_EFFECTS) {
    throw codedError("RUNTIME_CHECKPOINT_LIMIT_EXCEEDED");
  }
  const createdAt = Math.floor(Number(input.createdAt ?? Date.now()));
  if (!Number.isFinite(createdAt) || createdAt < 0) throw codedError("RUNTIME_CHECKPOINT_FIELD_INVALID", "createdAt");
  const manifest = {
    schemaVersion: 1,
    id: bounded(input.id || `checkpoint_${crypto.randomUUID()}`, "id"),
    parentCheckpointId: optional(input.parentCheckpointId, "parentCheckpointId"),
    sessionId: bounded(input.sessionId, "sessionId"),
    turnId: bounded(input.turnId, "turnId"),
    taskRunId: optional(input.taskRunId, "taskRunId"),
    engineSessionId: optional(input.engineSessionId, "engineSessionId"),
    engineMessageId: optional(input.engineMessageId, "engineMessageId"),
    kind: bounded(input.kind || "turn", "kind", 80),
    eventSeq: Math.max(0, Math.floor(Number(input.eventSeq || 0))),
    components: sortRecords(components.map(normalizeComponent)),
    effects: sortRecords(effects.map(normalizeEffect)),
    createdAt,
  };
  return Object.freeze({ ...manifest, integrityHash: checkpointHash(manifest) });
}

function verifyRuntimeCheckpointManifest(input = {}) {
  try {
    const expected = String(input.integrityHash || "");
    const normalized = createRuntimeCheckpointManifest(input);
    return {
      ok: expected.length === 64 && normalized.integrityHash === expected,
      manifest: normalized,
      error: normalized.integrityHash === expected ? "" : "RUNTIME_CHECKPOINT_INTEGRITY_MISMATCH",
    };
  } catch (error) {
    return { ok: false, manifest: null, error: error?.code || "RUNTIME_CHECKPOINT_INVALID" };
  }
}

function restorePlanForCheckpoint(manifest) {
  const verification = verifyRuntimeCheckpointManifest(manifest);
  if (!verification.ok) throw codedError(verification.error || "RUNTIME_CHECKPOINT_INVALID");
  const reversibleComponents = verification.manifest.components.filter((component) => component.reversible);
  const unresolvedEffects = verification.manifest.effects.filter((effect) => !effect.reversible || !effect.compensationRef);
  return {
    checkpointId: verification.manifest.id,
    sessionId: verification.manifest.sessionId,
    reversibleComponents,
    unresolvedEffects,
    requiresConfirmation: unresolvedEffects.length > 0,
  };
}

module.exports = {
  checkpointHash,
  createRuntimeCheckpointManifest,
  restorePlanForCheckpoint,
  verifyRuntimeCheckpointManifest,
};
