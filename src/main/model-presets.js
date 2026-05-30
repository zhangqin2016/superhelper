"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { PROJECT_ROOT, userDataPath } = require("./config");
const { normalizeToLilyEnv, pickModelId } = require("./agent-env");

/** @type {{ activePresetId: string, presets: Array<{id:string,label:string,description?:string,env:Record<string,string>}> } | null} */
let cachedCatalog = null;
/** @type {{ activePresetId?: string, customPresets?: Array<{id:string,label:string,model:string,description?:string}> } | null} */
let cachedUserChoice = null;

const CUSTOM_ID_PREFIX = "custom-";
const MODEL_ID_RE = /^[A-Za-z0-9._:/-]{1,128}$/;
const URL_RE = /^https?:\/\/.+/i;
const API_KEY_RE = /^[\x20-\x7E]{8,512}$/;

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
  const raw = readJson(userSettingsPath(), null);
  cachedUserChoice = {
    activePresetId: raw?.activePresetId || null,
    customPresets: Array.isArray(raw?.customPresets) ? raw.customPresets : [],
    apiGateway: normalizeApiGateway(raw?.apiGateway),
  };
  return cachedUserChoice;
}

function normalizeApiGateway(raw) {
  if (!raw || typeof raw !== "object") {
    return { mode: "builtin", baseUrl: "", apiKey: "" };
  }
  return {
    mode: raw.mode === "custom" ? "custom" : "builtin",
    baseUrl: String(raw.baseUrl || "").trim(),
    apiKey: String(raw.apiKey || "").trim(),
  };
}

function maskApiKey(key) {
  const value = String(key || "").trim();
  if (!value) return "";
  if (value.length <= 8) return "****";
  return `${value.slice(0, 3)}****${value.slice(-4)}`;
}

function getBundledApiDefaults() {
  try {
    const { loadSettingsEnv } = require("./agent-settings");
    const env = loadSettingsEnv();
    return {
      baseUrl: env.LILY_API_BASE_URL || "",
      apiKeySet: Boolean(env.LILY_API_KEY),
    };
  } catch {
    return { baseUrl: "", apiKeySet: false };
  }
}

function validateBaseUrl(baseUrl, { required = false } = {}) {
  const trimmed = String(baseUrl || "").trim();
  if (!trimmed) {
    return required ? { ok: false, error: "INVALID_BASE_URL" } : { ok: true, baseUrl: "" };
  }
  if (trimmed.length > 512 || !URL_RE.test(trimmed)) {
    return { ok: false, error: "INVALID_BASE_URL" };
  }
  return { ok: true, baseUrl: trimmed };
}

function validateApiKey(apiKey, { required = false, existing = "" } = {}) {
  const trimmed = String(apiKey || "").trim();
  if (!trimmed) {
    const kept = String(existing || "").trim();
    if (required && !kept) return { ok: false, error: "INVALID_API_KEY" };
    return { ok: true, apiKey: kept };
  }
  if (!API_KEY_RE.test(trimmed)) return { ok: false, error: "INVALID_API_KEY" };
  return { ok: true, apiKey: trimmed };
}

function persistUserChoice(user) {
  cachedUserChoice = user;
  writeJson(userSettingsPath(), user);
}

function slugifyLabel(label) {
  return (
    String(label)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
      .replace(/^-+|-+$/g, "") || "model"
  );
}

function makeCustomId(label, model, existingIds) {
  const base = `${CUSTOM_ID_PREFIX}${slugifyLabel(label || model)}`;
  let id = base;
  let n = 2;
  while (existingIds.has(id)) {
    id = `${base}-${n++}`;
  }
  return id;
}

function validateOptionalModelId(modelId, fieldError = "INVALID_MODEL") {
  const trimmed = String(modelId || "").trim();
  if (!trimmed) return { ok: true, model: "" };
  if (!MODEL_ID_RE.test(trimmed)) return { ok: false, error: fieldError };
  return { ok: true, model: trimmed };
}

function resolveTierModels(entry) {
  const main = String(entry?.model || "").trim();
  const haiku = String(entry?.modelHaiku || "").trim() || main;
  const sonnet = String(entry?.modelSonnet || "").trim() || main;
  const opus = String(entry?.modelOpus || "").trim() || main;
  const subagent = String(entry?.modelSubagent || "").trim() || haiku;
  return { main, haiku, sonnet, opus, subagent };
}

function envFromTierModels(entry) {
  const tiers = resolveTierModels(entry);
  return {
    LILY_MODEL: tiers.main,
    LILY_MODEL_HAIKU: tiers.haiku,
    LILY_MODEL_SONNET: tiers.sonnet,
    LILY_MODEL_OPUS: tiers.opus,
    LILY_SUBAGENT_MODEL: tiers.subagent,
  };
}

