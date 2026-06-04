"use strict";

const { ipcMain } = require("electron");
const { ensureSessionRunner, isSessionBusy, withRunnerChange, anyRunnerBusy } = require("./ipc-utils");
const skillManager = require("./skill-manager");
const { requireValidLicense } = require("./license-manager");
const {
  listSessionPermissionsPublic,
  resolveSessionPermissionMode,
} = require("./permission-settings");

function registerSessionHandlers(ctx) {
  const { sessionManager, projectManager, runnerPool } = ctx;

  ipcMain.handle("session:list", () => {
    const project = projectManager.getActive();
    if (!project) {
      return { sessions: [], activeSessionId: null };
    }
    return {
      sessions: sessionManager.listForProject(project.id),
      activeSessionId: sessionManager.activeSessionId,
    };
  });

  ipcMain.handle("session:create", (_event, title, projectId) => {
    const pid = projectId || projectManager.getActive()?.id;
    if (!pid) return { ok: false, error: "NO_PROJECT" };
    const session = sessionManager.create(pid, title);
    return { ok: true, session: { id: session.id, title: session.title, projectId: pid } };
  });

  ipcMain.handle("session:switch", (_event, sessionId) => {
    const session = sessionManager.findById(sessionId);
    if (!session) return { ok: false, error: "NOT_FOUND" };

    if (session.projectId !== projectManager.getActive()?.id) {
      projectManager.switchTo(session.projectId);
    }
    sessionManager.switchTo(sessionId);
    ensureSessionRunner(ctx, sessionId);

    return {
      ok: true,
      sessionId,
      projectId: session.projectId,
      conversation: session.messages || [],
      runnerActive: runnerPool.has(sessionId),
    };
  });

  ipcMain.handle("session:rename", (_event, sessionId, title) => {
    const trimmed = String(title || "").trim();
    if (!trimmed) return { ok: false, error: "INVALID" };
    if (!sessionManager.rename(sessionId, trimmed)) return { ok: false, error: "NOT_FOUND" };
    return { ok: true };
  });

  ipcMain.handle("session:delete", (_event, sessionId) => {
    runnerPool.terminateSession(sessionId);
    const result = sessionManager.delete(sessionId);
    if (result !== "OK") return { ok: false, error: result };
    return { ok: true };
  });

  ipcMain.handle("session:archive", (_event, sessionId) => {
    runnerPool.terminateSession(sessionId);
    sessionManager.archive(sessionId);
    return { ok: true };
  });

  ipcMain.handle("session:get-skills", (_event, sessionId) => {
    const sid = sessionId || sessionManager.activeSessionId;
    const session = sid ? sessionManager.findById(sid) : null;
    if (!session) return { ok: false, error: "NOT_FOUND" };
    return {
      ok: true,
      sessionId: sid,
      ...skillManager.listSkillsForSessionPublic(session),
    };
  });

  ipcMain.handle("session:set-skills", (_event, payload) => {
    const licensed = requireValidLicense();
    if (!licensed.ok) return licensed;

    const sessionId = payload?.sessionId || sessionManager.activeSessionId;
    const session = sessionId ? sessionManager.findById(sessionId) : null;
    if (!session) return { ok: false, error: "NOT_FOUND" };
    if (isSessionBusy(runnerPool, sessionId)) {
      return { ok: false, error: "BUSY" };
    }
    const normalized = skillManager.normalizeSessionSkillSelection(payload?.enabledSkillIds);
    if (!sessionManager.setEnabledSkillIds(sessionId, normalized)) {
      return { ok: false, error: "NOT_FOUND" };
    }
    const updated = sessionManager.findById(sessionId);
    skillManager.writeSessionAgentGuide(sessionId, updated);
    const runner = runnerPool.get(sessionId);
    if (runner?.isAlive() && !runner.isBusy()) {
      if (!runner.reloadSkills()) runnerPool.terminateSession(sessionId);
    } else {
      runnerPool.terminateSession(sessionId);
    }
    return {
      ok: true,
      sessionId,
      ...skillManager.listSkillsForSessionPublic(updated),
    };
  });

  ipcMain.handle("session:get-permission", (_event, sessionId) => {
    const sid = sessionId || sessionManager.activeSessionId;
    const session = sid ? sessionManager.findById(sid) : null;
    if (!session) return { ok: false, error: "NOT_FOUND" };
    return {
      ok: true,
      sessionId: sid,
      ...listSessionPermissionsPublic(session),
    };
  });

  ipcMain.handle("session:set-permission", (_event, payload) => {
    const sessionId = payload?.sessionId || sessionManager.activeSessionId;
    const session = sessionId ? sessionManager.findById(sessionId) : null;
    if (!session) return { ok: false, error: "NOT_FOUND" };
    if (isSessionBusy(runnerPool, sessionId)) {
      return { ok: false, error: "BUSY" };
    }
    if (!sessionManager.setPermissionMode(sessionId, payload?.modeId ?? null)) {
      return { ok: false, error: "NOT_FOUND" };
    }
    const updated = sessionManager.findById(sessionId);
    const effectiveMode = resolveSessionPermissionMode(updated);
    const runner = runnerPool.get(sessionId);
    if (runner?.isAlive() && !runner.isBusy() && !runner.setPermissionMode(effectiveMode)) {
      runnerPool.terminateSession(sessionId);
    }
    return {
      ok: true,
      sessionId,
      ...listSessionPermissionsPublic(updated),
    };
  });
}

