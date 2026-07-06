"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { userDataPath } = require("./config");

// Image/video/speech generation provider selection for the desktop client.
// Per modality the user chooses a SOURCE:
//   - "service": use what we deliver (server-side key/gateway). Only providers
//                the Workbench actually enabled are offered.
//   - "own"    : bring-your-own-key (BYOK). The user's key is stored locally
//                and injected as env so the skill connects directly.
// The assistant can still override image/video per-call via input.provider.

const PROVIDERS = [
  { id: "lily", label: "Lily 自有 GPU（Qwen-Image / Wan / Qwen3-TTS）", fields: [], modalities: ["image", "video", "speech"], byok: false },
  { id: "dashscope", label: "阿里百炼 Qwen-Image / 通义万相 / CosyVoice", fields: ["apiKey"], modalities: ["image", "video", "speech"] },
  { id: "volcengine", label: "火山方舟 · 即梦 Seedream / Seedance", fields: ["apiKey"], modalities: ["image", "video"] },
  { id: "kling", label: "可灵 Kling", fields: ["accessKey", "secretKey"], modalities: ["image", "video"] },
  { id: "minimax", label: "MiniMax 海螺", fields: ["apiKey", "groupId"], modalities: ["image", "video"] },
  { id: "zhipu", label: "智谱 CogView / CogVideoX", fields: ["apiKey"], modalities: ["image", "video"] },
];

const PROVIDER_IDS = new Set(PROVIDERS.map((p) => p.id));
const MODALITIES = ["image", "video", "speech"];
const MODALITY_ENV = {
  image: "LILY_IMAGE_PROVIDER",
  video: "LILY_VIDEO_PROVIDER",
  speech: "LILY_SPEECH_PROVIDER",
};
const MODALITY_MODEL = {
  image: { field: "imageModel", suffix: "IMAGE" },
  video: { field: "videoModel", suffix: "VIDEO" },
  speech: { field: "speechModel", suffix: "TTS" },
};
const ENV_PREFIX = { dashscope: "DASHSCOPE", volcengine: "VOLCENGINE", kling: "KLING", minimax: "MINIMAX", zhipu: "ZHIPU" };
const MODEL_FIELDS = Object.values(MODALITY_MODEL).map((item) => item.field);

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

function providerSupports(provider, modality) {
  const spec = PROVIDERS.find((p) => p.id === provider);
  return Boolean(spec?.modalities?.includes(modality));
}

function normalizeModality(value, modality) {
  const source = value?.source === "own" ? "own" : "service";
  const provider = PROVIDER_IDS.has(value?.provider) && providerSupports(value.provider, modality) ? value.provider : "";
  return { source, provider };
}

function loadSettings() {
  if (cached) return cached;
  const stored = readJson(userSettingsPath(), null) || {};
  const keys = stored.keys && typeof stored.keys === "object" ? stored.keys : {};
  cached = {
    image: normalizeModality(stored.image, "image"),
    video: normalizeModality(stored.video, "video"),
    speech: normalizeModality(stored.speech, "speech"),
    keys,
  };
  return cached;
}

function saveSettings(next) {
  cached = next;
  writeJson(userSettingsPath(), next);
}

// Server-distributed media-gen selection, or null on old servers. Null keeps
// today's behavior: all key-backed providers are available and server defaults
// from runtime env continue to drive dispatch.
function remoteMediaSelection() {
  try {
    const cfg = require("./remote-config").getRemoteEffectiveConfigSync();
    const media = cfg && typeof cfg.media === "object" ? cfg.media : null;
    if (!media) return null;
    const kind = (m, modality) => ({
      providers: Array.isArray(m?.providers) ? m.providers.filter((p) => PROVIDER_IDS.has(p) && providerSupports(p, modality)) : [],
      default: PROVIDER_IDS.has(m?.default) && providerSupports(m.default, modality) ? m.default : "",
    });
    return {
      image: kind(media.image, "image"),
      video: kind(media.video, "video"),
      speech: kind(media.speech, "speech"),
    };
  } catch {
    return null;
  }
}

function remoteMediaContracts() {
  try {
    const cfg = require("./remote-config").getRemoteEffectiveConfigSync();
    const media = cfg && typeof cfg.media === "object" ? cfg.media : null;
    const contracts = media && typeof media.contracts === "object" ? media.contracts : null;
    if (!contracts || contracts.schemaVersion !== 1 || typeof contracts.contracts !== "object") return null;
    return contracts;
  } catch {
    return null;
  }
}

function serviceEnabledProvidersByModality() {
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
  const byModality = {};
  for (const modality of MODALITIES) {
    let list = on.filter((p) => providerSupports(p, modality));
    const lilyOn = lilyMediaConfigured(env, modality);
    if (lilyOn) list.unshift("lily");
    const allowed = new Set(sel?.[modality]?.providers || []);
    if (allowed.size) list = list.filter((p) => allowed.has(p) || (p === "lily" && lilyOn));
    byModality[modality] = [...new Set(list)];
  }
  return byModality;
}

function lilyMediaConfigured(env, modality) {
  if (env.LILY_MEDIA_BASE_URL || env.LILY_GPU_BASE_URL) return true;
  if (modality === "image") return Boolean(env.LILY_MEDIA_IMAGE_ENDPOINT || env.LILY_MEDIA_IMAGE_BASE_URL || env.LILY_GPU_IMAGE_ENDPOINT || env.LILY_GPU_IMAGE_BASE_URL);
  if (modality === "video") return Boolean(env.LILY_MEDIA_VIDEO_ENDPOINT || env.LILY_MEDIA_VIDEO_BASE_URL || env.LILY_GPU_VIDEO_ENDPOINT || env.LILY_GPU_VIDEO_BASE_URL);
  if (modality === "speech") return Boolean(env.LILY_MEDIA_SPEECH_ENDPOINT || env.LILY_MEDIA_SPEECH_BASE_URL || env.LILY_MEDIA_TTS_ENDPOINT || env.LILY_MEDIA_TTS_BASE_URL || env.LILY_GPU_SPEECH_ENDPOINT || env.LILY_GPU_SPEECH_BASE_URL || env.LILY_GPU_TTS_ENDPOINT || env.LILY_GPU_TTS_BASE_URL);
  return false;
}

