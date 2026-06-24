"use strict";

const CONTRACT_SCHEMA_VERSION = 1;

const KINDS = new Set(["workflow", "quality", "tool", "connector", "runtime", "router"]);
const RISK_LEVELS = new Set(["low", "medium", "high"]);
const CONFIRMATION_POLICIES = new Set(["none", "before_mutation", "always"]);
const DEFAULT_INPUT_MODES = ["text"];
const DEFAULT_OUTPUT_MODES = ["text"];

function uniqueStrings(value) {
  const values = Array.isArray(value) ? value : [];
  return [...new Set(values.map((item) => String(item || "").trim()).filter(Boolean))];
}

function enumValue(value, allowed, fallback) {
  const normalized = String(value || "").trim();
  return allowed.has(normalized) ? normalized : fallback;
}

function normalizeRisk(raw, fallback = {}) {
  const level = enumValue(raw?.level, RISK_LEVELS, enumValue(fallback.level, RISK_LEVELS, "low"));
  const defaultConfirmation = level === "high" ? "always" : level === "medium" ? "before_mutation" : "none";
  const confirmation = enumValue(
    raw?.confirmation,
    CONFIRMATION_POLICIES,
    enumValue(fallback.confirmation, CONFIRMATION_POLICIES, defaultConfirmation),
  );
  return { level, confirmation };
}

function normalizeVerification(raw, fallback = {}) {
  const methods = uniqueStrings(raw?.methods).length
    ? uniqueStrings(raw.methods)
    : uniqueStrings(fallback.methods);
  return {
    required: Boolean(raw?.required ?? fallback.required ?? false),
    methods,
  };
}

function normalizeFailure(raw, fallback = {}) {
  return {
    recovery: uniqueStrings(raw?.recovery).length
      ? uniqueStrings(raw.recovery)
      : uniqueStrings(fallback.recovery),
  };
}

function normalizeSkillCapabilityContract(raw, fallback = {}) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const risk = normalizeRisk(source.risk, {
    level: fallback.riskLevel || fallback.risk?.level,
    confirmation: fallback.risk?.confirmation,
  });
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: enumValue(source.kind, KINDS, enumValue(fallback.kind || fallback.capabilityLayer, KINDS, "workflow")),
    intents: uniqueStrings(source.intents),
    avoidIntents: uniqueStrings(source.avoidIntents),
    primaryTools: uniqueStrings(source.primaryTools),
    runtimeDependencies: uniqueStrings(source.runtimeDependencies),
    inputModes: uniqueStrings(source.inputModes).length ? uniqueStrings(source.inputModes) : DEFAULT_INPUT_MODES,
    outputModes: uniqueStrings(source.outputModes).length ? uniqueStrings(source.outputModes) : DEFAULT_OUTPUT_MODES,
    risk,
    verification: normalizeVerification(source.verification, fallback.verification),
    failure: normalizeFailure(source.failure, fallback.failure),
  };
}

function isActionableSkillCapabilityContract(contract) {
  return Boolean(
    contract &&
      contract.schemaVersion === CONTRACT_SCHEMA_VERSION &&
      KINDS.has(contract.kind) &&
      Array.isArray(contract.intents) &&
      contract.intents.length > 0 &&
      Array.isArray(contract.inputModes) &&
      contract.inputModes.length > 0 &&
      Array.isArray(contract.outputModes) &&
      contract.outputModes.length > 0 &&
      RISK_LEVELS.has(contract.risk?.level) &&
      CONFIRMATION_POLICIES.has(contract.risk?.confirmation),
  );
}

module.exports = {
  CONTRACT_SCHEMA_VERSION,
  normalizeSkillCapabilityContract,
  isActionableSkillCapabilityContract,
};
