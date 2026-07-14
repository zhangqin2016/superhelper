const CHAT_ONLY_FALLBACK = "chat_only";

const DEMO_CAPABILITIES = Object.freeze({
  pairing: { enabled: true },
  relayTextImageCommand: { enabled: true },
  projection: { enabled: true },
  interrupt: { enabled: true },
  history: { enabled: true },
  uploads: { enabled: true, mode: "server_local_v1" },
  artifacts: { enabled: true, mode: "server_local_v1" },
  remoteSessions: { enabled: true, mode: "bounded_channel_v1" },
});

const DISABLED_CAPABILITIES = Object.freeze({
  observeControl: {
    enabled: false,
    code: "MC-ERR-CONFIG-FEATURE-DISABLED",
    reason: "Screen observation/control requires accepted WebRTC/TURN and OS helper evidence.",
  },
  turnCredentials: {
    enabled: false,
    code: "MC-ERR-WEBRTC-TURN-UNAVAILABLE",
    reason: "TURN provider, region, capacity, secret-rotation, and cost evidence are not accepted.",
  },
  native: {
    enabled: false,
    code: "MC-ERR-NATIVE-METHOD-UNSUPPORTED",
    reason: "Native iOS/Android shell, push, secure key, share, and background upload evidence is not accepted.",
  },
  voice: {
    enabled: false,
    code: "MC-ERR-CONFIG-FEATURE-DISABLED",
    reason: "ASR provider, privacy, cost, quality, and device evidence is not accepted.",
  },
  artifactContent: {
    enabled: false,
    code: "MC-ERR-CONFIG-FEATURE-DISABLED",
    reason: "Direct artifact byte serving requires accepted authorization, storage, and privacy evidence.",
  },
  push: {
    enabled: false,
    code: "MC-ERR-CONFIG-FEATURE-DISABLED",
    reason: "Push provider, payload, region, token lifecycle, and revocation evidence is not accepted.",
  },
  diagnostics: {
    enabled: false,
    code: "MC-ERR-CONFIG-FEATURE-DISABLED",
    reason: "Diagnostics package, redaction, consent, support storage, and deletion evidence is not accepted.",
  },
});

function disabledByConfig(name, reason = "Mobile Command capability is disabled by configuration.") {
  return {
    enabled: false,
    code: "MC-ERR-CONFIG-FEATURE-DISABLED",
    reason,
  };
}

function disabledCapability(name, override = null) {
  const capability = override || DISABLED_CAPABILITIES[name] || {
    enabled: false,
    code: "MC-ERR-CONFIG-FEATURE-DISABLED",
    reason: "Capability is not enabled.",
  };
  return {
    ok: false,
    code: capability.code,
    capability: name,
    enabled: false,
    fallback: CHAT_ONLY_FALLBACK,
    reason: capability.reason,
  };
}

function applyCapabilityFlags(capabilities, flags = {}) {
  const next = { ...capabilities };
  if (flags.mobileCommandEnabled === false) {
    for (const name of Object.keys(DEMO_CAPABILITIES)) {
      next[name] = disabledByConfig(name, "Mobile Command is disabled by configuration.");
    }
    return next;
  }
  if (flags.remoteSessionsEnabled === false) {
    next.remoteSessions = disabledByConfig("remoteSessions", "Mobile remote sessions are disabled by configuration.");
  }
  if (flags.uploadsEnabled === false) {
    next.uploads = disabledByConfig("uploads", "Mobile uploads are disabled by configuration.");
  }
  if (flags.artifactsEnabled === false) {
    next.artifacts = disabledByConfig("artifacts", "Mobile artifact access is disabled by configuration.");
  }
  return next;
}

function mobileCapabilitiesPayload({ flags = {} } = {}) {
  const capabilities = applyCapabilityFlags({
    ...DEMO_CAPABILITIES,
    observeControl: DISABLED_CAPABILITIES.observeControl,
    turnCredentials: DISABLED_CAPABILITIES.turnCredentials,
    native: DISABLED_CAPABILITIES.native,
    voice: DISABLED_CAPABILITIES.voice,
    artifactContent: DISABLED_CAPABILITIES.artifactContent,
    push: DISABLED_CAPABILITIES.push,
    diagnostics: DISABLED_CAPABILITIES.diagnostics,
  }, flags);
  return {
    ok: true,
    phase: "phase1-web-demo",
    fallback: CHAT_ONLY_FALLBACK,
    capabilities,
  };
}

function sendDisabledCapability(reply, name) {
  return reply.code(501).send(disabledCapability(name));
}

export {
  CHAT_ONLY_FALLBACK,
  DEMO_CAPABILITIES,
  DISABLED_CAPABILITIES,
  applyCapabilityFlags,
  disabledByConfig,
  disabledCapability,
  mobileCapabilitiesPayload,
  sendDisabledCapability,
};
