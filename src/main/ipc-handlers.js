"use strict";

const fs = require("node:fs");
const { ipcMain } = require("electron");
const { resolveAgentCommand } = require("./agent-command");
const { listPresetsPublic } = require("./model-presets");
const { resolveRuntimeIconDataUrl } = require("./app-icon");
const { listLocalesPublic, setLocale } = require("./locale-settings");
const { getRunningSessionIds } = require("./ipc-utils");
const { registerFileHandlers } = require("./ipc-files");
const { registerModelHandlers, registerPermissionHandlers, registerSearchHandlers } = require("./ipc-models");
const { registerProjectHandlers } = require("./ipc-projects");
const { registerSessionHandlers, registerSkillHandlers } = require("./ipc-sessions");
const { registerAssistantHandlers } = require("./ipc-assistant");

function registerAll(ctx) {
  const {
    mainWindow, projectManager, sessionManager,
    stagingManager, runnerPool,
  } = ctx;

  // --- App ---------------------------------------------------------------

  ipcMain.handle("app:get-icon-url", () => resolveRuntimeIconDataUrl());
  ipcMain.handle("app:get-locale", () => ({ ok: true, ...listLocalesPublic() }));
  ipcMain.handle("app:set-locale", (_event, locale) => {
    const result = setLocale(locale);
    return { ok: true, locale: result.locale, supported: listLocalesPublic().supported };
  });

  // --- State ---------------------------------------------------------------

  ipcMain.handle("state:full", () => {
    const projectState = projectManager.getAppState();
    const active = sessionManager.getActive();
    const projectsWithSessions = projectState.projects.map((p) => ({
      ...p,
      sessions: sessionManager.listForProject(p.id).map((s) => {
        const full = sessionManager.findById(s.id);
        return { ...s, messages: full?.messages || [] };
      }),
    }));
    const cliPath = resolveAgentCommand();
    const agent = ctx.agentBootstrap || { ok: false };
    const cliReady = Boolean(cliPath && fs.existsSync(cliPath));
    return {
      activeProjectId: projectState.activeProjectId,
      activeSessionId: sessionManager.activeSessionId,
      projects: projectsWithSessions,
      conversation: active?.messages || [],
      runnerSessionIds: runnerPool.getSessionIds(),
      runningSessionIds: getRunningSessionIds(runnerPool, sessionManager),
      agent: {
        ...agent,
        ok: cliReady,
        cliPath: cliPath || agent.cliPath || null,
        ready: cliReady,
      },
      models: listPresetsPublic(),
      permissions: require("./permission-settings").listPermissionsPublic(),
    };
  });

  // --- Sub-module registrations ---

  registerFileHandlers(mainWindow, stagingManager);
  registerModelHandlers(ctx);
  registerPermissionHandlers(ctx);
  registerSearchHandlers(ctx);
  registerProjectHandlers(ctx);
  registerSessionHandlers(ctx);
  registerSkillHandlers(ctx);
  registerAssistantHandlers(ctx);
}

module.exports = { registerAll };
