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
  const servicePresetIds = new Set(loadCatalog().presets.map((preset) => preset.id).filter(Boolean));
  const normalizedCustom = normalizeCustomPresetEntries(raw?.customPresets, raw?.activePresetId, servicePresetIds);
  cachedUserChoice = {
    activePresetId: normalizedCustom.activePresetId,
    customPresets: normalizedCustom.customPresets,
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
    normalizedCustom.changed ||
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
  const compatibilityProfile = normalizeCompatibilityProfile(entry?.compatibilityProfile);
  return {
    ...(entry && typeof entry === "object" ? entry : {}),
    protocol: normalizeProtocol(entry?.protocol) || legacyProtocolForBaseUrl(baseUrl),
    compatibilityProfile,
    requestBodyOverlay: normalizeRequestBodyOverlay(entry?.requestBodyOverlay || compatibilityProfile?.requestBodyOverlay),
  };
}

function normalizeRequestBodyOverlay(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function normalizeCompatibilityProfile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const requestBodyOverlay = normalizeRequestBodyOverlay(value.requestBodyOverlay);
  const rawConformance = value.conformance;
  const conformance = rawConformance && typeof rawConformance === "object" && !Array.isArray(rawConformance)
    ? {
        chatCompletions: Boolean(rawConformance.chatCompletions),
        streaming: Boolean(rawConformance.streaming),
        toolCalls: Boolean(rawConformance.toolCalls),
        contentSource: String(rawConformance.contentSource || ""),
        ...(rawConformance.toolShape ? { toolShape: String(rawConformance.toolShape) } : {}),
      }
    : null;
  const rawPrompt = value.prompt;
  const prompt = rawPrompt && typeof rawPrompt === "object" && !Array.isArray(rawPrompt)
    ? {
        systemMaxChars: Number.isFinite(Number(rawPrompt.systemMaxChars)) && Number(rawPrompt.systemMaxChars) > 0
          ? Math.floor(Number(rawPrompt.systemMaxChars))
          : null,
      }
    : null;
  // Probed capability grade (仿 toolShapeCompat): normalize only known evidence
  // values before handing them to runtime env builders. Anything else is dropped
  // — no capability field means "standard" (today's behavior) everywhere.
  const rawCapability = value.capability;
  const capabilityGrade = ["full", "standard", "lite"].includes(String(rawCapability?.grade || ""))
    ? String(rawCapability.grade)
    : "";
  const capabilityConfidence = rawCapability?.confidence === "confirmed" ? "confirmed" : "";
  const rawRecipes = rawCapability?.recipes;
  const ceilingValue = Number(rawRecipes?.outputTokenCeiling);
  const promptBudgetValue = Number(rawRecipes?.systemPromptBudget);
  const recipes = rawRecipes && typeof rawRecipes === "object" && !Array.isArray(rawRecipes)
    ? {
        ...(["zh", "en"].includes(String(rawRecipes.instructionLanguage || ""))
          ? { instructionLanguage: String(rawRecipes.instructionLanguage) }
          : {}),
        ...(rawRecipes.toolCallHint === true ? { toolCallHint: true } : {}),
        ...(Number.isFinite(ceilingValue) && ceilingValue >= 256 && ceilingValue <= 65536
          ? { outputTokenCeiling: Math.floor(ceilingValue) }
          : {}),
        // v7 large-prompt stress budget: only sane, probe-produced values pass.
        ...(Number.isFinite(promptBudgetValue) && promptBudgetValue >= 2000 && promptBudgetValue <= 60000
          ? { systemPromptBudget: Math.floor(promptBudgetValue) }
          : {}),
      }
    : {};
  const capability = capabilityGrade
    ? {
        grade: capabilityGrade,
        ...(capabilityConfidence ? { confidence: capabilityConfidence } : {}),
        ...(rawCapability.signals && typeof rawCapability.signals === "object" && !Array.isArray(rawCapability.signals)
          ? {
              signals: {
                instructionFidelity: Boolean(rawCapability.signals.instructionFidelity),
                toolChoiceAuto: Boolean(rawCapability.signals.toolChoiceAuto),
                ...(typeof rawCapability.signals.largePromptStable === "boolean"
                  ? { largePromptStable: rawCapability.signals.largePromptStable }
                  : {}),
              },
            }
          : {}),
        ...(Object.keys(recipes).length ? { recipes } : {}),
      }
    : null;
  const out = {};
  const probeVersion = Number.isFinite(Number(value.probeVersion)) && Number(value.probeVersion) > 0
    ? Math.floor(Number(value.probeVersion))
    : null;
  if (probeVersion) out.probeVersion = probeVersion;
  if (requestBodyOverlay) out.requestBodyOverlay = requestBodyOverlay;
  if (value.toolShapeCompat === true) out.toolShapeCompat = true;
  if (capability) out.capability = capability;
  if (conformance) out.conformance = conformance;
  if (prompt?.systemMaxChars) out.prompt = prompt;
  return Object.keys(out).length ? out : null;
}