function keysPresent(keys) {
  const present = {};
  for (const provider of PROVIDERS) {
    const stored = keys[provider.id] || {};
    present[provider.id] = provider.fields.every((field) => String(stored[field] || "").trim());
  }
  return present;
}

function modelIds(keys) {
  const out = {};
  for (const provider of PROVIDERS) {
    const stored = keys[provider.id] || {};
    out[provider.id] = {};
    for (const field of MODEL_FIELDS) out[provider.id][field] = stored[field] || "";
  }
  return out;
}

function listMediaProvidersPublic() {
  const settings = loadSettings();
  const serviceProvidersByModality = serviceEnabledProvidersByModality();
  return {
    image: settings.image,
    video: settings.video,
    speech: settings.speech,
    providers: PROVIDERS.map(({ id, label, fields, modalities, byok }) => ({ id, label, fields, modalities, byok })),
    serviceProviders: [...new Set([...serviceProvidersByModality.image, ...serviceProvidersByModality.video])],
    serviceProvidersByModality,
    serviceSelection: remoteMediaSelection(),
    serviceContracts: remoteMediaContracts(),
    keysPresent: keysPresent(settings.keys),
    modelIds: modelIds(settings.keys),
  };
}

function getEffectiveMediaProviderChoices() {
  const settings = loadSettings();
  const serviceProvidersByModality = serviceEnabledProvidersByModality();
  const serviceSelection = remoteMediaSelection();
  const present = keysPresent(settings.keys);
  const out = {};
  for (const modality of MODALITIES) {
    const choice = settings[modality];
    const serviceProviders = new Set(serviceProvidersByModality[modality] || []);
    let provider = "";
    let source = "";
    if (choice.source === "own" && choice.provider && present[choice.provider]) {
      provider = choice.provider;
      source = "own";
    } else {
      const selectedServiceProvider = choice.source === "service" ? choice.provider : "";
      if (selectedServiceProvider && serviceProviders.has(selectedServiceProvider)) {
        provider = selectedServiceProvider;
      } else {
        const defaultProvider = serviceSelection?.[modality]?.default || "";
        if (defaultProvider && serviceProviders.has(defaultProvider)) provider = defaultProvider;
      }
      if (provider) source = "service";
    }
    out[modality] = { provider, source };
  }
  return out;
}

function setModalityChoice(modality, source, provider) {
  if (!MODALITIES.includes(modality)) return { ok: false, error: "BAD_MODALITY" };
  const value = normalizeModality({ source, provider }, modality);
  saveSettings({ ...loadSettings(), [modality]: value });
  return { ok: true };
}

function setProviderKey(provider, values) {
  if (!PROVIDER_IDS.has(provider)) return { ok: false, error: "NOT_FOUND" };
  const spec = PROVIDERS.find((p) => p.id === provider);
  const current = loadSettings();
  const next = { ...(current.keys[provider] || {}) };
  for (const field of spec.fields) {
    const value = String(values?.[field] ?? "").trim();
    if (value) next[field] = value;
  }
  for (const field of MODEL_FIELDS) {
    if (values?.[field] !== undefined) next[field] = String(values[field] || "").trim();
  }
  saveSettings({ ...current, keys: { ...current.keys, [provider]: next } });
  return { ok: true };
}

function byokEnv(provider, keys) {
  const k = keys[provider] || {};
  switch (provider) {
    case "dashscope":
      return k.apiKey
        ? { DASHSCOPE_API_KEY: k.apiKey, DASHSCOPE_IMAGE_BASE_URL: "", DASHSCOPE_VIDEO_BASE_URL: "", DASHSCOPE_TTS_BASE_URL: "" }
        : {};
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

function byokModelEnv(provider, keys, modality) {
  const stored = keys[provider] || {};
  const meta = MODALITY_MODEL[modality];
  const value = String(stored?.[meta?.field] || "").trim();
  if (!value) return {};
  const prefix = ENV_PREFIX[provider];
  return prefix && meta ? { [`${prefix}_${meta.suffix}_MODEL`]: value } : {};
}

function getMediaProviderSpawnEnv() {
  const settings = loadSettings();
  const effective = getEffectiveMediaProviderChoices();
  const env = {};
  const contracts = remoteMediaContracts();
  if (contracts) env.LILY_MEDIA_CONTRACTS_JSON = JSON.stringify(contracts);
  for (const modality of MODALITIES) {
    const choice = settings[modality];
    const providerEnvVar = MODALITY_ENV[modality];
    const provider = effective[modality]?.provider || "";
    if (provider && providerEnvVar) env[providerEnvVar] = provider;
    if (effective[modality]?.source === "own" && choice.provider) {
      Object.assign(env, byokEnv(choice.provider, settings.keys), byokModelEnv(choice.provider, settings.keys, modality));
    }
  }
  return env;
}

module.exports = {
  listMediaProvidersPublic,
  setModalityChoice,
  setProviderKey,
  getMediaProviderSpawnEnv,
  getEffectiveMediaProviderChoices,
  getMediaProviderContracts: remoteMediaContracts,
};
