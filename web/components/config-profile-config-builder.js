// What the form's draft state means as a stored config: the media selection,
// the agent selection, and the provider menu directive. Pure functions — the
// form decides what the operator sees, this decides what gets saved.

export const MEDIA_PROVIDERS = [
  { id: "lily", label: "Lily 自有 GPU" },
  { id: "dashscope", label: "阿里百炼 DashScope" },
  { id: "volcengine", label: "火山方舟 Volcengine" },
  { id: "kling", label: "可灵 Kling" },
  { id: "minimax", label: "MiniMax" },
  { id: "zhipu", label: "智谱 Zhipu" },
];
const MEDIA_PROVIDER_IDS = new Set(MEDIA_PROVIDERS.map((p) => p.id));

// Build the per-scope media-generation selection (multi-select + one default), or null
// when nothing is selected (→ omitted from config → old behavior, never breaks clients).
export function buildMedia(draft) {
  const pick = (providers, def) => {
    const list = (Array.isArray(providers) ? providers : []).filter((p) => MEDIA_PROVIDER_IDS.has(p));
    if (!list.length) return null;
    return { providers: list, default: list.includes(def) ? def : list[0] };
  };
  const image = pick(draft.imageProviders, draft.imageDefault);
  const video = pick(draft.videoProviders, draft.videoDefault);
  const speech = pick(draft.speechProviders, draft.speechDefault);
  if (!image && !video && !speech) return null;
  return { ...(image ? { image } : {}), ...(video ? { video } : {}), ...(speech ? { speech } : {}) };
}

// Build the per-scope agent selection (`config.agents = { available, default? }`), or null
// when nothing is selected (→ omitted from config → old behavior). The server intersects
// `available` with what this scope can actually receive (resolveAgentSelection) and drops
// a default that is not in the intersection, so listing ids here is always safe.
export function buildAgents(draft) {
  const available = [...new Set((Array.isArray(draft.agentIds) ? draft.agentIds : []).map((id) => String(id || "").trim()).filter(Boolean))];
  if (!available.length) return null;
  const def = String(draft.agentDefault || "").trim();
  return available.includes(def) ? { available, default: def } : { available };
}

export function deliveryProviderIds(draft, template) {
  const menu = Array.isArray(draft.menuProviders) ? draft.menuProviders.filter(Boolean) : [];
  const defaultProvider = draft.selectedTemplateId || template.provider || template.id || "";
  return Array.from(new Set([defaultProvider, ...menu].filter(Boolean)));
}

export function buildConfig(draft, template) {
  const tools = {
    pluginRegistryUrl: String(draft.pluginRegistryUrl || "/api/skills/registry").trim(),
    enabledPluginIds: splitCsv(draft.enabledPluginIds),
  };
  const policy = {
    permissionMode: String(draft.permissionMode || "default").trim(),
    minAppVersion: String(draft.minAppVersion || "").trim(),
  };
  const runtime = {
    env: {
      API_TIMEOUT_MS: String(draft.requestTimeoutMs || "300000").trim(),
      VISION_MODEL: String(draft.visionModel || "qwen3.7-plus").trim(),
    },
  };
  const media = buildMedia(draft);
  const mediaPart = media ? { media } : {};
  const agents = buildAgents(draft);
  const agentsPart = agents ? { agents } : {};

  // Delivery rules record only a provider directive. The server expands it into
  // a signed gateway model menu at client-config time, so profiles never carry
  // upstream URLs or provider keys.
  const providers = deliveryProviderIds(draft, template);
  const activeProvider = providers.includes(draft.selectedTemplateId) ? draft.selectedTemplateId : providers[0] || "";
  const capabilities = Object.fromEntries(
    providers
      .filter((providerId) => Boolean(draft.providerCapabilities?.[providerId]?.vision))
      .map((providerId) => [providerId, { vision: true }]),
  );
  return {
    schemaVersion: 1,
    models: {
      source: "service",
      providers,
      activeProvider,
      capabilities,
    },
    tools,
    policy,
    runtime,
    ...mediaPart,
    ...agentsPart,
  };
}