function hasCurrentCompatibilityEvidence(compatibilityProfile) {
  const version = Number(compatibilityProfile?.probeVersion);
  return Number.isFinite(version) && version >= 6;
}

function runtimeCapabilityGrade(compatibilityProfile) {
  const capability = compatibilityProfile?.capability;
  const grade = String(capability?.grade || "");
  // Lite removes tools/context, so legacy or ambiguous evidence must fail open
  // to the strong default. Full/standard remain non-destructive and unchanged.
  if (
    grade === "lite" &&
    (capability?.confidence !== "confirmed" || !hasCurrentCompatibilityEvidence(compatibilityProfile))
  ) return "";
  return grade;
}

function runtimeSystemPromptMaxChars(compatibilityProfile) {
  // v5 and older could persist the length of a successful short sample as a
  // hard ceiling. Only v6+ profiles contain observed-only ceiling evidence.
  if (!hasCurrentCompatibilityEvidence(compatibilityProfile)) return "";
  const maxChars = Number(compatibilityProfile?.prompt?.systemMaxChars);
  return Number.isFinite(maxChars) && maxChars > 0 ? String(Math.floor(maxChars)) : "";
}

/**
 * Convert persisted compatibility evidence into the exact runtime env contract.
 * Both preset activation and standalone evals use this path so stale or
 * ambiguous probe evidence cannot be interpreted differently at runtime.
 */
function buildCompatibilityProfileRuntimeEnv(compatibilityProfile, requestBodyOverlay = null) {
  const profile = normalizeCompatibilityProfile(compatibilityProfile);
  const env = {};
  const overlay = normalizeRequestBodyOverlay(requestBodyOverlay || profile?.requestBodyOverlay);
  if (overlay) env.LILY_OPENCODE_BODY_OVERLAY_JSON = JSON.stringify(overlay);

  // Two independent evidence sources cap the system-guide size; the runtime
  // gets the tighter one: an observed explicit size ceiling (v6 prompt probe)
  // and the large-prompt stress budget (v7 — gateway hangs on big inputs).
  const systemPromptMaxChars = Number(runtimeSystemPromptMaxChars(profile)) || 0;
  const stressBudget = Number(profile?.capability?.recipes?.systemPromptBudget) || 0;
  const promptCaps = [systemPromptMaxChars, stressBudget].filter((value) => value > 0);
  if (promptCaps.length) {
    env.LILY_OPENCODE_SYSTEM_PROMPT_MAX_CHARS = String(Math.min(...promptCaps));
  }
  if (profile?.toolShapeCompat) {
    env.LILY_OPENCODE_TOOL_COMPAT = "1";
  }
  const capabilityGrade = runtimeCapabilityGrade(profile);
  if (capabilityGrade) {
    env.LILY_MODEL_CAPABILITY_GRADE = capabilityGrade;
  }
  if (profile?.capability?.recipes) {
    env.LILY_MODEL_RECIPES = JSON.stringify(profile.capability.recipes);
  }
  return env;
}

