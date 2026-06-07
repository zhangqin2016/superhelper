"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { app, safeStorage } = require("electron");
const { PROJECT_ROOT, userDataPath } = require("./config");
const { stableStringify, verifyDetached } = require("./crypto-signing");

const CACHE_FILE = "remote-config-cache.json";
const DEFAULT_PUBLIC_KEY_PATHS = [
  path.join(process.resourcesPath || "", "resources", "license-public-key.pem"),
  path.join(PROJECT_ROOT, "resources", "license-public-key.pem"),
];

let cachedState = null;

function cachePath() {
  return userDataPath(CACHE_FILE);
}

function readJson(filePath, fallback = {}) {
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

function loadPublicKey() {
  const envKey = process.env.LILY_CONFIG_PUBLIC_KEY || process.env.LILY_LICENSE_PUBLIC_KEY;
  if (envKey?.includes("BEGIN PUBLIC KEY")) return envKey;
  const envPath = process.env.LILY_CONFIG_PUBLIC_KEY_PATH || process.env.LILY_LICENSE_PUBLIC_KEY_PATH;
  const paths = envPath ? [envPath, ...DEFAULT_PUBLIC_KEY_PATHS] : DEFAULT_PUBLIC_KEY_PATHS;
  for (const p of paths) {
    try {
      if (p && fs.existsSync(p)) return fs.readFileSync(p, "utf8");
    } catch {
      // try next
    }
  }
  return "";
}

function protectText(text) {
  if (safeStorage?.isEncryptionAvailable?.()) {
    return {
      encrypted: true,
      data: safeStorage.encryptString(text).toString("base64"),
    };
  }
  return {
    encrypted: false,
    data: Buffer.from(text, "utf8").toString("base64"),
  };
}

function unprotectText(record) {
  if (!record?.data) return "";
  const buf = Buffer.from(record.data, "base64");
  if (!record.encrypted) return buf.toString("utf8");
  if (!safeStorage?.isEncryptionAvailable?.()) return "";
  try {
    return safeStorage.decryptString(buf);
  } catch {
    return "";
  }
}

function hashPayload(payload) {
  return crypto.createHash("sha256").update(stableStringify(payload)).digest("hex");
}

function verifyConfigResponse(json) {
  const payload = {
    schemaVersion: json?.schemaVersion,
    configVersion: json?.configVersion,
    expiresAt: json?.expiresAt,
    effectiveConfig: json?.effectiveConfig,
  };
  if (json?.signature?.startsWith("dev.")) {
    const expected = `dev.${hashPayload(payload)}`;
    return !app.isPackaged && json.signature === expected ? { ok: true, payload } : { ok: false };
  }
  return verifyDetached(payload, json?.signature, loadPublicKey())
    ? { ok: true, payload }
    : { ok: false };
}

function readCache() {
  if (cachedState) return cachedState;
  const record = readJson(cachePath(), {});
  const text = unprotectText(record.config);
  if (!text) {
    cachedState = {};
    return cachedState;
  }
  try {
    cachedState = JSON.parse(text);
  } catch {
    cachedState = {};
  }
  return cachedState;
}

function writeCache(state) {
  cachedState = state || {};
  writeJson(cachePath(), {
    config: protectText(JSON.stringify(cachedState)),
    updatedAt: new Date().toISOString(),
  });
}

function normalizeRemoteCatalog(effectiveConfig) {
  const models = effectiveConfig?.models;
  if (!models || !Array.isArray(models.presets) || models.presets.length === 0) return null;
  return {
    activePresetId: String(models.activePresetId || models.presets[0]?.id || "standard"),
    presets: models.presets
      .filter((preset) => preset?.id && preset?.env && typeof preset.env === "object")
      .map((preset) => ({
        id: String(preset.id),
        label: String(preset.label || preset.id),
        description: String(preset.description || ""),
        env: { ...preset.env },
      })),
  };
}

function getRemoteModelCatalogSync() {
  const state = readCache();
  const expiresAt = Date.parse(String(state.expiresAt || ""));
  if (expiresAt && Date.now() > expiresAt) return null;
  return normalizeRemoteCatalog(state.effectiveConfig);
}

function getRemoteEffectiveConfigSync() {
  const state = readCache();
  const expiresAt = Date.parse(String(state.expiresAt || ""));
  if (expiresAt && Date.now() > expiresAt) return null;
  return state.effectiveConfig || null;
}

async function refreshRemoteConfig(payload = {}) {
  const service = require("./service-client");
  const result = await service.fetchClientConfig(payload);
  if (!result.ok) return result;
  const verified = verifyConfigResponse(result.json);
  if (!verified.ok) return { ok: false, error: "CONFIG_SIGNATURE_INVALID" };
  writeCache({
    ...verified.payload,
    deviceId: result.json.deviceId || "",
    appliedProfileIds: Array.isArray(result.json.appliedProfileIds) ? result.json.appliedProfileIds : [],
    receivedAt: new Date().toISOString(),
  });
  try {
    require("./model-presets").reloadPresets();
  } catch {
    // model presets may not be loaded yet.
  }
  return { ok: true, configVersion: verified.payload.configVersion };
}

module.exports = {
  refreshRemoteConfig,
  getRemoteModelCatalogSync,
  getRemoteEffectiveConfigSync,
};
