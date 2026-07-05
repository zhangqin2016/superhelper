function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function isDeepSeekOpenAiProvider(provider = {}) {
  if (String(provider.type || "").toLowerCase() !== "openai") return false;
  const id = String(provider.id || "").toLowerCase();
  const baseUrl = String(provider.baseUrl || provider.base_url || "").toLowerCase();
  return id === "deepseek" || baseUrl.includes("api.deepseek.com");
}

export function normalizeModelForProtocol(provider = {}, model = "") {
  const value = String(model || "").trim();
  if (!value) return "";
  if (!isDeepSeekOpenAiProvider(provider)) return value;
  if (/^deepseek-v4-pro\[[^\]]+\]$/i.test(value)) return "deepseek-v4-pro";
  if (/^deepseek-v4-flash$/i.test(value)) return "deepseek-v4-pro";
  return value;
}

export function normalizeModelsForProtocol(provider = {}, models = []) {
  const output = [];
  for (const model of Array.isArray(models) ? models : []) {
    const normalized = normalizeModelForProtocol(provider, model);
    if (normalized && !output.includes(normalized)) output.push(normalized);
  }
  return output;
}

function normalizeMetadataForProtocol(provider = {}) {
  const metadata = plainObject(provider.metadata);
  const byModel = plainObject(metadata.models);
  if (!Object.keys(byModel).length) return metadata;
  const models = {};
  for (const [model, value] of Object.entries(byModel)) {
    const normalized = normalizeModelForProtocol(provider, model);
    if (!normalized) continue;
    models[normalized] = models[normalized] || value;
  }
  return { ...metadata, models };
}

export function normalizeProviderForProtocol(provider = {}) {
  if (!provider || typeof provider !== "object") return provider;
  return {
    ...provider,
    model: normalizeModelForProtocol(provider, provider.model),
    models: normalizeModelsForProtocol(provider, provider.models),
    metadata: normalizeMetadataForProtocol(provider),
  };
}