function customPresetRecord(entry) {
  const tiers = resolveTierModels(entry);
  const baseUrl = String(entry.baseUrl || "").trim();
  const apiKey = String(entry.apiKey || "").trim();
  return {
    id: entry.id,
    label: String(entry.label || tiers.main).trim(),
    description: String(entry.description || "").trim(),
    model: tiers.main,
    modelHaiku: tiers.haiku,
    modelSonnet: tiers.sonnet,
    modelOpus: tiers.opus,
    modelSubagent: tiers.subagent,
    baseUrl,
    apiKeySet: Boolean(apiKey),
    custom: true,
    env: envFromTierModels(entry),
  };
}

function getCustomPresets() {
  return (loadUserChoice().customPresets || [])
    .filter((p) => p?.id && p?.model)
    .map(customPresetRecord);
}

function getBuiltinPresets() {
  return loadCatalog().presets.map((p) => ({
    id: p.id,
    label: p.label,
    description: p.description || "",
    model: pickModelId(normalizeToLilyEnv(p.env || {})) || "",
    custom: false,
    env: p.env || {},
  }));
}

function getAllPresets() {
  return [...getBuiltinPresets(), ...getCustomPresets()];
}

function findPresetById(presetId) {
  return getAllPresets().find((p) => p.id === presetId) || null;
}

function getActivePresetId() {
  const user = loadUserChoice();
  if (user?.activePresetId && findPresetById(user.activePresetId)) {
    return user.activePresetId;
  }
  const catalog = loadCatalog();
  const fallback = catalog.activePresetId || catalog.presets[0]?.id || "standard";
  if (findPresetById(fallback)) return fallback;
  return getAllPresets()[0]?.id || "standard";
}

function getActivePreset() {
  return findPresetById(getActivePresetId());
}

function getActivePresetEnv() {
  const preset = getActivePreset();
  if (!preset?.env) return {};
  return normalizeToLilyEnv(preset.env);
}

function getUserApiEnv() {
  const preset = getActivePreset();
  const user = loadUserChoice();

  if (preset?.custom) {
    const entry = (user.customPresets || []).find((p) => p.id === preset.id);
    if (entry) {
      const env = {};
      const baseUrl = String(entry.baseUrl || "").trim();
      const apiKey = String(entry.apiKey || "").trim();
      if (baseUrl) env.LILY_API_BASE_URL = baseUrl;
      if (apiKey) env.LILY_API_KEY = apiKey;
      if (Object.keys(env).length) return env;
    }
  }

  const gateway = user.apiGateway || normalizeApiGateway(null);
  if (gateway.mode !== "custom") return {};

  const env = {};
  if (gateway.baseUrl) env.LILY_API_BASE_URL = gateway.baseUrl;
  if (gateway.apiKey) env.LILY_API_KEY = gateway.apiKey;
  return env;
}

function getApiGatewayPublic() {
  const user = loadUserChoice();
  const gateway = user.apiGateway || normalizeApiGateway(null);
  const bundled = getBundledApiDefaults();
  return {
    mode: gateway.mode,
    baseUrl: gateway.baseUrl,
    apiKeySet: Boolean(gateway.apiKey),
    apiKeyHint: gateway.apiKey ? maskApiKey(gateway.apiKey) : "",
    defaultBaseUrl: bundled.baseUrl,
    defaultApiKeySet: bundled.apiKeySet,
  };
}

function listPresetsPublic() {
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
    apiGateway: getApiGatewayPublic(),
    presets: getAllPresets().map((p) => ({
      id: p.id,
      label: p.label,
      description: p.description || "",
      model: p.model || pickModelId(normalizeToLilyEnv(p.env || {})) || pickModelId(settingsEnv) || "",
      modelHaiku: p.modelHaiku || "",
      modelSonnet: p.modelSonnet || "",
      modelOpus: p.modelOpus || "",
      baseUrl: p.baseUrl || "",
      apiKeySet: Boolean(p.apiKeySet),
      custom: Boolean(p.custom),
    })),
  };
}

function setActivePreset(presetId) {
  const found = findPresetById(presetId);
  if (!found) return { ok: false, error: "NOT_FOUND" };
  const user = loadUserChoice();
  persistUserChoice({ ...user, activePresetId: presetId });
  return { ok: true, activePresetId: presetId, label: found.label };
}

