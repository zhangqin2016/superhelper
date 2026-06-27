"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { userDataPath } = require("./config");

// Image/video generation provider selection for the desktop client. Per modality
// (image, video) the user chooses a SOURCE:
//   - "service": use what we deliver (server-side key/gateway) — no key needed.
//                Only providers the server actually enabled are offered.
//   - "own"    : bring-your-own-key (BYOK) — the user's key is stored locally and
//                injected as env so the skill connects directly to the provider.
// The assistant can still override per-call via input.provider.

const PROVIDERS = [
  { id: "dashscope", label: "阿里百炼 Qwen-Image / 通义万相", fields: ["apiKey"] },
  { id: "volcengine", label: "火山方舟 · 即梦 Seedream / Seedance", fields: ["apiKey"] },
  { id: "kling", label: "可灵 Kling", fields: ["accessKey", "secretKey"] },
  { id: "minimax", label: "MiniMax 海螺", fields: ["apiKey", "groupId"] },
  { id: "zhipu", label: "智谱 CogView / CogVideoX", fields: ["apiKey"] },
];
const PROVIDER_IDS = new Set(PROVIDERS.map((p) => p.id));
// Env-var prefix per provider — used to inject an optional BYOK model-id override
// (<PREFIX>_IMAGE_MODEL / <PREFIX>_VIDEO_MODEL), which every skill adapter reads.
const ENV_PREFIX = { dashscope: "DASHSCOPE", volcengine: "VOLCENGINE", kling: "KLING", minimax: "MINIMAX", zhipu: "ZHIPU" };
// Optional, non-secret per-modality model overrides stored alongside the key.
const MODEL_FIELDS = ["imageModel", "videoModel"];

let cached = null;

