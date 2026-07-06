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
  const nextParams = { ...params };
  if (modelDefault) nextParams.model = { type: "string", default: modelDefault };
  return {
    displayName,
    endpointEnv,
    authEnv: "LILY_MEDIA_API_KEY",
    request: {
      method: "POST",
      contentType: "application/json",
      template,
    },
    params: nextParams,
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
      negative_prompt: "{{negative_prompt}}",
      image_base64: "{{image_base64}}",
      size: "{{size}}",
      width: "{{width}}",
      height: "{{height}}",
      frames: "{{frames}}",
      duration: "{{duration}}",
      resolution: "{{resolution}}",
      ratio: "{{ratio}}",
      steps: "{{steps}}",
      seed: "{{seed}}",
    },
    params: {
      prompt: { type: "string", required: true },
      negative_prompt: { type: "string", optional: true },
      image_base64: { type: "string", optional: true },
      size: { type: "string", optional: true },
      width: { type: "number", optional: true },
      height: { type: "number", optional: true },
      frames: { type: "number", optional: true },
      duration: { type: "number", optional: true },
      resolution: { type: "string", optional: true },
      ratio: { type: "string", optional: true },
      steps: { type: "number", optional: true },
      seed: { type: "number", optional: true },
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

function schemaType(spec = {}) {
  if (typeof spec.type === "string" && spec.type !== "null") return spec.type === "integer" ? "number" : spec.type;
  for (const key of ["anyOf", "oneOf"]) {
    const list = Array.isArray(spec[key]) ? spec[key] : [];
    const found = list.find((item) => item && item.type && item.type !== "null");
    if (found) return schemaType(found);
  }
  return "string";
}

function schemaDefault(spec = {}) {
  if (Object.prototype.hasOwnProperty.call(spec, "default")) return spec.default;
  return undefined;
}

export function openApiGenerateSchemaToContract({ modality, displayName, endpointEnv, authEnv = "LILY_MEDIA_API_KEY", mediaType, extract, schema }) {
  const properties = schema && typeof schema.properties === "object" ? schema.properties : {};
  const required = new Set(Array.isArray(schema?.required) ? schema.required.map(String) : []);
  const params = {};
  const template = {};
  for (const [name, spec] of Object.entries(properties)) {
    const param = {
      type: schemaType(spec),
    };
    if (required.has(name)) param.required = true;
    else param.optional = true;
    const value = schemaDefault(spec);
    if (value !== undefined && value !== null && value !== "") param.default = value;
    if (Array.isArray(spec?.enum)) param.enum = spec.enum;
    if (spec?.title) param.label = spec.title;
    params[name] = param;
    template[name] = `{{${name}}}`;
  }
  return {
    displayName,
    endpointEnv,
    authEnv,
    request: {
      method: "POST",
      contentType: "application/json",
      template,
    },
    params,
    response: {
      mediaType: mediaType || modality,
      extract,
      assetProxy: "lily",
    },
    errors: {
      unsupportedParam: "fail-before-request",
      providerFailure: "report-no-fallback",
    },
    source: "openapi",
  };
}

function resolveOpenApiSchema(openapi) {
  const schemas = openapi?.components?.schemas || {};
  const ref = openapi?.paths?.["/generate"]?.post?.requestBody?.content?.["application/json"]?.schema?.$ref || "";
  const name = ref.startsWith("#/components/schemas/") ? ref.slice("#/components/schemas/".length) : "GenerateRequest";
  return schemas[name] || schemas.GenerateRequest || null;
}

async function fetchOpenApiForEndpoint(endpoint, fetchImpl, timeoutMs) {
  if (!endpoint) return null;
  let url;
  try {
    const parsed = new URL(endpoint);
    url = `${parsed.origin}/openapi.json`;
  } catch {
    return null;
  }
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) return null;
  return response.json();
}

export async function discoverLilyMediaProviderContracts({ serverConfig = {}, selected = {}, available = {}, fetchImpl = fetch, timeoutMs = 1500 } = {}) {
  const discovered = {};
  const specs = [
    {
      modality: "image",
      endpoint: serverConfig.lilyMediaImageEndpoint,
      displayName: "Lily GPU Image",
      endpointEnv: "LILY_MEDIA_IMAGE_ENDPOINT",
      extract: ["$.output.image_url", "$.image_url", "$.url", "$.file", "$.public_url"],
    },
    {
      modality: "video",
      endpoint: serverConfig.lilyMediaVideoEndpoint,
      displayName: "Lily GPU Video",
      endpointEnv: "LILY_MEDIA_VIDEO_ENDPOINT",
      extract: ["$.file", "$.video_url", "$.output.video_url", "$.url", "$.public_url"],
    },
    {
      modality: "speech",
      endpoint: serverConfig.lilyMediaSpeechEndpoint,
      displayName: "Lily GPU Speech",
      endpointEnv: "LILY_MEDIA_SPEECH_ENDPOINT",
      extract: ["$.file", "$.output.audio.url", "$.output.audio_url", "$.audio_url", "$.url", "$.audio_base64"],
    },
  ];
  await Promise.all(specs.map(async (spec) => {
    if (!availableSet(available, spec.modality).has("lily")) return;
    try {
      const openapi = await fetchOpenApiForEndpoint(spec.endpoint, fetchImpl, timeoutMs);
      const schema = resolveOpenApiSchema(openapi);
      if (!schema) return;
      discovered[spec.modality] = openApiGenerateSchemaToContract({
        modality: spec.modality,
        displayName: spec.displayName,
        endpointEnv: spec.endpointEnv,
        mediaType: spec.modality,
        extract: spec.extract,
        schema,
      });
    } catch {
      // Dynamic contracts are an enhancement. Fall back to the built-in contract
      // so old/unreachable services do not make the client lose media capability.
    }
  }));
  return buildMediaProviderContracts({ selected, available, discovered: { lily: discovered } });
}

export function buildMediaProviderContracts({ selected = {}, available = {}, discovered = {} } = {}) {
  const out = {
    schemaVersion: 1,
    selected: {
      image: selected.image || "",
      video: selected.video || "",
      speech: selected.speech || "",
    },
    contracts: {},
  };

  const lily = discovered.lily || {};
  if (availableSet(available, "image").has("lily")) addContract(out, "image", "lily", lily.image || lilyImageContract());
  if (availableSet(available, "video").has("lily")) addContract(out, "video", "lily", lily.video || lilyVideoContract());
  if (availableSet(available, "speech").has("lily")) addContract(out, "speech", "lily", lily.speech || lilySpeechContract());

  return out;
}

export function listLilySpeechVoices() {
  return [...LILY_SPEECH_VOICES];
}
