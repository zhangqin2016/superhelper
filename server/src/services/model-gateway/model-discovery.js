import { config } from "../../config.js";

// Best-effort model auto-discovery. Queries a provider's /models endpoint to find
// the models its key supports, so the client dropdown can offer them without the
// operator hand-listing each one. STRICTLY augmentative + fail-safe: disabled by
// default (config.modelDiscoveryEnabled), and any failure / unknown provider
// returns [] so the caller falls back to the configured/built-in list. It never
// removes or reorders configured models, so it can't make the picker worse.

const TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
// Models a chat picker should not show.
const NON_CHAT = /embed|rerank|whisper|audio|tts|speech|image|vision|moderation|ocr|cosyvoice|paraformer|wanx?|seedream|seedance|sora|veo/i;

const cache = new Map(); // providerId -> { at, models, metadataByModel }
const inflight = new Map();

function trimSlashes(value) {
  return String(value || "").replace(/\/+$/, "");
}

function bearer(provider) {
  return { Authorization: `Bearer ${provider.apiKey}` };
}

// A provider's /models endpoint usually lives on its OpenAI-compatible host,
// which differs from the Anthropic-style chat baseUrl we route through. Known
// providers get an explicit endpoint; unknown OpenAI-type providers fall back to
// `${baseUrl}/models`; anything else returns null (→ no discovery, use config).
function modelsRequest(provider) {
  const byId = {
    deepseek: { url: "https://api.deepseek.com/v1/models", headers: bearer(provider) },
    dashscope: { url: "https://dashscope.aliyuncs.com/compatible-mode/v1/models", headers: bearer(provider) },
    kimi: { url: "https://api.moonshot.cn/v1/models", headers: bearer(provider) },
    glm: { url: "https://open.bigmodel.cn/api/paas/v4/models", headers: bearer(provider) },
    openai: { url: `${trimSlashes(provider.baseUrl)}/models`, headers: bearer(provider) },
    anthropic: { url: "https://api.anthropic.com/v1/models", headers: { "x-api-key": provider.apiKey, "anthropic-version": "2023-06-01" } },
  };
  if (byId[provider.id]) return byId[provider.id];
  if (provider.type === "openai" && provider.baseUrl) return { url: `${trimSlashes(provider.baseUrl)}/models`, headers: bearer(provider) };
  return null;
}

function positiveInt(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.floor(number);
}

function modelMetadataFromItem(item) {
  const maxModelLen = positiveInt(
    item?.max_model_len ??
      item?.maxModelLen ??
      item?.context_length ??
      item?.contextLength ??
      item?.max_context_length ??
      item?.maxContextLength ??
      item?.max_position_embeddings ??
      item?.maxPositionEmbeddings,
  );
  return {
    ...(maxModelLen ? { maxModelLen, contextWindowTokens: maxModelLen } : {}),
  };
}

// Pure, fetch-injectable for tests. Returns filtered chat model ids + per-model
// non-secret capabilities from /models, or an empty catalog on any failure.
export async function fetchProviderModelCatalog(provider, fetchImpl = fetch) {
  if (!provider?.apiKey) return { models: [], metadataByModel: {} };
  const req = modelsRequest(provider);
  if (!req) return { models: [], metadataByModel: {} };
  try {
    const response = await fetchImpl(req.url, { headers: req.headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) return { models: [], metadataByModel: {} };
    const data = await response.json();
    const list = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
    const models = [];
    const metadataByModel = {};
    for (const item of list) {
      const id = String(item?.id || item?.name || "").trim();
      if (!id || NON_CHAT.test(id) || models.includes(id)) continue;
      models.push(id);
      const metadata = modelMetadataFromItem(item);
      if (Object.keys(metadata).length) metadataByModel[id] = metadata;
    }
    return { models, metadataByModel };
  } catch {
    return { models: [], metadataByModel: {} };
  }
}

// Backward-compatible pure helper used by older tests/callers.
export async function fetchProviderModels(provider, fetchImpl = fetch) {
  return (await fetchProviderModelCatalog(provider, fetchImpl)).models;
}

// Sync read for the (sync) client-config builder. Returns the cached discovery for
// a provider, refreshing in the background when stale. First call returns []
// (→ configured list); later builds include discovered models. No-op when the
// feature is disabled.
function refreshProviderDiscoverySync(provider, { includeModels = false } = {}) {
  if (!includeModels && provider?.type !== "openai") return cache.get(provider?.id);
  const id = provider?.id;
  if (!id || !provider.apiKey) return [];
  const entry = cache.get(id);
  if ((!entry || Date.now() - entry.at > TTL_MS) && !inflight.has(id)) {
    const job = fetchProviderModelCatalog(provider)
      .then((catalog) => cache.set(id, { at: Date.now(), models: catalog.models, metadataByModel: catalog.metadataByModel }))
      .catch(() => cache.set(id, { at: Date.now(), models: [], metadataByModel: {} }))
      .finally(() => inflight.delete(id));
    inflight.set(id, job);
  }
  return entry;
}

export function discoveredModelsSync(provider) {
  if (!config.modelDiscoveryEnabled) return [];
  const entry = refreshProviderDiscoverySync(provider, { includeModels: true });
  return entry?.models || [];
}

export function discoveredModelMetadataSync(provider, model) {
  const entry = refreshProviderDiscoverySync(provider, { includeModels: false });
  const id = String(model || "").trim();
  return id && entry?.metadataByModel?.[id] && typeof entry.metadataByModel[id] === "object"
    ? entry.metadataByModel[id]
    : {};
}
