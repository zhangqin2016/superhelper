"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");
const { PROJECT_ROOT, userDataPath } = require("./config");

/** @type {{ activePresetId: string, presets: Array<{id:string,label:string,description?:string,env:Record<string,string>}> } | null} */
let cachedCatalog = null;
/** @type {{ activePresetId: string } | null} */
let cachedUserChoice = null;

function defaultCatalogPath() {
  return [
    path.join(process.resourcesPath, "resources", "models.default.json"),
    path.join(PROJECT_ROOT, "resources", "models.default.json"),
  ].find((p) => fs.existsSync(p)) || path.join(PROJECT_ROOT, "resources", "models.default.json");
}

function userSettingsPath() {
  return userDataPath("model-settings.json");
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function loadCatalog() {
  if (cachedCatalog) return cachedCatalog;
  const raw = readJson(defaultCatalogPath(), { activePresetId: "standard", presets: [] });
  cachedCatalog = {
    activePresetId: raw.activePresetId || "standard",
    presets: Array.isArray(raw.presets) ? raw.presets : [],
  };
  return cachedCatalog;
}

function loadUserChoice() {
  if (cachedUserChoice) return cachedUserChoice;
  cachedUserChoice = readJson(userSettingsPath(), null);
  return cachedUserChoice;
}

function getActivePresetId() {
  const user = loadUserChoice();
  if (user?.activePresetId) return user.activePresetId;
  return loadCatalog().activePresetId || "standard";
}

function getActivePreset() {
  const catalog = loadCatalog();
  const id = getActivePresetId();
  return catalog.presets.find((p) => p.id === id) || catalog.presets[0] || null;
}

function getActivePresetEnv() {
  const preset = getActivePreset();
  if (!preset?.env) return {};
  return { ...preset.env };
}

function listPresetsPublic() {
  const catalog = loadCatalog();
  const settingsEnv = (() => {
    try {
      const { loadSettingsEnv } = require("./agent-settings");
      return loadSettingsEnv();
    } catch {
      return {};
    }
  })();
  return {
    activePresetId: getActivePresetId(),
    presets: catalog.presets.map((p) => ({
      id: p.id,
      label: p.label,
      description: p.description || "",
      model: p.env?.ANTHROPIC_MODEL || settingsEnv.ANTHROPIC_MODEL || "",
    })),
  };
}

function setActivePreset(presetId) {
  const catalog = loadCatalog();
  const found = catalog.presets.find((p) => p.id === presetId);
  if (!found) return { ok: false, error: "NOT_FOUND" };
  cachedUserChoice = { activePresetId: presetId };
  writeJson(userSettingsPath(), cachedUserChoice);
  return { ok: true, activePresetId: presetId, label: found.label };
}

function reloadPresets() {
  cachedCatalog = null;
  cachedUserChoice = null;
}

module.exports = {
  getActivePreset,
  getActivePresetEnv,
  getActivePresetId,
  listPresetsPublic,
  setActivePreset,
  reloadPresets,
};
