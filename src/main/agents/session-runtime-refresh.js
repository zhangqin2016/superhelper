"use strict";

/**
 * After a session's skill/agent configuration changes: rewrite the per-session
 * guide, keep the engine session's resume binding in step with the new skill
 * set (so the next turn resumes with context instead of starting fresh), then
 * hot-reload or recycle the idle runner so the change applies on the next
 * prompt. Shared by the agent IPC and the role-switch release path.
 */

function refreshSessionRuntime(ctx, sessionId) {
  try {
    const { sessionManager, projectManager, runnerPool } = ctx;
    const skillManager = require("../skill-manager");
    const session = sessionManager.findById(sessionId);
    if (!session) return { ok: false, reason: "NO_SESSION" };
    const project = projectManager.find(session.projectId);
    skillManager.writeSessionAgentGuide(sessionId, session, project?.path || session.workspacePath || "");
    const continuity = require("../engine-skill-continuity").keepEngineAcrossSkillChange(ctx, sessionId);
    const runner = runnerPool.get(sessionId);
    if (runner?.isAlive() && !runner.isBusy()) {
      if (!runner.reloadSkills()) runnerPool.terminateSession(sessionId);
    } else if (runner) {
      runnerPool.terminateSession(sessionId);
    }
    return { ok: true, continuity };
  } catch (error) {
    return { ok: false, reason: error?.message || "REFRESH_FAILED" };
  }
}

module.exports = { refreshSessionRuntime };
