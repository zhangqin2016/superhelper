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
 *   recycle — the serve is rebuilt from the new config and the conversation
 *             moves to it keeping its resume id. An engine session is not bound
 *             to a model: every message records its own, every prompt names
 *             the model it runs on, and the engine itself switches models
 *             mid-session. So a credential rotation AND a model switch keep
 *             the conversation — the user chose both models, and auto mode
 *             routing a turn to the other one used to wipe the engine context
 *             down to a 12K local rebuild (2026-09-28 audit). A smaller window
 *             is handled by overflow compaction, not by discarding history.
 *   restart — only with LILY_MODEL_SWITCH_KEEPS_CONVERSATION=0: the previous
 *             rule, a model/route change discards the resume id.
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
  if (process.env.LILY_MODEL_SWITCH_KEEPS_CONVERSATION === "0") {
    return { action: "restart", from, to, reason: "model_changed" };
  }
  return { action: "recycle", from, to, reason: "model_changed" };
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
