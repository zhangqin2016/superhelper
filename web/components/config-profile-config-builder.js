// What the form's draft state means as a stored config: the media selection,
// the agent selection, and the provider menu directive. Pure functions — the
// form decides what the operator sees, this decides what gets saved.

export function splitCsv(text) {
  return String(text || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

// policy.update key ↔ form draft key.
export const UPDATE_POLICY_FIELDS = [
  ["countdownSeconds", "updateCountdownSeconds"],
  ["deferMinutes", "updateDeferMinutes"],
  ["maxDeferrals", "updateMaxDeferrals"],
];

export const MEDIA_PROVIDERS = [
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
  // How a mandatory update lands, only where the rule sets it: an absent
  // field inherits the delivered default, and the server bounds each value.
  const update = Object.fromEntries(
    UPDATE_POLICY_FIELDS
      .map(([key, draftKey]) => [key, String(draft[draftKey] ?? "").trim()])
      .filter(([, value]) => value !== "")
      .map(([key, value]) => [key, Number(value)]),
  );
  const policy = {
    permissionMode: String(draft.permissionMode || "default").trim(),
    minAppVersion: String(draft.minAppVersion || "").trim(),
    ...(Object.keys(update).length ? { update } : {}),
    // Only where the rule chooses one: absent inherits stable.
    ...(String(draft.updateChannel || "").trim() ? { updateChannel: String(draft.updateChannel).trim() } : {}),
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

// The inverse of buildConfig: the form's draft fields a stored config implies.
// Editing a rule must start from what is saved, not from the new-rule
// defaults — a save from defaults would silently overwrite every field the
// operator did not touch.
export function draftFromConfig(config) {
  const value = config && typeof config === "object" && !Array.isArray(config) ? config : {};
  const models = value.models || {};
  const providers = Array.isArray(models.providers) ? models.providers.filter(Boolean) : [];
  const active = providers.includes(models.activeProvider) ? models.activeProvider : providers[0] || "";
  const env = value.runtime?.env || {};
  const media = value.media || {};
  const pickMedia = (entry) => ({
    providers: Array.isArray(entry?.providers) ? entry.providers.filter((id) => MEDIA_PROVIDER_IDS.has(id)) : [],
    def: String(entry?.default || ""),
  });
  const image = pickMedia(media.image);
  const video = pickMedia(media.video);
  const speech = pickMedia(media.speech);
  const agents = value.agents || {};
  return {
    selectedTemplateId: active,
    menuProviders: providers,
    pluginRegistryUrl: String(value.tools?.pluginRegistryUrl || "/api/skills/registry"),
    enabledPluginIds: Array.isArray(value.tools?.enabledPluginIds) ? value.tools.enabledPluginIds.join(", ") : "",
    permissionMode: String(value.policy?.permissionMode || "default"),
    minAppVersion: String(value.policy?.minAppVersion || ""),
    ...Object.fromEntries(UPDATE_POLICY_FIELDS.map(([key, draftKey]) => [draftKey, value.policy?.update?.[key] === undefined ? "" : String(value.policy.update[key])])),
    updateChannel: String(value.policy?.updateChannel || ""),
    requestTimeoutMs: String(env.API_TIMEOUT_MS || "300000"),
    visionModel: String(env.VISION_MODEL || "qwen3.7-plus"),
    imageProviders: image.providers,
    imageDefault: image.def,
    videoProviders: video.providers,
    videoDefault: video.def,
    speechProviders: speech.providers,
    speechDefault: speech.def,
    agentIds: Array.isArray(agents.available) ? agents.available.filter(Boolean) : [],
    agentDefault: String(agents.default || ""),
  };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

// Whether the form can hold this stored config without losing anything:
// rebuilding it from its own draft gives the same config back. Vision
// capabilities are left out on purpose — they are recomputed from the live
// provider catalog on every save, so a stale flag is corrected, not lost.
export function formCanEditConfig(config) {
  const value = config && typeof config === "object" && !Array.isArray(config) ? config : null;
  if (!value) return false;
  const draft = draftFromConfig(value);
  const rebuilt = buildConfig(draft, { id: draft.selectedTemplateId, provider: draft.selectedTemplateId });
  const strip = (entry) => {
    const copy = JSON.parse(JSON.stringify(entry));
    if (copy.models) delete copy.models.capabilities;
    return canonical(copy);
  };
  return JSON.stringify(strip(rebuilt)) === JSON.stringify(strip(value));
}
