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
    processJobScopeToken: processJobScopeTokenForTurn(runner, identity.turnId, now),
  });
  return token;
}

/**
 * The process-job scope of THIS turn, issued where the turn's identity is —
 * on dispatch, with the real turn id — so the engine can attach it to every
 * lily_process_jobs call (runtime-identity plugin) and the model never copies
 * it. Empty when the session has no owner scope or injection is off, and the
 * prompt-carried token (ipc-utils) remains the route. Never fails the grant.
 */
function processJobScopeTokenForTurn(runner, turnId, now) {
  const scope = runner?.spawnOptions?.processJobScope;
  const turnScope = require("./long-task/turn-scope");
  if (!scope || !turnScope.processJobScopeInjected()) return "";
  try {
    return turnScope.issueProcessJobScopeToken({
      secret: require("./long-task/secret").ensureLongTaskSecret(),
      scope: { ...scope, turnId: String(turnId || "") },
      now: () => now,
    });
  } catch (err) {
    log.warn("process-job scope not attached to this turn's identity: %s", err?.message || err);
    return "";
  }
}

/**
 * Grant the engine session its identity for a PRE-TURN compaction.
 *
 * The ordinary grant happens when the turn is dispatched, but a pre-turn
 * compaction runs BEFORE that: the orchestrator compacts, and only then sends
 * the prompt. Hook-bridge plugins resolve this registry on every engine event,
 * so during that window they found no token and failed closed — the 2026-09-15
 * field case, where every first compaction of a resumed session died with
 * PUBLIC_HOOK_BRIDGE_IDENTITY_UNAVAILABLE and the context never shrank.
 * Compaction is Lily-initiated work on this session, so it gets the same
 * short-lived scoped identity; the turn re-grants moments later.
 */
function grantOpencodeRuntimeIdentityForCompaction(runner, server) {
  try {
    return grantOpencodeRuntimeIdentity(runner, server, { agentId: "compaction" });
  } catch (err) {
    // Never let identity issuance itself break compaction: without a token the
    // bridge decides, exactly as before this grant existed.
    log.warn("compaction runtime identity grant failed: %s", err?.message || err);
    return "";
  }
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
  grantOpencodeRuntimeIdentityForCompaction,
  revokeOpencodeRuntimeIdentity,
};
