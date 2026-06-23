"use strict";

/**
 * Resolve the Lily session context that gates broker-visible tools.
 *
 * The broker is intentionally fail-closed: no session means no tools. This
 * prevents a shared MCP process from accidentally exposing app-wide connector
 * tools when it cannot prove which conversation is asking.
 */

function findSession(sessionManager, sessionId) {
  if (!sessionManager || !sessionId) return null;
  if (typeof sessionManager.findById === "function") return sessionManager.findById(sessionId);
  if (typeof sessionManager.get === "function") return sessionManager.get(sessionId);
  if (typeof sessionManager._find === "function") return sessionManager._find(sessionId);
  return null;
}

function resolveProject(projectManager, projectId) {
  if (!projectManager || !projectId) return null;
  if (typeof projectManager.find === "function") return projectManager.find(projectId);
  return null;
}

function resolveSkillIds(skillManager, session) {
  if (skillManager && typeof skillManager.resolveSessionSkillIds === "function") {
    return skillManager.resolveSessionSkillIds(session);
  }
  return Array.isArray(session?.enabledSkillIds) ? session.enabledSkillIds : [];
}

function resolvePermissionMode(permissionSettings, session) {
  if (permissionSettings && typeof permissionSettings.resolveSessionPermissionMode === "function") {
    return permissionSettings.resolveSessionPermissionMode(session);
  }
  try {
    return require("../permission-settings").resolveSessionPermissionMode(session);
  } catch {
    return "ask";
  }
}

function resolveToolBrokerContext({
  sessionId,
  sessionManager,
  projectManager,
  skillManager,
  permissionSettings,
  connectorStatus = {},
  runtime = {},
} = {}) {
  const id = String(sessionId || "").trim();
  if (!id) return { ok: false, error: "SESSION_ID_REQUIRED" };
  const session = findSession(sessionManager, id);
  if (!session) return { ok: false, error: "SESSION_NOT_FOUND", sessionId: id };
  const project = resolveProject(projectManager, session.projectId);
  const activeSkillIds = [...new Set(resolveSkillIds(skillManager, session).map((value) => String(value || "").trim()).filter(Boolean))];

  return {
    ok: true,
    sessionId: id,
    projectId: session.projectId || null,
    workspacePath: project?.path || session.workspacePath || "",
    permissionMode: resolvePermissionMode(permissionSettings, session),
    activeSkillIds,
    connectorStatus,
    runtime,
  };
}

module.exports = {
  resolveToolBrokerContext,
};
