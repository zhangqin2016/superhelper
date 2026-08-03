"use strict";

const crypto = require("node:crypto");
const { DEFAULT_TTL_MS, issueRuntimeIdentity, verifyRuntimeIdentity } = require("./runtime-identity");
const { createRuntimeIdentityRegistry } = require("./runtime-identity-registry");
const { getLogger } = require("./logger");

const log = getLogger("opencode-runtime-identity");

function buildOpencodeRuntimeIdentityConfig(sessionId, cwd, extra = {}) {
  if (process.env.LILY_RUNTIME_IDENTITY_V1 === "0") return null;
  try {
    const { runtimeIdentityProcessSecret } = require("./runtime-identity");
    const claims = extra.runtimeIdentityClaims || {};
    return {
      secret: runtimeIdentityProcessSecret(),
      registryPath: require("./config").userDataPath("runtime-identity-registry.json"),
      audience: "tool-broker",
      principalId: String(claims.principalId || `session:${sessionId}`),
      workspaceId: String(claims.workspaceId || claims.projectId || "workspace:local"),
      projectId: String(claims.projectId || "project:local"),
      sessionId: String(sessionId),
      workspacePath: String(cwd || ""),
      permissionMode: String(extra.permissionMode || "ask"),
      activeSkillIds: Array.isArray(extra.activeSkillIds) ? extra.activeSkillIds : [],
      capabilities: Array.isArray(claims.capabilities) ? claims.capabilities : [],
    };
  } catch (err) {
    log.warn("runtime identity configuration unavailable: %s", err?.message || err);
    return null;
  }
}

function grantOpencodeRuntimeIdentity(runner, server, payload = {}) {
  const config = runner?.spawnOptions?.runtimeIdentity;
  if (!config || process.env.LILY_RUNTIME_IDENTITY_V1 === "0") return "";
  const engineSessionId = String(server?.sessionID || "").trim();
  if (!engineSessionId) throw new Error("RUNTIME_IDENTITY_ENGINE_SESSION_REQUIRED");
  const now = Date.now();
  const token = issueRuntimeIdentity({
    ...config,
    sessionId: runner.sessionId,
    turnId: payload.turnId || `turn:${crypto.randomUUID()}`,
    taskRunId: payload.taskRunId || "task:none",
    agentId: payload.agentId || "lead",
    attemptId: payload.attemptId || `attempt:${crypto.randomUUID()}`,
  }, {
    secret: config.secret,
    audience: config.audience || "tool-broker",
    now,
    ttlMs: DEFAULT_TTL_MS,
    nonce: crypto.randomUUID(),
  });
  const identity = verifyRuntimeIdentity(token, {
    secret: config.secret,
    audience: config.audience || "tool-broker",
    now,
  });
  createRuntimeIdentityRegistry({ filePath: config.registryPath }).grant({
    engineSessionId,
    token,
    sessionId: identity.sessionId,
    nonce: identity.nonce,
    expiresAt: identity.expiresAt,
  });
  return token;
}

function revokeOpencodeRuntimeIdentity(runner, engineSessionId, reason = "runner_recycled") {
  const config = runner?.spawnOptions?.runtimeIdentity;
  const id = String(engineSessionId || "").trim();
  if (!config?.registryPath || !id) return false;
  try {
    return createRuntimeIdentityRegistry({ filePath: config.registryPath }).revoke(id, reason);
  } catch (err) {
    log.warn("runtime identity revocation failed: %s", err?.message || err);
    return false;
  }
}

module.exports = {
  buildOpencodeRuntimeIdentityConfig,
  grantOpencodeRuntimeIdentity,
  revokeOpencodeRuntimeIdentity,
};
