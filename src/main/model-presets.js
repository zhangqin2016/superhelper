"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { userDataPath } = require("./config");
const { normalizeToLilyEnv, pickModelId } = require("./agent-env");
const remoteConfig = require("./remote-config");

/** @type {{ activePresetId: string, presets: Array<{id:string,label:string,description?:string,env:Record<string,string>}> } | null} */
let cachedCatalog = null;
/** @type {{ activePresetId?: string, customPresets?: Array<{id:string,label:string,model:string,description?:string}> } | null} */
let cachedUserChoice = null;

const CUSTOM_ID_PREFIX = "custom-";
const MODEL_ID_RE = /^[A-Za-z0-9._:/-]{1,128}$/;
const URL_RE = /^https?:\/\/.+/i;
const API_KEY_RE = /^[\x20-\x7E]{8,512}$/;
const DEFAULT_PROTOCOL = "openai";

function normalizeProtocol(value) {
  const protocol = String(value || "").toLowerCase();
  return protocol === "anthropic" || protocol === "openai" ? protocol : "";
}

function legacyProtocolForBaseUrl(baseUrl) {
  return /\/anthropic(\/|$)/i.test(String(baseUrl || "")) ? "anthropic" : DEFAULT_PROTOCOL;
}

function getSafeStorage() {
  try {
    return require("electron").safeStorage || null;
  } catch {
    return null;
  }
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

function protectSecret(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const safeStorage = getSafeStorage();
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

function unprotectSecret(record) {
  if (!record?.data) return "";
  const buf = Buffer.from(String(record.data), "base64");
  if (!record.encrypted) return buf.toString("utf8");
  const safeStorage = getSafeStorage();
  if (!safeStorage?.isEncryptionAvailable?.()) return "";
  try {
    return safeStorage.decryptString(buf);
  } catch {
    return "";
  }
}

function hydrateSecret(value, protectedRecord) {
  const plain = String(value || "").trim();
  if (plain) return plain;
  return unprotectSecret(protectedRecord);
}

function hydrateUserChoice(raw) {
  const apiGateway = raw?.apiGateway && typeof raw.apiGateway === "object"
    ? {
        ...raw.apiGateway,
        apiKey: hydrateSecret(raw.apiGateway.apiKey, raw.apiGateway.apiKeyProtected),
      }
    : null;
  const customPresets = Array.isArray(raw?.customPresets)
    ? raw.customPresets.map((preset) => ({
        ...preset,
        apiKey: hydrateSecret(preset.apiKey, preset.apiKeyProtected),
      }))
    : [];
  return {
    activePresetId: raw?.activePresetId || null,
    customPresets,
    apiGateway,
  };
}

function serializeUserChoice(user) {
  const apiGateway = user?.apiGateway
    ? {
        ...user.apiGateway,
        apiKeyProtected: protectSecret(user.apiGateway.apiKey),
      }
    : null;
  if (apiGateway) delete apiGateway.apiKey;

  const customPresets = (user?.customPresets || []).map((preset) => {
    const entry = {
      ...preset,
      apiKeyProtected: protectSecret(preset.apiKey),
    };
    delete entry.apiKey;
    return entry;
  });

  return {
    activePresetId: user?.activePresetId || null,
    customPresets,
    apiGateway,
  };
}

function hasPlaintextSecrets(raw) {
  if (String(raw?.apiGateway?.apiKey || "").trim()) return true;
  return (Array.isArray(raw?.customPresets) ? raw.customPresets : []).some((preset) =>
    String(preset?.apiKey || "").trim());
}

function loadCatalog() {
  if (cachedCatalog) return cachedCatalog;
  try {
    const remoteCatalog = remoteConfig.getRemoteModelCatalogSync();
    if (remoteCatalog?.presets?.length) {
      cachedCatalog = remoteCatalog;
      return cachedCatalog;
    }
  } catch {
    // Service-managed model lists must come from signed remote config.
  }
  cachedCatalog = {
    activePresetId: "",
    presets: [],
  };
  return cachedCatalog;
}

function loadUserChoice() {
  if (cachedUserChoice) return cachedUserChoice;
  const stored = readJson(userSettingsPath(), null);
  const raw = hydrateUserChoice(stored);
  cachedUserChoice = {
    activePresetId: raw?.activePresetId || null,
    customPresets: Array.isArray(raw?.customPresets) ? raw.customPresets.map(normalizeCustomPresetEntry) : [],
    apiGateway: normalizeApiGateway(raw?.apiGateway),
  };
  const activePreset = findPresetById(getActivePresetId());
  if (!activePreset?.custom && presetHasOwnModelConnection(activePreset) && cachedUserChoice.apiGateway.mode === "custom") {
    cachedUserChoice = {
      ...cachedUserChoice,
      apiGateway: normalizeApiGateway(null),
    };
  }
  if (
    hasPlaintextSecrets(stored) ||
    cachedUserChoice.apiGateway.mode !== normalizeApiGateway(raw?.apiGateway).mode ||
    hasMissingProtocolMetadata(stored)
  ) {
    writeJson(userSettingsPath(), serializeUserChoice(cachedUserChoice));
  }
  return cachedUserChoice;
}

function normalizeApiGateway(raw) {
  const baseUrl = String(raw?.baseUrl || "").trim();
  if (!raw || typeof raw !== "object") {
    return { mode: "builtin", baseUrl: "", apiKey: "", protocol: DEFAULT_PROTOCOL, tlsSkipVerify: false };
  }
  return {
    mode: raw.mode === "custom" ? "custom" : "builtin",
    baseUrl,
    apiKey: String(raw.apiKey || "").trim(),
    protocol: normalizeProtocol(raw.protocol) || legacyProtocolForBaseUrl(baseUrl),
    tlsSkipVerify: Boolean(raw.tlsSkipVerify),
  };
}

function normalizeCustomPresetEntry(entry) {
  const baseUrl = String(entry?.baseUrl || "").trim();
  return {
    ...(entry && typeof entry === "object" ? entry : {}),
    protocol: normalizeProtocol(entry?.protocol) || legacyProtocolForBaseUrl(baseUrl),
  };
}

function hasMissingProtocolMetadata(stored) {
  if (!stored || typeof stored !== "object") return false;
  const gateway = stored.apiGateway;
  if (gateway?.mode === "custom" && gateway.baseUrl && !normalizeProtocol(gateway.protocol)) return true;
  return (Array.isArray(stored.customPresets) ? stored.customPresets : []).some((preset) =>
    preset?.baseUrl && !normalizeProtocol(preset.protocol));
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
  try {
    const url = new URL(trimmed);
    const pathOnly = url.pathname.replace(/\/+$/, "");
    if (/\/(chat\/completions|messages)$/i.test(pathOnly)) {
      return { ok: false, error: "INVALID_BASE_URL" };
    }
    return { ok: true, baseUrl: url.toString().replace(/\/+$/, "") };
  } catch {
    return { ok: false, error: "INVALID_BASE_URL" };
  }
}

function isLoopbackBaseUrl(baseUrl) {
  try {
    const host = new URL(String(baseUrl || "")).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
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
  writeJson(userSettingsPath(), serializeUserChoice(user));
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
    protocol: normalizeProtocol(entry.protocol) || legacyProtocolForBaseUrl(baseUrl),
    apiKeySet: Boolean(apiKey),
    tlsSkipVerify: Boolean(entry.tlsSkipVerify && baseUrl),
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
    capabilities: { vision: Boolean(p.capabilities?.vision) },
    env: p.env || {},
  }));
}

