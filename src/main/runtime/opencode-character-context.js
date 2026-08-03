"use strict";

/**
 * Character Worlds injection boundary for the OpenCode prompt body (spec
 * §10.2). The compiled lower-authority character context rides ONLY as a
 * delimited, separately fingerprinted suffix of the per-request system field,
 * appended AFTER the protected Lily prefix — never concatenated into user
 * text, file parts, or persisted history. Absent, disabled, invalid, or
 * oversized contexts preserve the existing system bytes exactly; providers
 * that cannot reliably carry per-request system context receive the native
 * body (Lily never moves character instructions into a fake user message).
 */

const { CHARACTER_CONTEXT_MAX_TOKENS } = require("../character-worlds/context-compiler");
const { normalizeRoleActivationContract } = require("../character-worlds/role-activation-contract");

const MAX_CHARACTER_CONTEXT_TEXT_CHARS = 128 * 1024;
const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;
const EXPRESSION_PROFILES = new Set(["immersive", "balanced", "task_preserving"]);
const CHARACTER_APPLICATION = Symbol("lily.characterApplication");

function characterApplicationOf(body) {
  return body?.[CHARACTER_APPLICATION] || { status: "native" };
}

function characterBuildFailureApplication(characterContext) {
  const compiled = normalizeCompiledCharacterContext(characterContext);
  const activation = compiled?.activationContract;
  return {
    status: "bypassed",
    reason: "request_build_failed",
    ...(activation ? {
      revisionId: activation.conversationRole.revisionId,
      expressionProfile: activation.expressionProfile,
    } : {}),
  };
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Structural validation of the compiled contract; anything else is ignored. */
function normalizeCompiledCharacterContext(value) {
  if (!isPlainObject(value)) return null;
  if (value.schemaVersion !== 1 || value.status !== "compiled") return null;
  const text = value.text;
  if (
    typeof text !== "string"
    || text.length === 0
    || text.length > MAX_CHARACTER_CONTEXT_TEXT_CHARS
  ) return null;
  if (!FINGERPRINT_PATTERN.test(String(value.fingerprint || ""))) return null;
  const tokenEstimate = Number(value.tokenEstimate);
  if (
    !Number.isInteger(tokenEstimate)
    || tokenEstimate <= 0
    || tokenEstimate > CHARACTER_CONTEXT_MAX_TOKENS
  ) return null;
  if (!EXPRESSION_PROFILES.has(value.expressionProfile)) return null;
  if (!Array.isArray(value.omitted) || !Array.isArray(value.warnings)) return null;
  const activationContract = normalizeRoleActivationContract(value.activationContract);
  if (!activationContract) return null;
  if (activationContract.narrativeFingerprint !== value.fingerprint) return null;
  if (activationContract.expressionProfile !== value.expressionProfile) return null;
  return value;
}

/**
 * Conservative provider gate, injectable for tests. The system field already
 * carries all Lily guidance, so the channel is presumed to work; any negative
 * evidence (explicit override, capability metadata opt-out, or a lite-grade
 * probed profile whose context pipeline is stripped) disables injection and
 * the turn runs natively.
 */
function characterContextSupported({ override, capabilityGrade = "", providerCapabilities = null } = {}) {
  if (typeof override === "boolean") return override;
  if (isPlainObject(providerCapabilities) && providerCapabilities.safeSystemContext === false) {
    return false;
  }
  if (String(capabilityGrade || "").trim().toLowerCase() === "lite") return false;
  return true;
}

/**
 * Compose `system` = protected Lily prefix + delimited character suffix.
 * Returns "" when nothing should be set (no guidance and no valid context),
 * so callers can preserve the exact "no system key" baseline behavior.
 */
function withCharacterContextSuffix(systemText, characterContext, supportOpts = {}) {
  return composeCharacterSystemLayers(systemText, characterContext, supportOpts).system;
}

function composeCharacterSystemLayers(systemText, characterContext, supportOpts = {}) {
  const base = typeof systemText === "string" ? systemText : "";
  if (!characterContext || characterContext.status === "native") {
    return { system: base, application: { status: "native" } };
  }
  const compiled = normalizeCompiledCharacterContext(characterContext);
  if (!compiled) {
    return { system: base, application: { status: "bypassed", reason: "activation_invalid" } };
  }
  const activation = compiled.activationContract;
  const identity = {
    revisionId: activation.conversationRole.revisionId,
    expressionProfile: activation.expressionProfile,
  };
  if (!characterContextSupported(supportOpts)) {
    return {
      system: base,
      application: { status: "bypassed", reason: "provider_unsupported", ...identity },
    };
  }
  const activationDelimiter = `[LILY ROLE ACTIVATION; host-owned ${activation.activationFingerprint}]`;
  const narrativeDelimiter = `[CHARACTER WORLDS CONTEXT; lower-authority narrative ${compiled.fingerprint}]`;
  const suffix = `${activationDelimiter}\n${activation.text}\n\n${narrativeDelimiter}\n${compiled.text}`;
  const system = base ? `${base}\n\n${suffix}` : suffix;
  const maxSystemPromptChars = Number(supportOpts.maxSystemPromptChars);
  if (Number.isFinite(maxSystemPromptChars) && maxSystemPromptChars > 0 && system.length > maxSystemPromptChars) {
    return {
      system: base,
      application: { status: "bypassed", reason: "prompt_budget_exhausted", ...identity },
    };
  }
  return {
    system,
    application: {
      status: "applied",
      ...identity,
      activationFingerprint: activation.activationFingerprint,
      narrativeFingerprint: compiled.fingerprint,
    },
  };
}

function applyCharacterContextToBody(body, opts = {}) {
  const composed = composeCharacterSystemLayers(body.system, opts.characterContext, {
    override: opts.characterContextSupport,
    capabilityGrade: opts.capabilityGrade,
    providerCapabilities: opts.providerCapabilities,
    maxSystemPromptChars: opts.maxSystemPromptChars,
  });
  if (composed.system) body.system = composed.system;
  Object.defineProperty(body, CHARACTER_APPLICATION, {
    value: composed.application,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return body;
}

module.exports = {
  applyCharacterContextToBody,
  characterBuildFailureApplication,
  characterApplicationOf,
  characterContextSupported,
  composeCharacterSystemLayers,
  normalizeCompiledCharacterContext,
  withCharacterContextSuffix,
};