function normalizeCustomPresetEntries(entries, activePresetId, servicePresetIds = new Set()) {
  const customPresets = [];
  const existingIds = new Set(servicePresetIds);
  let nextActivePresetId = activePresetId || null;
  let changed = false;

  for (const rawEntry of Array.isArray(entries) ? entries : []) {
    if (!rawEntry || typeof rawEntry !== "object") {
      changed = true;
      continue;
    }
    const entry = normalizeCustomPresetEntry(rawEntry);
    const oldId = String(entry.id || "").trim();
    const collidesWithService = servicePresetIds.has(oldId);
    const needsCustomNamespace = !oldId.startsWith(CUSTOM_ID_PREFIX);
    const duplicate = Boolean(oldId && existingIds.has(oldId) && !collidesWithService);
    if (!oldId || collidesWithService || needsCustomNamespace || duplicate) {
      entry.id = makeCustomId(entry.label, entry.model || oldId || entry.label, existingIds);
      changed = true;
      if (nextActivePresetId === oldId) {
        // If a local record impersonated a service preset, fail open to the
        // service default instead of keeping the bad local connection active.
        nextActivePresetId = collidesWithService ? null : entry.id;
      }
    } else {
      entry.id = oldId;
    }
    existingIds.add(entry.id);
    customPresets.push(entry);
  }

  if (nextActivePresetId && !existingIds.has(nextActivePresetId) && activePresetId !== nextActivePresetId) {
    changed = true;
  }
  return { customPresets, activePresetId: nextActivePresetId, changed };
}

function hasMissingProtocolMetadata(stored) {
  if (!stored || typeof stored !== "object") return false;
  const gateway = stored.apiGateway;
  if (gateway?.mode === "custom" && gateway.baseUrl && !normalizeProtocol(gateway.protocol)) return true;
  return (Array.isArray(stored.customPresets) ? stored.customPresets : []).some((preset) =>
    preset?.baseUrl && !normalizeProtocol(preset.protocol));
}

function countRepairableCustomPresetIds(raw, servicePresetIds = new Set()) {
  let count = 0;
  for (const preset of Array.isArray(raw?.customPresets) ? raw.customPresets : []) {
    const id = String(preset?.id || "").trim();
    if (!id || !id.startsWith(CUSTOM_ID_PREFIX) || servicePresetIds.has(id)) count += 1;
  }
  return count;
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
  const env = envFromTierModels(entry);
  Object.assign(env, buildCompatibilityProfileRuntimeEnv(entry.compatibilityProfile, entry.requestBodyOverlay));
  const protocol = normalizeProtocol(entry.protocol) || legacyProtocolForBaseUrl(baseUrl);
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
    protocol,
    apiKeySet: Boolean(apiKey),
    tlsSkipVerify: Boolean(entry.tlsSkipVerify && baseUrl),
    custom: true,
    env,
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
      Object.assign(env, buildCompatibilityProfileRuntimeEnv(entry.compatibilityProfile, entry.requestBodyOverlay));
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
  requestBodyOverlay = null,
  compatibilityProfile = null,
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
  const normalizedCompatibilityProfile = normalizeCompatibilityProfile(compatibilityProfile);
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
    compatibilityProfile: normalizedCompatibilityProfile,
    requestBodyOverlay: normalizeRequestBodyOverlay(requestBodyOverlay || normalizedCompatibilityProfile?.requestBodyOverlay),
    // Carried from the provider catalog so anthropic vs openai-compatible
    // endpoints resolve correctly instead of relying on URL auto-detection.
    protocol: normalizeProtocol(protocol) || legacyProtocolForBaseUrl(urlValidated.baseUrl),
  };
  const customPresets = [...(user.customPresets || []), entry];
  persistUserChoice({ ...user, customPresets, activePresetId: id });
  return { ok: true, preset: customPresetRecord(entry), ...listPresetsPublic() };
}

