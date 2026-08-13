const MEDIA_ENV_KEYS = {
  image: ["LILY_MEDIA_IMAGE_ENDPOINT", "LILY_MEDIA_IMAGE_BASE_URL", "LILY_GPU_IMAGE_ENDPOINT", "LILY_GPU_IMAGE_BASE_URL"],
  video: ["LILY_MEDIA_VIDEO_ENDPOINT", "LILY_MEDIA_VIDEO_BASE_URL", "LILY_GPU_VIDEO_ENDPOINT", "LILY_GPU_VIDEO_BASE_URL"],
  speech: [
    "LILY_MEDIA_SPEECH_ENDPOINT", "LILY_MEDIA_SPEECH_BASE_URL", "LILY_MEDIA_TTS_ENDPOINT", "LILY_MEDIA_TTS_BASE_URL",
    "LILY_GPU_SPEECH_ENDPOINT", "LILY_GPU_SPEECH_BASE_URL", "LILY_GPU_TTS_ENDPOINT", "LILY_GPU_TTS_BASE_URL",
  ],
};

const PROVIDER_ENV_KEYS = { image: "LILY_IMAGE_PROVIDER", video: "LILY_VIDEO_PROVIDER", speech: "LILY_SPEECH_PROVIDER" };
const SHARED_ENV_KEYS = ["LILY_MEDIA_BASE_URL", "LILY_GPU_BASE_URL"];

// Server state is authoritative: old scoped profiles must not re-enable disabled media.
export function stripDisabledLilyMediaEnv(configCopy, enabledKinds = {}) {
  const env = configCopy?.runtime?.env;
  if (!env || typeof env !== "object") return configCopy;
  let anyEnabled = false;
  for (const [kind, keys] of Object.entries(MEDIA_ENV_KEYS)) {
    if (enabledKinds[kind]) {
      anyEnabled = true;
      continue;
    }
    for (const key of keys) delete env[key];
    const providerKey = PROVIDER_ENV_KEYS[kind];
    if (env[providerKey] === "lily") delete env[providerKey];
  }
  if (!enabledKinds.shared) for (const key of SHARED_ENV_KEYS) delete env[key];
  if (!anyEnabled) delete env.LILY_MEDIA_API_KEY;
  return configCopy;
}