function isRemoteManagedCatalog() {
  return remoteConfig.hasRemoteModelCatalogSync();
}

function usesManagedServicePreset(preset) {
  if (!preset || preset.custom) return false;
  const env = normalizeToLilyEnv(preset.env || {});
  const baseUrl = String(env.LILY_API_BASE_URL || "").trim();
  const apiKey = String(env.LILY_API_KEY || "").trim();
  return Boolean(
    env.LILY_GATEWAY_PROVIDER ||
      baseUrl.startsWith("/llm/") ||
      baseUrl === "/llm" ||
      apiKey === "$LILY_GATEWAY_TOKEN",
  );
}

function presetHasOwnModelConnection(preset) {
  if (!preset || preset.custom) return false;
  const env = normalizeToLilyEnv(preset.env || {});
  return Boolean(
    String(env.LILY_API_BASE_URL || "").trim() ||
      String(env.LILY_API_KEY || "").trim() ||
      String(env.LILY_GATEWAY_PROVIDER || "").trim(),
  );
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
  return getAllPresets()[0]?.id || "";
}

function getActivePreset() {
  return findPresetById(getActivePresetId());
}

/**
 * Whether the active model natively recognizes images. When true the vision
 * preflight skips the Qwen bridge and lets images pass through as image blocks.
 */