function registerSkillHandlers(ctx) {
  const { runnerPool } = ctx;

  ipcMain.handle("skills:list", () => ({
    ok: true,
    skills: skillManager.listSkillsPublic(),
  }));

  ipcMain.handle("skills:set-enabled", (_event, payload) => {
    const licensed = requireValidLicense();
    if (!licensed.ok) return licensed;

    const id = payload?.id;
    const enabled = Boolean(payload?.enabled);
    if (!id) return { ok: false, error: "NOT_FOUND" };
    return withRunnerChange(ctx, () => {
      return skillManager.setSkillEnabledWithSessions(id, enabled, ctx.sessionManager);
    }, { refreshState: true, liveEnv: false, reloadSkills: true });
  });

  ipcMain.handle("skills:refresh", () => {
    const licensed = requireValidLicense();
    if (!licensed.ok) return licensed;

    return withRunnerChange(ctx, () => skillManager.refreshSkillsConfig(), { liveEnv: false, reloadSkills: true });
  });

  ipcMain.handle("skills:restore-bundled", (_event, payload) => {
    const licensed = requireValidLicense();
    if (!licensed.ok) return licensed;

    const id = payload?.id;
    if (!id) return { ok: false, error: "NOT_FOUND" };
    return withRunnerChange(ctx, () => skillManager.restoreBundledSkill(id), { liveEnv: false, reloadSkills: true });
  });

  ipcMain.handle("skills:check-updates", async () => {
    if (anyRunnerBusy(runnerPool)) {
      return { ok: false, error: "BUSY" };
    }
    const licensed = requireValidLicense();
    return skillManager.checkRegistryUpdates({ fetch: licensed.ok });
  });

  ipcMain.handle("skills:install", async (_event, payload) => {
    const licensed = requireValidLicense();
    if (!licensed.ok) return licensed;

    const id = payload?.id;
    const version = payload?.version;
    if (!id) return { ok: false, error: "NOT_FOUND" };
    return withRunnerChange(ctx, () => skillManager.installFromRegistry(id, version), { liveEnv: false, reloadSkills: true });
  });

  ipcMain.handle("skills:update", async (_event, payload) => {
    const licensed = requireValidLicense();
    if (!licensed.ok) return licensed;

    const id = payload?.id;
    if (!id) return { ok: false, error: "NOT_FOUND" };
    return withRunnerChange(ctx, () => skillManager.updateFromRegistry(id), { liveEnv: false, reloadSkills: true });
  });

  ipcMain.handle("skills:uninstall", (_event, payload) => {
    const licensed = requireValidLicense();
    if (!licensed.ok) return licensed;

    const id = payload?.id;
    if (!id) return { ok: false, error: "NOT_FOUND" };
    return withRunnerChange(ctx, () => skillManager.uninstallRemoteSkill(id), { liveEnv: false, reloadSkills: true });
  });
}

module.exports = { registerSessionHandlers, registerSkillHandlers };
