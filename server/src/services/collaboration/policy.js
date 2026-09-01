const DEFAULT = Object.freeze({
  enabled: false,
  schemaVersion: 1,
  realtime: true,
  attachments: false,
  workspaceShares: false,
  aiTools: false,
});

export const DEFAULT_COLLABORATION_POLICY = DEFAULT;

/** A signed profile can target only a verified account or active organization. */
export function profileMatchesCollaborationContext(profile, context = {}) {
  if (profile?.scope === "user") return Boolean(context.userId) && profile.target_id === context.userId;
  if (profile?.scope === "organization") {
    return Array.isArray(context.organizationIds) && context.organizationIds.includes(profile.target_id);
  }
  return false;
}

/**
 * Convert an operator/config-profile collaboration block to the bounded client
 * contract. Absent, malformed, unsupported, or explicitly killed policies
 * always disable collaboration; callers never need to merge untrusted fields.
 */
export function resolveCollaborationPolicy(input = {}, options = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input) || options.killSwitch === true) {
    return DEFAULT;
  }
  if (input.schemaVersion != null && input.schemaVersion !== DEFAULT.schemaVersion) return DEFAULT;
  return {
    enabled: input.enabled === true,
    schemaVersion: DEFAULT.schemaVersion,
    realtime: input.realtime !== false,
    attachments: input.attachments === true,
    workspaceShares: input.workspaceShares === true,
    aiTools: input.aiTools === true,
  };
}

/** Resolve the environment-owned policy without leaking server-only secrets. */
export function resolveServerCollaborationPolicy(serverConfig = {}, options = {}) {
  return resolveCollaborationPolicy({
    enabled: serverConfig.collaborationEnabled === true,
    realtime: serverConfig.collaborationRealtimeEnabled !== false,
    attachments: serverConfig.collaborationAttachmentsEnabled === true,
    workspaceShares: serverConfig.collaborationWorkspaceSharesEnabled === true,
    aiTools: serverConfig.collaborationAiToolsEnabled === true,
  }, options);
}

/**
 * Final server boundary after every signed profile is merged. A profile can
 * never override the master rollout, the emergency kill switch, or the
 * verified organization allow-list. Other client configuration is preserved.
 */
export function applyCollaborationPolicyGate(effectiveConfig = {}, options = {}) {
  const profilePolicy = options.collaborationEnabled === true
    ? effectiveConfig?.collaboration
    : null;
  const bounded = resolveCollaborationPolicy(profilePolicy, {
    killSwitch: options.killSwitch === true || options.organizationEligible === false,
  });
  return {
    ...(effectiveConfig && typeof effectiveConfig === "object" ? effectiveConfig : {}),
    collaboration: {
      ...bounded,
      realtime: bounded.realtime && options.realtime !== false,
      attachments: bounded.attachments && options.attachments === true,
      workspaceShares: bounded.workspaceShares && options.workspaceShares === true,
      aiTools: bounded.aiTools && options.aiTools === true,
    },
  };
}