function validateCustomInput(label, model) {
  const trimmedLabel = String(label || "").trim();
  const trimmedModel = String(model || "").trim();
  if (!trimmedLabel || trimmedLabel.length > 40) {
    return { ok: false, error: "INVALID_LABEL" };
  }
  if (!trimmedModel || !MODEL_ID_RE.test(trimmedModel)) {
    return { ok: false, error: "INVALID_MODEL" };
  }
  return { ok: true, label: trimmedLabel, model: trimmedModel };
}

function saveCustomPreset({
  label,
  model,
  modelHaiku = "",
  modelSonnet = "",
  modelOpus = "",
  modelSubagent = "",
  description = "",
  baseUrl = "",
  apiKey = "",
}) {
  const validated = validateCustomInput(label, model);
  if (!validated.ok) return validated;

  for (const [key, value, error] of [
    ["modelHaiku", modelHaiku, "INVALID_MODEL_HAIKU"],
    ["modelSonnet", modelSonnet, "INVALID_MODEL_SONNET"],
    ["modelOpus", modelOpus, "INVALID_MODEL_OPUS"],
    ["modelSubagent", modelSubagent, "INVALID_MODEL_SUBAGENT"],
  ]) {
    const tierValidated = validateOptionalModelId(value, error);
    if (!tierValidated.ok) return tierValidated;
  }

  const urlValidated = validateBaseUrl(baseUrl);
  if (!urlValidated.ok) return urlValidated;

  const keyValidated = validateApiKey(apiKey);
  if (!keyValidated.ok) return keyValidated;

  const haikuValidated = validateOptionalModelId(modelHaiku);
  const sonnetValidated = validateOptionalModelId(modelSonnet);
  const opusValidated = validateOptionalModelId(modelOpus);
  const subagentValidated = validateOptionalModelId(modelSubagent);

  const user = loadUserChoice();
  const existingIds = new Set(getAllPresets().map((p) => p.id));
  const id = makeCustomId(validated.label, validated.model, existingIds);
  const entry = {
    id,
    label: validated.label,
    model: validated.model,
    modelHaiku: haikuValidated.model,
    modelSonnet: sonnetValidated.model,
    modelOpus: opusValidated.model,
    modelSubagent: subagentValidated.model,
    description: String(description || "").trim().slice(0, 120),
    baseUrl: urlValidated.baseUrl,
    apiKey: keyValidated.apiKey,
  };
  const customPresets = [...(user.customPresets || []), entry];
  persistUserChoice({ ...user, customPresets });
  return { ok: true, preset: customPresetRecord(entry), ...listPresetsPublic() };
}

function deleteCustomPreset(presetId) {
  if (!String(presetId || "").startsWith(CUSTOM_ID_PREFIX)) {
    return { ok: false, error: "NOT_CUSTOM" };
  }
  const user = loadUserChoice();
  const customPresets = (user.customPresets || []).filter((p) => p.id !== presetId);
  if (customPresets.length === (user.customPresets || []).length) {
    return { ok: false, error: "NOT_FOUND" };
  }

  let activePresetId = user.activePresetId;
  if (activePresetId === presetId) {
    activePresetId = loadCatalog().activePresetId || loadCatalog().presets[0]?.id || "standard";
  }

  persistUserChoice({ ...user, customPresets, activePresetId });
  return { ok: true, ...listPresetsPublic() };
}

function setApiGateway({ mode, baseUrl, apiKey }) {
  const user = loadUserChoice();
  const nextMode = mode === "custom" ? "custom" : "builtin";

  if (nextMode === "builtin") {
    persistUserChoice({
      ...user,
      apiGateway: { mode: "builtin", baseUrl: "", apiKey: "" },
    });
    return { ok: true, ...listPresetsPublic() };
  }

  const urlValidated = validateBaseUrl(baseUrl, { required: true });
  if (!urlValidated.ok) return urlValidated;

  const keyValidated = validateApiKey(apiKey, {
    required: true,
    existing: user.apiGateway?.apiKey || "",
  });
  if (!keyValidated.ok) return keyValidated;

  persistUserChoice({
    ...user,
    apiGateway: {
      mode: "custom",
      baseUrl: urlValidated.baseUrl,
      apiKey: keyValidated.apiKey,
    },
  });
  return { ok: true, ...listPresetsPublic() };
}

function reloadPresets() {
  cachedCatalog = null;
  cachedUserChoice = null;
}

module.exports = {
  getActivePreset,
  getActivePresetEnv,
  getUserApiEnv,
  getActivePresetId,
  listPresetsPublic,
  getApiGatewayPublic,
  setActivePreset,
  saveCustomPreset,
  deleteCustomPreset,
  setApiGateway,
  reloadPresets,
};
