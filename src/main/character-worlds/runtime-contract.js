"use strict";

const crypto = require("node:crypto");

const MAX_ID_BYTES = 512;
const MAX_DIAGNOSTIC_BYTES = 256;

function boundedId(value) {
  if (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > MAX_ID_BYTES) return null;
  return value;
}

function cleanDiagnostic(reason, detail = null) {
  const safeReason = typeof reason === "string" && reason ? reason.slice(0, MAX_DIAGNOSTIC_BYTES) : "runtime_fallback";
  const result = { reason: safeReason };
  if (typeof detail === "string" && detail) result.detail = detail.slice(0, MAX_DIAGNOSTIC_BYTES);
  return Object.freeze(result);
}

function clone(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(clone);
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    result[key] = clone(item);
  }
  return result;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}

function fingerprint(value) {
  return crypto.createHash("sha256").update(stable(value), "utf8").digest("hex");
}

function normalizeAdmissionSnapshot(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("snapshot_invalid");
  const ownerScope = boundedId(input.ownerScope);
  const sessionId = boundedId(input.sessionId);
  const turnId = boundedId(input.turnId);
  if (!ownerScope || !sessionId || !turnId) throw new TypeError("identity_invalid");

  const mode = input.mode === "character" ? "character" : "native";
  const binding = clone(input.binding || { mode: "native" });
  if (binding.ownerScope && binding.ownerScope !== ownerScope) throw new TypeError("owner_scope_mismatch");
  if (mode === "character") {
    if (binding.mode !== "character" || !boundedId(binding.characterRevisionId)) throw new TypeError("binding_invalid");
    binding.ownerScope = ownerScope;
  } else {
    binding.mode = "native";
  }
  const scene = input.scene && typeof input.scene === "object" && !Array.isArray(input.scene) ? clone(input.scene) : null;
  const policy = input.policy && typeof input.policy === "object" ? clone(input.policy) : { enabled: false };
  const plannerDecision = input.plannerDecision && typeof input.plannerDecision === "object"
    ? {
        speakers: Array.isArray(input.plannerDecision.speakers)
          ? input.plannerDecision.speakers.map((id) => boundedId(id)).filter(Boolean).slice(0, 8)
          : [],
        strategy: typeof input.plannerDecision.strategy === "string"
          ? input.plannerDecision.strategy.slice(0, 64)
          : "fallback",
      }
    : null;
  const normalized = {
    schemaVersion: 1,
    mode,
    ownerScope,
    sessionId,
    turnId,
    binding,
    scene,
    policy,
    checkpoint: input.checkpoint ? clone(input.checkpoint) : null,
    plannerDecision,
  };
  if (input.diagnostic && typeof input.diagnostic === "object") {
    normalized.diagnostic = cleanDiagnostic(input.diagnostic.reason, input.diagnostic.detail);
  }
  normalized.fingerprint = fingerprint(normalized);
  return deepFreeze(normalized);
}

function nativeSnapshot({ ownerScope = "", sessionId = "", turnId = "", reason = "native", detail = null } = {}) {
  const safeOwner = boundedId(ownerScope) || "device:local";
  const safeSession = boundedId(sessionId) || "unknown-session";
  const safeTurn = boundedId(turnId) || "unknown-turn";
  return normalizeAdmissionSnapshot({
    ownerScope: safeOwner,
    sessionId: safeSession,
    turnId: safeTurn,
    mode: "native",
    binding: { mode: "native" },
    policy: { enabled: false, reason },
    diagnostic: cleanDiagnostic(reason, detail),
  });
}

module.exports = {
  MAX_ID_BYTES,
  boundedId,
  cleanDiagnostic,
  deepFreeze,
  fingerprint,
  nativeSnapshot,
  normalizeAdmissionSnapshot,
  stable,
};
