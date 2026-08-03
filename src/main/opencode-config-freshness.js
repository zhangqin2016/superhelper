"use strict";

const crypto = require("node:crypto");

function shortHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function configFingerprints(configContent = "") {
  try {
    const parsed = JSON.parse(String(configContent || "{}"));
    const agentModels = {};
    for (const [name, agent] of Object.entries(parsed.agent || {})) {
      if (agent && typeof agent === "object" && agent.model) agentModels[name] = agent.model;
    }
    return {
      modelConfigFingerprint: shortHash({
        model: parsed.model || "",
        small_model: parsed.small_model || "",
        provider: parsed.provider || {},
        agentModels,
      }),
      toolConfigFingerprint: shortHash(parsed.mcp || {}),
    };
  } catch {
    return { modelConfigFingerprint: "", toolConfigFingerprint: "" };
  }
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
    const providerOptions = Object.keys(providerCfg?.options || {})
      .filter((key) => !/key|token|authorization/i.test(key))
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

module.exports = { configFingerprints, modelConfigDiagnostics, toolConfigChanged };