function sameCustomConnection(a, b) {
  return (
    String(a?.model || "").trim() === String(b?.model || "").trim() &&
    String(a?.baseUrl || "").trim() === String(b?.baseUrl || "").trim() &&
    String(a?.apiKey || "").trim() === String(b?.apiKey || "").trim() &&
    (normalizeProtocol(a?.protocol) || legacyProtocolForBaseUrl(a?.baseUrl)) ===
      (normalizeProtocol(b?.protocol) || legacyProtocolForBaseUrl(b?.baseUrl))
  );
}

function updateCustomPreset(presetId, {
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
  requestBodyOverlay = undefined,
  compatibilityProfile = undefined,
} = {}) {
  if (!String(presetId || "").startsWith(CUSTOM_ID_PREFIX)) {
    return { ok: false, error: "NOT_CUSTOM" };
  }

  const user = loadUserChoice();
  const customPresets = [...(user.customPresets || [])];
  const index = customPresets.findIndex((p) => p.id === presetId);
  if (index < 0) return { ok: false, error: "NOT_FOUND" };

  const previous = normalizeCustomPresetEntry(customPresets[index]);
  const validated = validateCustomInput(label, model);
  if (!validated.ok) return validated;

  for (const [, value, error] of [
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
    existing: previous.apiKey || "",
  });
  if (!keyValidated.ok) return keyValidated;

  const haikuValidated = validateOptionalModelId(modelHaiku);
  const sonnetValidated = validateOptionalModelId(modelSonnet);
  const opusValidated = validateOptionalModelId(modelOpus);
  const subagentValidated = validateOptionalModelId(modelSubagent);
  const nextProtocol = normalizeProtocol(protocol) || legacyProtocolForBaseUrl(urlValidated.baseUrl);
  const nextConnection = {
    model: validated.model,
    baseUrl: urlValidated.baseUrl,
    apiKey: keyValidated.apiKey,
    protocol: nextProtocol,
  };
  const canKeepProfile = sameCustomConnection(previous, nextConnection);
  const normalizedCompatibilityProfile = compatibilityProfile === undefined
    ? (canKeepProfile ? normalizeCompatibilityProfile(previous.compatibilityProfile) : null)
    : normalizeCompatibilityProfile(compatibilityProfile);
  const normalizedRequestBodyOverlay = requestBodyOverlay === undefined
    ? (canKeepProfile
        ? normalizeRequestBodyOverlay(previous.requestBodyOverlay || normalizedCompatibilityProfile?.requestBodyOverlay)
        : normalizeRequestBodyOverlay(normalizedCompatibilityProfile?.requestBodyOverlay))
    : normalizeRequestBodyOverlay(requestBodyOverlay || normalizedCompatibilityProfile?.requestBodyOverlay);

  const entry = {
    id: previous.id,
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
    compatibilityProfile: normalizedCompatibilityProfile,
    requestBodyOverlay: normalizedRequestBodyOverlay,
    protocol: nextProtocol,
  };
  customPresets[index] = entry;
  persistUserChoice({ ...user, customPresets });
  return { ok: true, preset: customPresetRecord(entry), ...listPresetsPublic() };
}

async function saveCustomPresetWithProbe(input = {}) {
  const protocol = normalizeProtocol(input.protocol) || legacyProtocolForBaseUrl(input.baseUrl);
  if (normalizeRequestBodyOverlay(input.requestBodyOverlay) || protocol !== "openai") {
    return saveCustomPreset(input);
  }
  const urlValidated = validateBaseUrl(input.baseUrl, { required: true });
  if (!urlValidated.ok) return urlValidated;
  const keyValidated = validateApiKey(input.apiKey, {
    required: Boolean(urlValidated.baseUrl) && !isLoopbackBaseUrl(urlValidated.baseUrl),
  });
  if (!keyValidated.ok) return keyValidated;
  const modelValidated = validateCustomInput(input.label, input.model);
  if (!modelValidated.ok) return modelValidated;

  const probe = await require("./model-compatibility-probe").probeCustomModelProfile({
    protocol,
    baseUrl: urlValidated.baseUrl,
    apiKey: keyValidated.apiKey,
    model: modelValidated.model,
    systemPromptProbeText: input.systemPromptProbeText || "",
    timeoutMs: Number(input.probeTimeoutMs || 10_000),
  });
  if (!probe.ok) {
    return {
      ok: false,
      error: probe.error || "MODEL_PROBE_FAILED",
    };
  }
  return saveCustomPreset({
    ...input,
    protocol,
    baseUrl: urlValidated.baseUrl,
    apiKey: keyValidated.apiKey,
    compatibilityProfile: probe.profile || null,
    requestBodyOverlay: probe.profile?.requestBodyOverlay || null,
  });
}

