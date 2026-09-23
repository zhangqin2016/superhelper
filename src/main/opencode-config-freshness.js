"use strict";

const crypto = require("node:crypto");
const { isSecretKey, redactSecrets } = require("./runtime/engine-config-facts");

function shortHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

/**
 * Two fingerprints over the same config, answering two different questions.
 *
 * `modelConfigFingerprint` covers the config VERBATIM: any difference at all
 * means the running engine — which reads its config once, at boot — is no
 * longer the engine this config describes, so the session has to move to one
 * that is.
 *
 * `routeConfigFingerprint` covers the same config with credentials redacted:
 * it answers the narrower question "is this still the same model, reached the
 * same way?". A rotating gateway token changes the first and not the second,
 * which is what lets the caller move the session WITHOUT tearing the
 * conversation down (2026-09-23: an hourly token rotation was indistinguishable
 * from the operator switching models, and cost the resume id every time).
 */
function configFingerprints(configContent = "") {
  try {
    const parsed = JSON.parse(String(configContent || "{}"));
    const agentModels = {};
    for (const [name, agent] of Object.entries(parsed.agent || {})) {
      if (agent && typeof agent === "object" && agent.model) agentModels[name] = agent.model;
    }
    const modelShape = {
      model: parsed.model || "",
      small_model: parsed.small_model || "",
      provider: parsed.provider || {},
      agentModels,
    };
    return {
      modelConfigFingerprint: shortHash(modelShape),
      routeConfigFingerprint: shortHash(redactSecrets(modelShape)),
      toolConfigFingerprint: shortHash(parsed.mcp || {}),
    };
  } catch {
    return { modelConfigFingerprint: "", routeConfigFingerprint: "", toolConfigFingerprint: "" };
  }
}

/**
 * What a config change means for the engine session currently running.
 *
 * The engine reads its config once, at boot, so ANY difference means this
 * session has to move to a serve built from the new config. The question this
 * answers is what that move costs:
 *
 *   restart — the model or the way it is reached actually changed. The old
 *             conversation state belongs to a different model, so a fresh
 *             engine session is correct and the resume id goes with it.
 *   recycle — the same model reached the same way, differing only in a
 *             credential. The conversation is still valid; it moves to the new
 *             serve keeping its resume id.
 *
 * Falls back to `restart` whenever the route comparison cannot be made, so an
 * absent or unreadable route fingerprint reproduces the previous behaviour.
 *
 * @returns {{ action: "none"|"restart"|"recycle", from?: string, to?: string, reason?: string }}
 */
function modelConfigTransition(session, options = {}, previousOptions = {}) {
  if (!session?._server || session.busy) return { action: "none" };
  const to = String(options.modelConfigFingerprint || "");
  const active = String(session._activeModelConfigFingerprint || "");
  // With no active fingerprint the only reference point is what the previous
  // spawn asked for — the pre-existing second branch of this decision.
  const from = active || String(previousOptions.modelConfigFingerprint || "");
  if (!to || !from || to === from) return { action: "none" };

  const nextRoute = String(options.routeConfigFingerprint || "");
  const fromRoute = active
    ? String(session._activeRouteConfigFingerprint || "")
    : String(previousOptions.routeConfigFingerprint || "");
  if (nextRoute && fromRoute && nextRoute === fromRoute) {
    return { action: "recycle", from, to, reason: "credential_rotated" };
  }
  return { action: "restart", from, to, reason: "model_changed" };
}

function toolConfigChanged(session, options = {}, previousOptions = {}) {
  if (!session?._server || session.busy) return false;
  const next = String(options.toolConfigFingerprint || "");
  const active = String(session._activeToolConfigFingerprint || "");
  const previous = String(previousOptions.toolConfigFingerprint || "");
  if (!next) return false;
  return active ? next !== active : Boolean(previous && next !== previous);
}

function modelConfigDiagnostics(configContent = "") {
  try {
    const parsed = JSON.parse(String(configContent || "{}"));
    const modelRef = String(parsed.model || "");
    const slash = modelRef.indexOf("/");
    const provider = slash >= 0 ? modelRef.slice(0, slash) : "";
    const model = slash >= 0 ? modelRef.slice(slash + 1) : modelRef;
    const providerCfg = provider ? parsed.provider?.[provider] || null : null;
    const modelCfg = providerCfg?.models?.[model] || null;
    // Same secret rule the route fingerprint uses, so what the log shows and
    // what the restart decision ignores can never drift apart again.
    const providerOptions = Object.keys(providerCfg?.options || {})
      .filter((key) => !isSecretKey(key))
      .sort();
    const modelOptions = Object.keys(modelCfg?.options || {}).sort();
    return {
      model: modelRef,
      provider,
      providerOptions: providerOptions.length ? providerOptions.join(",") : "-",
      modelOptions: modelOptions.length ? modelOptions.join(",") : "-",
    };
  } catch {
    return null;
  }
}

module.exports = { configFingerprints, modelConfigDiagnostics, modelConfigTransition, toolConfigChanged };
