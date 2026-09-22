/**
 * Every media-generation provider the platform knows, and where its credential
 * comes from — in one place.
 *
 * Until 2026-09-22 this knowledge was split three ways: the admin form hardcoded
 * six chips, delivery hand-wrote the availability list, and the credential for
 * four of them lived under a DIFFERENT id (`volcengine` the选项 vs
 * `volcengine-media` the provider row). Nothing in the console said where to
 * configure them, so an operator ticked 火山方舟 / 可灵 / MiniMax / 智谱, saved,
 * and delivery quietly dropped them because no key existed — the same
 * "saved but never applied" shape as the license rule.
 *
 * The catalog is the single source: delivery builds availability from it, the
 * admin reports status from it, and the form renders chips from it.
 */

export const MEDIA_KINDS = ["image", "video", "speech"];

export const MEDIA_PROVIDER_CATALOG = [
  {
    id: "lily",
    label: "Lily 自有 GPU",
    labelEn: "Lily self-hosted GPU",
    kinds: ["image", "video", "speech"],
    // Configured by endpoint env vars rather than a key row; see configuredLilyMediaKinds.
    credentialProviderId: "",
    envVars: ["LILY_MEDIA_BASE_URL", "LILY_MEDIA_IMAGE_BASE_URL", "LILY_MEDIA_VIDEO_BASE_URL", "LILY_MEDIA_SPEECH_BASE_URL"],
  },
  {
    id: "dashscope",
    label: "阿里百炼 DashScope",
    labelEn: "Alibaba DashScope",
    kinds: ["image", "video", "speech"],
    credentialProviderId: "vision",
    envVars: ["DASHSCOPE_API_KEY"],
  },
  {
    id: "volcengine",
    label: "火山方舟 Volcengine",
    labelEn: "Volcengine Ark",
    kinds: ["image", "video"],
    credentialProviderId: "volcengine-media",
    envVars: ["VOLCENGINE_API_KEY", "ARK_API_KEY"],
  },
  {
    id: "kling",
    label: "可灵 Kling",
    labelEn: "Kling",
    kinds: ["image", "video"],
    credentialProviderId: "kling-media",
    envVars: ["KLING_ACCESS_KEY"],
  },
  {
    id: "minimax",
    label: "MiniMax",
    labelEn: "MiniMax",
    kinds: ["image", "video"],
    credentialProviderId: "minimax-media",
    envVars: ["MINIMAX_API_KEY"],
  },
  {
    id: "zhipu",
    label: "智谱 Zhipu",
    labelEn: "Zhipu",
    kinds: ["image", "video"],
    credentialProviderId: "zhipu-media",
    envVars: ["ZHIPU_API_KEY", "BIGMODEL_API_KEY"],
  },
];

export const MEDIA_PROVIDER_IDS = MEDIA_PROVIDER_CATALOG.map((entry) => entry.id);

/** The credential row ids an operator may need to create, for the admin to offer. */
export const MEDIA_CREDENTIAL_PROVIDER_IDS = MEDIA_PROVIDER_CATALOG
  .map((entry) => entry.credentialProviderId)
  .filter(Boolean);

/**
 * Status of every media provider: is it usable right now, and from where.
 *
 * @param {{providers?: object, serverConfig?: object, lilyKinds?: object}} input
 * @returns {Array<{id, label, labelEn, kinds, configured, source, credentialProviderId, envVars}>}
 */
export function mediaProviderStatus({ providers = {}, serverConfig = {}, lilyKinds = {} } = {}) {
  const envKeyOf = {
    dashscope: serverConfig.dashscopeApiKey,
    volcengine: serverConfig.volcengineApiKey,
    kling: serverConfig.klingAccessKey,
    minimax: serverConfig.minimaxApiKey,
    zhipu: serverConfig.zhipuApiKey,
  };
  return MEDIA_PROVIDER_CATALOG.map((entry) => {
    if (entry.id === "lily") {
      const kinds = MEDIA_KINDS.filter((kind) => Boolean(lilyKinds?.[kind]));
      return { ...entry, kinds: kinds.length ? kinds : entry.kinds, configured: kinds.length > 0, source: kinds.length ? "env" : "" };
    }
    const row = entry.credentialProviderId ? providers?.[entry.credentialProviderId] : null;
    if (row?.apiKey) return { ...entry, configured: true, source: "provider" };
    if (envKeyOf[entry.id]) return { ...entry, configured: true, source: "env" };
    return { ...entry, configured: false, source: "" };
  });
}

/** What delivery may offer, per kind — derived from the same status. */
export function availableMediaProviders(status = []) {
  const available = { image: [], video: [], speech: [] };
  for (const entry of status) {
    if (!entry.configured) continue;
    for (const kind of MEDIA_KINDS) {
      if (entry.kinds.includes(kind)) available[kind].push(entry.id);
    }
  }
  return available;
}
