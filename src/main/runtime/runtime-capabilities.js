"use strict";

const CAPABILITY_KEYS = Object.freeze([
  "streamInput",
  "emitsThinking",
  "hotEnvUpdate",
  "permissionControl",
  "permissionAlwaysAsk",
  "resume",
  "nativeCompaction",
  "manualSummarize",
  "backgroundCompaction",
  "rawHistory",
  "plugins",
  "hooks",
]);

function normalizeRuntimeCapabilities(input = {}) {
  const out = {};
  for (const key of CAPABILITY_KEYS) out[key] = Boolean(input[key]);
  return out;
}

const OPENCODE_RUNTIME_CAPABILITIES = Object.freeze(normalizeRuntimeCapabilities({
  streamInput: false,
  emitsThinking: true,
  hotEnvUpdate: false,
  permissionControl: true,
  permissionAlwaysAsk: true,
  resume: true,
  nativeCompaction: true,
  manualSummarize: true,
  backgroundCompaction: true,
  rawHistory: true,
  plugins: true,
  hooks: false,
}));

function capabilitiesForRuntime(runtime = "") {
  if (String(runtime || "").toLowerCase() === "opencode") return OPENCODE_RUNTIME_CAPABILITIES;
  return normalizeRuntimeCapabilities();
}

module.exports = {
  CAPABILITY_KEYS,
  OPENCODE_RUNTIME_CAPABILITIES,
  capabilitiesForRuntime,
  normalizeRuntimeCapabilities,
};