function activePresetSupportsVision() {
  try {
    return Boolean(getActivePreset()?.capabilities?.vision);
  } catch {
    // Capability probe must never crash a turn; if presets can't be resolved
    // (e.g. paths not bound yet), assume no native vision → use the bridge.
    return false;
  }
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
      const protocol = normalizeProtocol(entry.protocol) || legacyProtocolForBaseUrl(baseUrl);
      if (baseUrl) env.LILY_API_BASE_URL = baseUrl;
      if (apiKey) env.LILY_API_KEY = apiKey;
      if (protocol) env.LILY_OPENCODE_PROTOCOL = protocol;
      if (entry.tlsSkipVerify && baseUrl) env.LILY_TLS_SKIP_VERIFY = "1";
      if (Object.keys(env).length) return env;
    }
  }

  if (presetHasOwnModelConnection(preset) || usesManagedServicePreset(preset)) return {};

  const gateway = user.apiGateway || normalizeApiGateway(null);
  if (gateway.mode !== "custom") return {};

  const env = {};
  const protocol = normalizeProtocol(gateway.protocol) || legacyProtocolForBaseUrl(gateway.baseUrl);
  if (gateway.baseUrl) env.LILY_API_BASE_URL = gateway.baseUrl;
  if (gateway.apiKey) env.LILY_API_KEY = gateway.apiKey;
  if (protocol) env.LILY_OPENCODE_PROTOCOL = protocol;
  if (gateway.tlsSkipVerify && gateway.baseUrl) env.LILY_TLS_SKIP_VERIFY = "1";
  return env;
}

function getActiveModelConnectionStatus(lilyEnv = null) {
  const preset = getActivePreset();
  const user = loadUserChoice();
  const resolvedEnv = normalizeToLilyEnv(lilyEnv || {
    ...(preset?.env || {}),
    ...getUserApiEnv(),
  });
  const apiKey = String(resolvedEnv.LILY_API_KEY || "").trim();
  const baseUrl = String(resolvedEnv.LILY_API_BASE_URL || resolvedEnv.LILY_OPENCODE_BASE_URL || "").trim();
  const model = String(resolvedEnv.LILY_MODEL || "").trim();

  if (apiKey) return { ok: true, source: "api-key", managed: false };
  if (baseUrl && isLoopbackBaseUrl(baseUrl) && model) {
    return { ok: true, source: "loopback", managed: false };
  }

  if (preset?.custom || user.apiGateway?.mode === "custom") {
    return {
      ok: false,
      error: "NO_API_KEY",
      source: preset?.custom ? "custom-preset" : "custom-gateway",
      managed: false,
    };
  }

  if (usesManagedServicePreset(preset) || isRemoteManagedCatalog() || !presetHasOwnModelConnection(preset)) {
    return {
      ok: false,
      error: "SERVICE_MODEL_CONFIG_UNAVAILABLE",
      source: "service-managed",
      managed: true,
    };
  }

  return {
    ok: false,
    error: "NO_API_KEY",
    source: "preset",
    managed: false,
  };
}