function userSettingsPath() {
  return userDataPath("media-provider-settings.json");
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

function normalizeModality(value) {
  const source = value?.source === "own" ? "own" : "service";
  const provider = PROVIDER_IDS.has(value?.provider) ? value.provider : "";
  return { source, provider };
}

function loadSettings() {
  if (cached) return cached;
  const stored = readJson(userSettingsPath(), null) || {};
  const keys = stored.keys && typeof stored.keys === "object" ? stored.keys : {};
  cached = {
    image: normalizeModality(stored.image),
    video: normalizeModality(stored.video),
    keys,
  };
  return cached;
}

function saveSettings(next) {
  cached = next;
  writeJson(userSettingsPath(), next);
}

// The per-scope media-gen selection the server distributed (multi-select + default),
// or null on old servers that don't send it. Backward-compatible: null => today's
// behavior (all key-backed providers).
function remoteMediaSelection() {
  try {
    const cfg = require("./remote-config").getRemoteEffectiveConfigSync();
    const media = cfg && typeof cfg.media === "object" ? cfg.media : null;
    if (!media) return null;
    const kind = (m) => ({
      providers: Array.isArray(m?.providers) ? m.providers.filter((p) => PROVIDER_IDS.has(p)) : [],
      default: PROVIDER_IDS.has(m?.default) ? m.default : "",
    });
    return { image: kind(media.image), video: kind(media.video) };
  } catch {
    return null;
  }
}

// Which providers the server actually delivered credentials for — detected from
// the delivered runtime env. Drives the "use ours" list so users can't pick a
// provider the service hasn't enabled. When the operator distributed an explicit
// per-scope selection (effectiveConfig.media), further narrow to that set.
function serviceEnabledProviders() {
  let env = {};
  try {
    env = require("./remote-config").getRemoteRuntimeEnvSync() || {};
  } catch {
    env = {};
  }
  const on = [];
  if (env.DASHSCOPE_API_KEY || env.ALIYUN_BAILIAN_API_KEY) on.push("dashscope");
  if (env.VOLCENGINE_API_KEY || env.ARK_API_KEY) on.push("volcengine");
  if (env.KLING_API_KEY || env.KLING_ACCESS_KEY) on.push("kling");
  if (env.MINIMAX_API_KEY) on.push("minimax");
  if (env.ZHIPU_API_KEY || env.BIGMODEL_API_KEY) on.push("zhipu");
  const sel = remoteMediaSelection();
  if (sel) {
    const allowed = new Set([...(sel.image.providers || []), ...(sel.video.providers || [])]);
    if (allowed.size) return on.filter((p) => allowed.has(p));
  }
  return on;
}

// BYOK key completeness per provider (each provider needs all its fields).
function keysPresent(keys) {
  const present = {};
  for (const provider of PROVIDERS) {
    const stored = keys[provider.id] || {};
    present[provider.id] = provider.fields.every((field) => String(stored[field] || "").trim());
  }
  return present;
}

// Non-secret per-provider model overrides, safe to return to the renderer so the
// model-id fields can prefill (credentials are never returned).
function modelIds(keys) {
  const out = {};
  for (const provider of PROVIDERS) {
    const stored = keys[provider.id] || {};
    out[provider.id] = { imageModel: stored.imageModel || "", videoModel: stored.videoModel || "" };
  }
  return out;
}

function listMediaProvidersPublic() {
  const settings = loadSettings();
  return {
    image: settings.image,
    video: settings.video,
    providers: PROVIDERS.map(({ id, label, fields }) => ({ id, label, fields })),
    serviceProviders: serviceEnabledProviders(),
    // Per-modality allowed set + default the operator distributed (null on old
    // servers). Lets the picker constrain to the allowed providers and preselect the
    // distributed default; falls back to today's behavior when null.
    serviceSelection: remoteMediaSelection(),
    keysPresent: keysPresent(settings.keys),
    modelIds: modelIds(settings.keys),
  };
}

function setModalityChoice(modality, source, provider) {
  if (modality !== "image" && modality !== "video") return { ok: false, error: "BAD_MODALITY" };
  const value = normalizeModality({ source, provider });
  saveSettings({ ...loadSettings(), [modality]: value });
  return { ok: true };
}

function setProviderKey(provider, values) {
  if (!PROVIDER_IDS.has(provider)) return { ok: false, error: "NOT_FOUND" };
  const spec = PROVIDERS.find((p) => p.id === provider);
  const current = loadSettings();
  const next = { ...(current.keys[provider] || {}) };
  // Secrets: keep existing when the field is omitted/blank (so re-saving just a
  // model id never wipes the key).
  for (const field of spec.fields) {
    const value = String(values?.[field] ?? "").trim();
    if (value) next[field] = value;
  }
  // Model overrides: set as given (blank clears, reverting to the default model).
  for (const field of MODEL_FIELDS) {
    if (values?.[field] !== undefined) next[field] = String(values[field] || "").trim();
  }
  saveSettings({ ...current, keys: { ...current.keys, [provider]: next } });
  return { ok: true };
}

// Env that makes a BYOK provider connect directly with the user's own key.
// Empty base URLs reset any server-delivered gateway URL so the skill adapter
// falls back to the provider's real endpoint.
function byokEnv(provider, keys) {
  const k = keys[provider] || {};
  switch (provider) {
    case "dashscope":
      return k.apiKey ? { DASHSCOPE_API_KEY: k.apiKey, DASHSCOPE_IMAGE_BASE_URL: "", DASHSCOPE_VIDEO_BASE_URL: "" } : {};
    case "volcengine":
      return k.apiKey ? { VOLCENGINE_API_KEY: k.apiKey, VOLCENGINE_BASE_URL: "" } : {};
    case "kling":
      return k.accessKey && k.secretKey
        ? { KLING_ACCESS_KEY: k.accessKey, KLING_SECRET_KEY: k.secretKey, KLING_API_KEY: "", KLING_BASE_URL: "" }
        : {};
    case "minimax":
      return k.apiKey ? { MINIMAX_API_KEY: k.apiKey, MINIMAX_GROUP_ID: k.groupId || "", MINIMAX_BASE_URL: "" } : {};
    case "zhipu":
      return k.apiKey ? { ZHIPU_API_KEY: k.apiKey, ZHIPU_BASE_URL: "" } : {};
    default:
      return {};
  }
}

// Optional BYOK model-id override for one modality (lets a single-key user point
// at a model their account actually has enabled, instead of the built-in default).
function byokModelEnv(provider, keys, modality) {
  const stored = keys[provider] || {};
  const field = modality === "image" ? "imageModel" : "videoModel";
  const value = String(stored[field] || "").trim();
  if (!value) return {};
  const prefix = ENV_PREFIX[provider];
  return prefix ? { [`${prefix}_${modality === "image" ? "IMAGE" : "VIDEO"}_MODEL`]: value } : {};
}

// Env injected when spawning the agent. Selects the provider per modality and,
// for "own" sources, layers in the user's key + optional model override
// (overriding server-delivered env).
function getMediaProviderSpawnEnv() {
  const settings = loadSettings();
  const env = {};
  const apply = (modality, providerEnvVar) => {
    const choice = settings[modality];
    if (choice.provider) env[providerEnvVar] = choice.provider;
    if (choice.source === "own" && choice.provider) {
      Object.assign(env, byokEnv(choice.provider, settings.keys), byokModelEnv(choice.provider, settings.keys, modality));
    }
  };
  apply("image", "LILY_IMAGE_PROVIDER");
  apply("video", "LILY_VIDEO_PROVIDER");
  return env;
}

module.exports = {
  listMediaProvidersPublic,
  setModalityChoice,
  setProviderKey,
  getMediaProviderSpawnEnv,
};
