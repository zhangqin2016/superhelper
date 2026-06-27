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

const cache = new Map(); // providerId -> { at, models }
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

// Pure, fetch-injectable for tests. Returns filtered chat model ids, or [] on any
// failure / unknown provider / missing key.
export async function fetchProviderModels(provider, fetchImpl = fetch) {
  if (!provider?.apiKey) return [];
  const req = modelsRequest(provider);
  if (!req) return [];
  try {
    const response = await fetchImpl(req.url, { headers: req.headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) return [];
    const data = await response.json();
    const list = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
    return [...new Set(list.map((item) => String(item?.id || item?.name || "").trim()).filter(Boolean))].filter(
      (id) => !NON_CHAT.test(id),
    );
  } catch {
    return [];
  }
}

// Sync read for the (sync) client-config builder. Returns the cached discovery for
// a provider, refreshing in the background when stale. First call returns []
// (→ configured list); later builds include discovered models. No-op when the
// feature is disabled.
export function discoveredModelsSync(provider) {
  if (!config.modelDiscoveryEnabled) return [];
  const id = provider?.id;
  if (!id || !provider.apiKey) return [];
  const entry = cache.get(id);
  if ((!entry || Date.now() - entry.at > TTL_MS) && !inflight.has(id)) {
    const job = fetchProviderModels(provider)
      .then((models) => cache.set(id, { at: Date.now(), models }))
      .catch(() => cache.set(id, { at: Date.now(), models: [] }))
      .finally(() => inflight.delete(id));
    inflight.set(id, job);
  }
  return entry?.models || [];
}
