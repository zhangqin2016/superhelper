const LILY_MEDIA_ROWS = [
  {
    id: "lily-media-image",
    label: "Lily GPU Image (Qwen-Image)",
    modality: "image",
    route: "/llm/media/lily/image/generate",
    model: "qwen-image",
  },
  {
    id: "lily-media-video",
    label: "Lily GPU Video (WAN)",
    modality: "video",
    route: "/llm/media/lily/video/generate",
    model: "wan",
  },
  {
    id: "lily-media-speech",
    label: "Lily GPU Speech (TTS)",
    modality: "speech",
    route: "/llm/media/lily/speech/generate",
    model: "tts",
  },
];

function hasLilyKind(serverConfig, modality) {
  if (!serverConfig || typeof serverConfig !== "object") return false;
  if (serverConfig.lilyMediaBaseUrl) return true;
  if (modality === "image") {
    return Boolean(serverConfig.lilyMediaImageEndpoint || serverConfig.lilyMediaImageBaseUrl);
  }
  if (modality === "video") {
    return Boolean(serverConfig.lilyMediaVideoEndpoint || serverConfig.lilyMediaVideoBaseUrl);
  }
  if (modality === "speech") {
    return Boolean(serverConfig.lilyMediaSpeechEndpoint || serverConfig.lilyMediaSpeechBaseUrl);
  }
  return false;
}

export function listBuiltinMediaProviderRows(serverConfig) {
  return LILY_MEDIA_ROWS.filter((row) => hasLilyKind(serverConfig, row.modality)).map((row) => ({
    id: row.id,
    label: row.label,
    type: "media",
    base_url: row.route,
    default_model: row.model,
    models: [row.model],
    headers: {},
    metadata: {
      source: "builtin",
      provider: "lily",
      modality: row.modality,
    },
    enabled: true,
    updated_at: null,
    hasApiKey: Boolean(serverConfig?.lilyMediaApiKey),
    hasSecretKey: false,
    readOnly: true,
    source: "builtin",
  }));
}