function getApiGatewayPublic() {
  const user = loadUserChoice();
  const gateway = user.apiGateway || normalizeApiGateway(null);
  const bundled = getBundledApiDefaults();
  return {
    mode: gateway.mode,
    baseUrl: gateway.baseUrl,
    protocol: gateway.protocol || DEFAULT_PROTOCOL,
    apiKeySet: Boolean(gateway.apiKey),
    apiKeyHint: gateway.apiKey ? maskApiKey(gateway.apiKey) : "",
    tlsSkipVerify: Boolean(gateway.tlsSkipVerify && gateway.baseUrl),
    defaultBaseUrl: bundled.baseUrl,
    defaultApiKeySet: bundled.apiKeySet,
  };
}

/** The bundled BYOK provider catalog (resources/model-catalog.json, generated
 *  from models.dev by scripts/fetch-model-catalog.mjs). Public providers +
 *  current model ids + endpoints, so the "add a model" picker is rich without
 *  the runtime reaching models.dev (which is often blocked). Models flattened to
 *  id strings — the shape the renderer's provider/model dropdowns expect. */
function getBundledProviderCatalog() {
  try {
    const fs2 = require("node:fs");
    const path2 = require("node:path");
    const { PROJECT_ROOT } = require("./config");
    const candidates = [];
    if (typeof process.resourcesPath === "string") {
      candidates.push(path2.join(process.resourcesPath, "resources", "model-catalog.json"));
    }
    candidates.push(path2.join(PROJECT_ROOT, "resources", "model-catalog.json"));
    const file = candidates.find((p) => fs2.existsSync(p));
    if (!file) return [];
    const data = JSON.parse(fs2.readFileSync(file, "utf8"));
    return (Array.isArray(data?.providers) ? data.providers : [])
      .filter((p) => p?.id && p?.baseUrl && Array.isArray(p?.models) && p.models.length)
      .map((p) => ({
        id: String(p.id),
        label: String(p.label || p.id),
        baseUrl: String(p.baseUrl),
        protocol: p.protocol === "anthropic" ? "anthropic" : "openai",
        models: p.models.map((m) => (typeof m === "string" ? m : String(m?.id || ""))).filter(Boolean),
      }));
  } catch {
    return [];
  }
}

/** BYOK catalog. The SERVER is the source of truth: whatever it delivers (cached
 *  client-side via remote-config) wins per provider id. The bundled snapshot is
 *  only a fallback — it fills providers the server didn't send and covers the
 *  offline / first-run case before any server catalog is cached. */
function mergedProviderCatalog() {
  const byId = new Map();
  for (const p of getBundledProviderCatalog()) byId.set(p.id, p);
  for (const p of remoteConfig.getRemoteProviderCatalogSync()) byId.set(p.id, p);
  return [...byId.values()];
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
    managedByService: isRemoteManagedCatalog(),
    // Server-published BYOK provider catalog — the renderer's "add model" flow
    // turns this into a provider picker so the user only chooses + enters a key.
    catalog: mergedProviderCatalog(),
    presets: getAllPresets().map((p) => ({
      id: p.id,
      label: p.label,
      description: p.description || "",
      model: p.model || pickModelId(normalizeToLilyEnv(p.env || {})) || pickModelId(settingsEnv) || "",
      modelHaiku: p.modelHaiku || "",
      modelSonnet: p.modelSonnet || "",
      modelOpus: p.modelOpus || "",
      baseUrl: p.baseUrl || "",
      protocol: p.protocol || "",
      apiKeySet: Boolean(p.apiKeySet),
      tlsSkipVerify: Boolean(p.tlsSkipVerify),
      capabilities: { vision: Boolean(p.capabilities?.vision) },
      custom: Boolean(p.custom),
    })),
  };
}