async function updateCustomPresetWithProbe(presetId, input = {}) {
  const user = loadUserChoice();
  const previous = normalizeCustomPresetEntry((user.customPresets || []).find((p) => p.id === presetId));
  if (!previous?.id) return { ok: false, error: "NOT_FOUND" };

  const protocol = normalizeProtocol(input.protocol) || legacyProtocolForBaseUrl(input.baseUrl);
  const urlValidated = validateBaseUrl(input.baseUrl, { required: true });
  if (!urlValidated.ok) return urlValidated;
  const keyValidated = validateApiKey(input.apiKey, {
    required: Boolean(urlValidated.baseUrl) && !isLoopbackBaseUrl(urlValidated.baseUrl),
    existing: previous.apiKey || "",
  });
  if (!keyValidated.ok) return keyValidated;
  const modelValidated = validateCustomInput(input.label, input.model);
  if (!modelValidated.ok) return modelValidated;

  const nextConnection = {
    model: modelValidated.model,
    baseUrl: urlValidated.baseUrl,
    apiKey: keyValidated.apiKey,
    protocol,
  };
  const hasExplicitOverlay = Boolean(normalizeRequestBodyOverlay(input.requestBodyOverlay));
  const previousProfile = normalizeCompatibilityProfile(previous.compatibilityProfile);
  // A profile from an older probe version must not suppress re-probing: the
  // newer probe detects gateway defects the stored profile predates.
  const { PROBE_PROFILE_VERSION } = require("./model-compatibility-probe");
  const hasExistingProfile = Boolean(
    (previousProfile || normalizeRequestBodyOverlay(previous.requestBodyOverlay)) &&
      Number(previousProfile?.probeVersion) >= PROBE_PROFILE_VERSION,
  );
  if (
    hasExplicitOverlay ||
    protocol !== "openai" ||
    (sameCustomConnection(previous, nextConnection) && hasExistingProfile)
  ) {
    return updateCustomPreset(presetId, {
      ...input,
      protocol,
      baseUrl: urlValidated.baseUrl,
      apiKey: keyValidated.apiKey,
    });
  }

  const probe = await require("./model-compatibility-probe").probeCustomModelProfile({
    protocol,
    baseUrl: urlValidated.baseUrl,
    apiKey: keyValidated.apiKey,
    model: modelValidated.model,
    systemPromptProbeText: input.systemPromptProbeText || "",
    timeoutMs: Number(input.probeTimeoutMs || 10_000),
  });
  if (!probe.ok) {
    return {
      ok: false,
      error: probe.error || "MODEL_PROBE_FAILED",
    };
  }
  return updateCustomPreset(presetId, {
    ...input,
    protocol,
    baseUrl: urlValidated.baseUrl,
    apiKey: keyValidated.apiKey,
    compatibilityProfile: probe.profile || null,
    requestBodyOverlay: probe.profile?.requestBodyOverlay || null,
  });
}

/** Eligibility only: custom openai preset with its own connection + model. */
function customPresetSupportsCompatibilityProbe(entry) {
  const normalized = normalizeCustomPresetEntry(entry);
  if (!normalized?.id) return false;
  const baseUrl = String(normalized.baseUrl || "").trim();
  if (!baseUrl) return false;
  const protocol = normalizeProtocol(normalized.protocol) || legacyProtocolForBaseUrl(baseUrl);
  if (protocol !== "openai") return false;
  return Boolean(normalized.model);
}

