const LILY_SPEECH_VOICES = ["aiden", "dylan", "eric", "ono_anna", "ryan", "serena", "sohee", "uncle_fu", "vivian"];

function unique(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function availableSet(available, modality) {
  if (Array.isArray(available)) return new Set(unique(available));
  return new Set(unique(available?.[modality]));
}

function addContract(out, modality, provider, contract) {
  if (!out.contracts[modality]) out.contracts[modality] = {};
  out.contracts[modality][provider] = contract;
}

function lilyBaseContract({ modality, displayName, endpointEnv, modelDefault, template, params, extract }) {
  return {
    displayName,
    endpointEnv,
    authEnv: "LILY_MEDIA_API_KEY",
    request: {
      method: "POST",
      contentType: "application/json",
      template,
    },
    params: {
      ...params,
      model: { type: "string", default: modelDefault },
    },
    response: {
      mediaType: modality,
      extract,
      assetProxy: "lily",
    },
    errors: {
      unsupportedParam: "fail-before-request",
      providerFailure: "report-no-fallback",
    },
  };
}

function lilyImageContract() {
  return lilyBaseContract({
    modality: "image",
    displayName: "Lily GPU Image (FLUX)",
    endpointEnv: "LILY_MEDIA_IMAGE_ENDPOINT",
    modelDefault: "flux-kontext",
    template: {
      prompt: "{{prompt}}",
      negative_prompt: "{{negative_prompt}}",
      size: "{{size}}",
      steps: "{{steps}}",
      seed: "{{seed}}",
      model: "{{model}}",
    },
    params: {
      prompt: { type: "string", required: true },
      negative_prompt: { type: "string", default: "" },
      size: { type: "string", default: "1024x1024" },
      steps: { type: "number", optional: true },
      seed: { type: "number", optional: true },
    },
    extract: ["$.output.image_url", "$.image_url", "$.url", "$.file", "$.public_url"],
  });
}

function lilyVideoContract() {
  return lilyBaseContract({
    modality: "video",
    displayName: "Lily GPU Video (Wan)",
    endpointEnv: "LILY_MEDIA_VIDEO_ENDPOINT",
    modelDefault: "wan2.2",
    template: {
      prompt: "{{prompt}}",
      ratio: "{{ratio}}",
      resolution: "{{resolution}}",
      duration: "{{duration}}",
      model: "{{model}}",
    },
    params: {
      prompt: { type: "string", required: true },
      ratio: { type: "string", default: "16:9" },
      resolution: { type: "string", default: "720P" },
      duration: { type: "number", default: 5 },
    },
    extract: ["$.file", "$.video_url", "$.output.video_url", "$.url", "$.public_url"],
  });
}

function lilySpeechContract() {
  return lilyBaseContract({
    modality: "speech",
    displayName: "Lily GPU Speech (Qwen3-TTS)",
    endpointEnv: "LILY_MEDIA_SPEECH_ENDPOINT",
    modelDefault: "qwen3-tts",
    template: {
      text: "{{text}}",
      input: "{{text}}",
      voice: "{{voice}}",
      format: "{{format}}",
      sample_rate: "{{sample_rate}}",
      model: "{{model}}",
    },
    params: {
      text: { type: "string", required: true },
      voice: {
        type: "string",
        default: "aiden",
        enum: LILY_SPEECH_VOICES,
        aliases: { default: "aiden", longanyang: "aiden" },
      },
      format: { type: "string", default: "wav", enum: ["wav", "mp3", "pcm"] },
      sample_rate: { type: "number", default: 24000 },
    },
    extract: ["$.file", "$.output.audio.url", "$.output.audio_url", "$.audio_url", "$.url", "$.audio_base64"],
  });
}

export function buildMediaProviderContracts({ selected = {}, available = {} } = {}) {
  const out = {
    schemaVersion: 1,
    selected: {
      image: selected.image || "",
      video: selected.video || "",
      speech: selected.speech || "",
    },
    contracts: {},
  };

  if (availableSet(available, "image").has("lily")) addContract(out, "image", "lily", lilyImageContract());
  if (availableSet(available, "video").has("lily")) addContract(out, "video", "lily", lilyVideoContract());
  if (availableSet(available, "speech").has("lily")) addContract(out, "speech", "lily", lilySpeechContract());

  return out;
}

export function listLilySpeechVoices() {
  return [...LILY_SPEECH_VOICES];
}
