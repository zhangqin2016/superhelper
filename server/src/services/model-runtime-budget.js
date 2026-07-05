const ILUVATAR_QWEN36_CONTEXT_BUDGET = 65_536;
const ILUVATAR_QWEN36_OUTPUT_BUDGET = 8_192;

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function positiveInt(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.floor(number);
}

function minCapability(value, capability) {
  const requested = positiveInt(value);
  if (!requested) return null;
  const cap = positiveInt(capability);
  return cap ? Math.min(requested, cap) : requested;
}

export function modelRuntimeMetadata(provider, model) {
  const metadata = plainObject(provider?.metadata);
  const modelId = String(model || provider?.model || "").trim();
  const models = plainObject(metadata.models);
  const modelSpecific = plainObject(models[modelId]);
  return { metadata, modelSpecific, modelId };
}

function explicitRuntimeBudget(metadata, modelSpecific, key) {
  const pascal = key === "context" ? "opencodeContextWindowTokens" : "opencodeMaxOutputTokens";
  const snake = key === "context" ? "opencode_context_window_tokens" : "opencode_max_output_tokens";
  return positiveInt(modelSpecific[pascal] ?? modelSpecific[snake] ?? metadata[pascal] ?? metadata[snake]);
}

function isIluvatarQwen36Runtime(provider, modelId, metadata, modelSpecific) {
  const id = String(provider?.id || "").toLowerCase();
  const profile = String(modelSpecific.deploymentProfile || metadata.deploymentProfile || "").toLowerCase();
  const model = String(modelId || "").toLowerCase();
  const isIluvatar = id === "iluvatar-vllm" || profile.includes("qwen3.6-27b");
  const isQwen36_27B = /qwen3\.?6[^a-z0-9]*27b/.test(model) || profile.includes("qwen3.6-27b");
  return isIluvatar && isQwen36_27B;
}

export function resolveModelRuntimeBudget(provider, model, discovered = {}) {
  const { metadata, modelSpecific, modelId } = modelRuntimeMetadata(provider, model);
  const contextCapability = positiveInt(
    modelSpecific.contextWindowTokens ??
      modelSpecific.context_window_tokens ??
      modelSpecific.maxContextTokens ??
      modelSpecific.max_context_tokens ??
      modelSpecific.maxModelLen ??
      modelSpecific.max_model_len ??
      discovered.contextWindowTokens ??
      discovered.context_window_tokens ??
      discovered.maxModelLen ??
      discovered.max_model_len ??
      metadata.contextWindowTokens ??
      metadata.context_window_tokens ??
      metadata.maxContextTokens ??
      metadata.max_context_tokens ??
      metadata.maxModelLen ??
      metadata.max_model_len,
  );
  const outputCapability = positiveInt(
    modelSpecific.maxOutputTokens ??
      modelSpecific.max_output_tokens ??
      modelSpecific.maxTokens ??
      modelSpecific.max_tokens ??
      metadata.maxOutputTokens ??
      metadata.max_output_tokens ??
      metadata.maxTokens ??
      metadata.max_tokens,
  );

  const explicitContext = explicitRuntimeBudget(metadata, modelSpecific, "context");
  const explicitOutput = explicitRuntimeBudget(metadata, modelSpecific, "output");
  const iluvatarQwen36 = isIluvatarQwen36Runtime(provider, modelId, metadata, modelSpecific);

  return {
    contextWindowTokens: minCapability(
      explicitContext || (iluvatarQwen36 ? ILUVATAR_QWEN36_CONTEXT_BUDGET : contextCapability),
      contextCapability,
    ),
    maxOutputTokens: minCapability(
      explicitOutput || (iluvatarQwen36 ? ILUVATAR_QWEN36_OUTPUT_BUDGET : outputCapability),
      outputCapability,
    ),
    contextCapabilityTokens: contextCapability,
    maxOutputCapabilityTokens: outputCapability,
    tunedForDefaultLatency: Boolean(iluvatarQwen36 && !explicitContext && !explicitOutput),
  };
}