function customPresetNeedsCompatibilityProbe(entry) {
  if (!customPresetSupportsCompatibilityProbe(entry)) return false;
  const normalized = normalizeCustomPresetEntry(entry);
  const compatibilityProfile = normalizeCompatibilityProfile(normalized.compatibilityProfile);
  // Profiles from older probe versions are stale: newer probes detect gateway
  // defects (e.g. tool-shape limits) the old profile knows nothing about.
  const { PROBE_PROFILE_VERSION } = require("./model-compatibility-probe");
  const isCurrentProbe = Number(compatibilityProfile?.probeVersion) >= PROBE_PROFILE_VERSION;
  // A current probe with no prompt ceiling means the tested sample fit without
  // exposing a limit; absence is a valid finding, not a reason to probe forever.
  if (compatibilityProfile && isCurrentProbe) return false;
  return Boolean(normalized.model);
}

async function repairCustomPresetCompatibilityProfiles({ activeOnly = false, force = false, systemPromptProbeText = "", timeoutMs = 10_000 } = {}) {
  const user = loadUserChoice();
  const customPresets = [...(user.customPresets || [])];
  let repairedCount = 0;
  let changedCount = 0;
  const errors = [];

  for (let index = 0; index < customPresets.length; index += 1) {
    const entry = normalizeCustomPresetEntry(customPresets[index]);
    if (activeOnly && entry.id !== getActivePresetId()) continue;
    // force (runtime self-heal) re-probes even a current-version profile —
    // the gateway may have changed behind an unchanged connection config.
    if (force ? !customPresetSupportsCompatibilityProbe(entry) : !customPresetNeedsCompatibilityProbe(entry)) continue;

    const urlValidated = validateBaseUrl(entry.baseUrl, { required: true });
    const keyValidated = validateApiKey(entry.apiKey, {
      required: Boolean(urlValidated.baseUrl) && !isLoopbackBaseUrl(urlValidated.baseUrl),
    });
    if (!urlValidated.ok || !keyValidated.ok) {
      errors.push({ id: entry.id, error: urlValidated.error || keyValidated.error });
      continue;
    }

    const probe = await require("./model-compatibility-probe").probeCustomModelProfile({
      protocol: "openai",
      baseUrl: urlValidated.baseUrl,
      apiKey: keyValidated.apiKey,
      model: entry.model,
      systemPromptProbeText,
      timeoutMs: Number(timeoutMs || 10_000),
    });
    if (!probe.ok) {
      errors.push({ id: entry.id, error: probe.error || "MODEL_PROBE_FAILED" });
      continue;
    }
    const nextProfile = normalizeCompatibilityProfile(probe.profile);
    const previousProfile = normalizeCompatibilityProfile(entry.compatibilityProfile);
    if (JSON.stringify(nextProfile) !== JSON.stringify(previousProfile)) changedCount += 1;
    customPresets[index] = {
      ...entry,
      baseUrl: urlValidated.baseUrl,
      apiKey: keyValidated.apiKey,
      compatibilityProfile: nextProfile,
      requestBodyOverlay: normalizeRequestBodyOverlay(probe.profile?.requestBodyOverlay),
    };
    repairedCount += 1;
  }

  if (repairedCount > 0) {
    persistUserChoice({ ...user, customPresets });
  }
  return { ok: true, repairedCount, changedCount, errors, ...listPresetsPublic() };
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
  const storedBefore = readJson(userSettingsPath(), null);
  const servicePresetIds = new Set(loadCatalog().presets.map((preset) => preset.id).filter(Boolean));
  const repairableCustomPresetCount = countRepairableCustomPresetIds(storedBefore, servicePresetIds);
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
      repairedCustomPresetCount: repairableCustomPresetCount,
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
  buildCompatibilityProfileRuntimeEnv,
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
  saveCustomPresetWithProbe,
  updateCustomPreset,
  updateCustomPresetWithProbe,
  repairCustomPresetCompatibilityProfiles,
  deleteCustomPreset,
  setApiGateway,
  diagnoseAndRestoreDefaultModel,
  reloadPresets,
};