function setActivePreset(presetId) {
  const found = findPresetById(presetId);
  if (!found) return { ok: false, error: "NOT_FOUND" };
  const user = loadUserChoice();
  const next = { ...user, activePresetId: presetId };
  if (!found.custom && presetHasOwnModelConnection(found)) {
    next.apiGateway = normalizeApiGateway(null);
  }
  persistUserChoice(next);
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
  protocol = "",
  tlsSkipVerify = false,
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

  const urlValidated = validateBaseUrl(baseUrl, { required: true });
  if (!urlValidated.ok) return urlValidated;

  const keyValidated = validateApiKey(apiKey, {
    required: Boolean(urlValidated.baseUrl) && !isLoopbackBaseUrl(urlValidated.baseUrl),
  });
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
    tlsSkipVerify: Boolean(tlsSkipVerify && urlValidated.baseUrl),
    // Carried from the provider catalog so anthropic vs openai-compatible
    // endpoints resolve correctly instead of relying on URL auto-detection.
    protocol: normalizeProtocol(protocol) || legacyProtocolForBaseUrl(urlValidated.baseUrl),
  };
  const customPresets = [...(user.customPresets || []), entry];
  persistUserChoice({ ...user, customPresets, activePresetId: id });
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
    activePresetId = loadCatalog().activePresetId || loadCatalog().presets[0]?.id || null;
  }

  persistUserChoice({ ...user, customPresets, activePresetId });
  return { ok: true, ...listPresetsPublic() };
}

function setApiGateway({ mode, baseUrl, apiKey, protocol, tlsSkipVerify }) {
  const user = loadUserChoice();
  const nextMode = mode === "custom" ? "custom" : "builtin";

  if (nextMode === "builtin") {
    persistUserChoice({
      ...user,
      apiGateway: normalizeApiGateway(null),
    });
    return { ok: true, ...listPresetsPublic() };
  }

  const urlValidated = validateBaseUrl(baseUrl, { required: true });
  if (!urlValidated.ok) return urlValidated;

  const keyValidated = validateApiKey(apiKey, {
    required: !isLoopbackBaseUrl(urlValidated.baseUrl),
    existing: user.apiGateway?.apiKey || "",
  });
  if (!keyValidated.ok) return keyValidated;

  persistUserChoice({
    ...user,
    apiGateway: {
      mode: "custom",
      baseUrl: urlValidated.baseUrl,
      apiKey: keyValidated.apiKey,
      protocol: normalizeProtocol(protocol) || legacyProtocolForBaseUrl(urlValidated.baseUrl),
      tlsSkipVerify: Boolean(tlsSkipVerify),
    },
  });
  return { ok: true, ...listPresetsPublic() };
}

function diagnoseAndRestoreDefaultModel() {
  const user = loadUserChoice();
  const activePreset = findPresetById(getActivePresetId());
  const catalog = loadCatalog();
  const builtinPresets = getBuiltinPresets();
  const defaultPresetId =
    (catalog.activePresetId && builtinPresets.some((preset) => preset.id === catalog.activePresetId) ? catalog.activePresetId : "") ||
    builtinPresets[0]?.id ||
    null;
  const next = {
    ...user,
    activePresetId: defaultPresetId,
    apiGateway: normalizeApiGateway(null),
  };
  persistUserChoice(next);
  return {
    ok: true,
    activePresetId: defaultPresetId,
    diagnostics: {
      wasCustomPreset: Boolean(activePreset?.custom),
      hadCustomApiGateway: user.apiGateway?.mode === "custom",
      managedPresetAvailable: Boolean(defaultPresetId),
      previousPresetId: activePreset?.id || user.activePresetId || "",
      customPresetCount: (user.customPresets || []).length,
    },
    ...listPresetsPublic(),
  };
}

function reloadPresets() {
  cachedCatalog = null;
  cachedUserChoice = null;
  remoteConfig.reloadRemoteConfigCache();
}

remoteConfig.onRemoteConfigRefreshed(reloadPresets);

module.exports = {
  getActivePreset,
  activePresetSupportsVision,
  getActivePresetEnv,
  getUserApiEnv,
  getActiveModelConnectionStatus,
  getActivePresetId,
  listPresetsPublic,
  getApiGatewayPublic,
  setActivePreset,
  saveCustomPreset,
  deleteCustomPreset,
  setApiGateway,
  diagnoseAndRestoreDefaultModel,
  reloadPresets,
};
