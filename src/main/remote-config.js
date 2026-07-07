"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { PROJECT_ROOT, userDataPath, isPackaged } = require("./config");

// safeStorage is electron-only; lazy-require it so this module loads in plain
// node (tests). Absent → graceful plaintext fallback via the `?.` guards.
function electronSafeStorage() {
  try {
    return require("electron").safeStorage || null;
  } catch {
    return null;
  }
}
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
  const safeStorage = electronSafeStorage();
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
  const safeStorage = electronSafeStorage();
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
    return !isPackaged() && json.signature === expected ? { ok: true, payload } : { ok: false };
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

function reloadRemoteConfigCache() {
  cachedState = null;
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
        // Native image support is a property of the model; when true the client
        // skips the Qwen vision-to-text bridge and sends images straight to the
        // (multimodal) engine. Defaults to false → bridge.
        capabilities: { vision: Boolean(preset.capabilities?.vision) },
        env: { ...preset.env },
      })),
  };
}

function normalizeRuntimeEnv(effectiveConfig) {
  const env = effectiveConfig?.runtime?.env;
  if (!env || typeof env !== "object" || Array.isArray(env)) return {};
  const normalized = {};
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Z][A-Z0-9_]{1,80}$/.test(key)) continue;
    if (value == null || value === "") continue;
    normalized[key] = String(value);
  }
  return normalized;
}

function decodeGatewayTokenPayload(token) {
  const match = String(token || "").match(/^lilygw\.([A-Za-z0-9_-]+)\./);
  if (!match) return null;
  try {
    const base64 = match[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function gatewayTokenExpiresSoon(token, skewMs = 5 * 60_000) {
  const value = String(token || "").trim();
  if (!value || value === "$LILY_GATEWAY_TOKEN") return false;
  const payload = decodeGatewayTokenPayload(value);
  if (!payload?.expiresAt) return false;
  const expiresAt = Date.parse(String(payload.expiresAt));
  return Number.isFinite(expiresAt) && expiresAt <= Date.now() + skewMs;
}

function gatewayTokenMalformed(token) {
  const value = String(token || "").trim();
  if (!value) return false;
  if (value === "$LILY_GATEWAY_TOKEN") return true;
  if (!value.startsWith("lilygw.")) return false;
  return !decodeGatewayTokenPayload(value)?.expiresAt;
}

function effectiveConfigHasExpiredGatewayToken(effectiveConfig, skewMs = 5 * 60_000) {
  const values = [];
  const presets = effectiveConfig?.models?.presets;
  if (Array.isArray(presets)) {
    for (const preset of presets) {
      const env = preset?.env || {};
      values.push(env.LILY_API_KEY, env.OPENAI_API_KEY, env.ANTHROPIC_API_KEY);
    }
  }
  const runtimeEnv = effectiveConfig?.runtime?.env || {};
  values.push(runtimeEnv.LILY_API_KEY, runtimeEnv.OPENAI_API_KEY, runtimeEnv.ANTHROPIC_API_KEY);
  return values.some((value) => gatewayTokenMalformed(value) || gatewayTokenExpiresSoon(value, skewMs));
}

function getRemoteModelCatalogSync() {
  const state = readCache();
  const expiresAt = Date.parse(String(state.expiresAt || ""));
  if (expiresAt && Date.now() > expiresAt) return null;
  if (effectiveConfigHasExpiredGatewayToken(state.effectiveConfig)) return null;
  return normalizeRemoteCatalog(state.effectiveConfig);
}

function hasRemoteModelCatalogSync() {
  return Boolean(getRemoteModelCatalogSync()?.presets?.length);
}

function getRemoteEffectiveConfigSync() {
  const state = readCache();
  const expiresAt = Date.parse(String(state.expiresAt || ""));
  if (expiresAt && Date.now() > expiresAt) return null;
  if (effectiveConfigHasExpiredGatewayToken(state.effectiveConfig)) return null;
  return state.effectiveConfig || null;
}

function getRemoteRuntimeEnvSync() {
  const state = readCache();
  const expiresAt = Date.parse(String(state.expiresAt || ""));
  if (expiresAt && Date.now() > expiresAt) return {};
  if (effectiveConfigHasExpiredGatewayToken(state.effectiveConfig)) return {};
  return normalizeRuntimeEnv(state.effectiveConfig);
}

/** BYOK provider catalog the server published (endpoint + protocol + models, no
 *  keys). The client's "add model" flow uses it so the user only picks a provider
 *  + model and enters their own key. Empty when the server didn't publish one. */
function getRemoteProviderCatalogSync() {
  const cfg = getRemoteEffectiveConfigSync();
  const catalog = cfg?.models?.catalog;
  if (!Array.isArray(catalog)) return [];
  return catalog
    .filter((p) => p?.id && p?.baseUrl && Array.isArray(p?.models) && p.models.length)
    .map((p) => ({
      id: String(p.id),
      label: String(p.label || p.id),
      baseUrl: String(p.baseUrl),
      protocol: p.protocol === "openai" ? "openai" : "anthropic",
      models: p.models.map(String).filter(Boolean),
    }));
}

// Modules that cache derived views of the remote config (e.g. model-presets)
// subscribe here instead of being required from this file — keeps the
// dependency one-directional: consumers depend on remote-config, never back.
const refreshListeners = new Set();

function onRemoteConfigRefreshed(listener) {
  refreshListeners.add(listener);
}

function notifyRefreshed() {
  for (const listener of refreshListeners) {
    try {
      listener();
    } catch {
      // one stale listener must not block the refresh
    }
  }
}

async function refreshRemoteConfig(payload = {}) {
  const service = require("./service-client");
  let accountAccessToken = "";
  try {
    const account = require("./account-manager");
    const token = await account.accessTokenForService();
    if (token?.ok && token.accessToken) accountAccessToken = token.accessToken;
  } catch {
    accountAccessToken = "";
  }
  let result = await service.fetchClientConfig({
    ...payload,
    ...(accountAccessToken ? { accountAccessToken } : {}),
  });
  if (!result.ok && shouldRetryAfterDeviceRegister(result.error)) {
    const registered = await service.registerDevice();
    if (!registered.ok) return result;
    result = await service.fetchClientConfig({
      ...payload,
      ...(accountAccessToken ? { accountAccessToken } : {}),
    });
  }
  if (!result.ok) return result;
  const verified = verifyConfigResponse(result.json);
  if (!verified.ok) return { ok: false, error: "CONFIG_SIGNATURE_INVALID" };
  writeCache({
    ...verified.payload,
    deviceId: result.json.deviceId || "",
    appliedProfileIds: Array.isArray(result.json.appliedProfileIds) ? result.json.appliedProfileIds : [],
    receivedAt: new Date().toISOString(),
  });
  notifyRefreshed();
  return { ok: true, configVersion: verified.payload.configVersion };
}

function shouldRetryAfterDeviceRegister(error) {
  return error === "DEVICE_KEY_NOT_REGISTERED" || error === "DEVICE_SIGNATURE_INVALID";
}

module.exports = {
  refreshRemoteConfig,
  onRemoteConfigRefreshed,
  reloadRemoteConfigCache,
  getRemoteModelCatalogSync,
  hasRemoteModelCatalogSync,
  getRemoteEffectiveConfigSync,
  getRemoteRuntimeEnvSync,
  getRemoteProviderCatalogSync,
  decodeGatewayTokenPayload,
  effectiveConfigHasExpiredGatewayToken,
  shouldRetryAfterDeviceRegister,
};
