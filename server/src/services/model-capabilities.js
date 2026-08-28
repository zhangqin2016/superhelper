export function resolveModelCapabilities(provider, { modelSpecific = {}, discovered = {} } = {}, providerCapabilities = {}) {
  const specific = modelSpecific.capabilities || {};
  const detected = discovered?.capabilities || {};
  const vision = [specific.vision, modelSpecific.nativeVision, detected.vision]
    .find(value => typeof value === "boolean");
  const toolCall = [specific.toolCall, detected.toolCall].find(value => typeof value === "boolean");
  const filePartMimes = specific.filePartMimes ?? detected.filePartMimes;
  // Legacy provider flags remain a fallback, never override an explicit
  // per-model false. Older profiles may contain stale provider-level false.
  const providerVision = Boolean(providerCapabilities?.[provider?.id]?.vision
    || provider?.metadata?.nativeVision || provider?.capabilities?.vision);
  return {
    vision: vision ?? providerVision,
    ...(toolCall !== undefined ? { toolCall } : {}),
    ...(Array.isArray(filePartMimes) ? { filePartMimes: [...new Set(filePartMimes.filter(mime => typeof mime === "string"))].slice(0, 16) } : {}),
  };
}
