"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { agentConfigDir } = require("./config");
const { resolveRuntimeNodePath } = require("./runtime-node");
const skillManager = require("./skill-manager");

function bundledResourceCandidates(relativePath) {
  const { PROJECT_ROOT } = require("./config");
  return [
    path.join(process.resourcesPath, relativePath),
    path.join(PROJECT_ROOT, relativePath),
  ].find((p) => fs.existsSync(p));
}

function readBundledFile(relativePath) {
  const found = bundledResourceCandidates(relativePath);
  if (!found) return null;
  return fs.readFileSync(found, "utf8");
}

function readBundledSettingsEnv() {
  const raw = readBundledFile("resources/agent-defaults/settings.json");
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed?.env && typeof parsed.env === "object" ? parsed.env : {};
  } catch {
    return {};
  }
}

/** Resolve env key from user settings, bundled defaults, then process.env. */
function resolveSettingsEnvValue(...keys) {
  const userEnv = loadSettingsEnv();
  for (const key of keys) {
    const value = String(userEnv[key] || "").trim();
    if (value) return value;
  }
  const bundledEnv = readBundledSettingsEnv();
  for (const key of keys) {
    const value = String(bundledEnv[key] || "").trim();
    if (value) return value;
  }
  for (const key of keys) {
    const value = String(process.env[key] || "").trim();
    if (value) return value;
  }
  return "";
}

function ensureSettingsPresent() {
  const settingsPath = path.join(agentConfigDir(), "settings.json");
  const bundledSettings = readBundledFile("resources/agent-defaults/settings.json");
  if (!bundledSettings) return false;

  if (!fs.existsSync(settingsPath)) {
    fs.mkdirSync(agentConfigDir(), { recursive: true });
    fs.writeFileSync(settingsPath, bundledSettings, "utf8");
    return true;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const bundled = JSON.parse(bundledSettings);
    const env = raw?.env && typeof raw.env === "object" ? raw.env : {};
    const bundledEnv = bundled?.env && typeof bundled.env === "object" ? bundled.env : {};
    let changed = false;
    for (const key of [
      "IQS_API_KEY",
      "WEBSEARCH_IQS_API_KEY",
      "DASHSCOPE_API_KEY",
      "VISION_API_KEY",
      "DASHSCOPE_BASE_URL",
      "VISION_MODEL",
    ]) {
      const bundledVal = String(bundledEnv[key] || "").trim();
      const currentVal = String(env[key] || "").trim();
      if (bundledVal && !currentVal) {
        env[key] = bundledVal;
        changed = true;
      }
    }
    if (changed) {
      raw.env = env;
      fs.writeFileSync(settingsPath, JSON.stringify(raw, null, 2), "utf8");
    }
  } catch {
    // keep existing file if merge fails
  }
  return false;
}

function loadSettingsEnv() {
  const settingsPath = path.join(agentConfigDir(), "settings.json");
  try {
    if (!fs.existsSync(settingsPath)) return {};
    const raw = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const env = raw?.env && typeof raw.env === "object" ? { ...raw.env } : {};
    const { normalizeToLilyEnv } = require("./agent-env");
    return normalizeToLilyEnv(env);
  } catch {
    return {};
  }
}

function installAgentDefaults() {
  fs.mkdirSync(agentConfigDir(), { recursive: true });

  const settingsInstalled = ensureSettingsPresent();
  const { installed } = skillManager.bootstrapSkills();

  return {
    settingsInstalled,
    skills: installed,
    runtimeNode: resolveRuntimeNodePath(),
    disallowedTools: skillManager.getDisallowedTools(),
  };
}

module.exports = {
  loadSettingsEnv,
  readBundledSettingsEnv,
  resolveSettingsEnvValue,
  installAgentDefaults,
  getDefaultDisallowedTools: skillManager.getDisallowedTools,
};
