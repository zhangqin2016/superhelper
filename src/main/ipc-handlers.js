"use strict";

const fs = require("node:fs");
const { ipcMain } = require("electron");
const { resolveAgentCommand } = require("./agent-command");
const { listPresetsPublic } = require("./model-presets");
const { resolveRuntimeIconDataUrl } = require("./app-icon");
const { listLocalesPublic, setLocale } = require("./locale-settings");
const { registerFileHandlers } = require("./ipc-files");
const { registerModelHandlers, registerPermissionHandlers, registerSearchHandlers } = require("./ipc-models");
const { registerProjectHandlers } = require("./ipc-projects");
const { registerSessionHandlers, registerSkillHandlers } = require("./ipc-sessions");
const { registerAssistantHandlers } = require("./ipc-assistant");
const { registerFileTreeHandlers } = require("./ipc-filetree");

function registerAll(ctx) {
  const {
    mainWindow, projectManager, sessionManager,
    stagingManager, runnerPool,
  } = ctx;

  // --- App ---------------------------------------------------------------

  ipcMain.handle("app:get-icon-url", () => resolveRuntimeIconDataUrl());
  ipcMain.handle("app:get-version", () => ({ ok: true, version: require("electron").app.getVersion() }));
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

  ipcMain.handle("license:status", () =>
    require("./license-manager").getLicenseStatus());
  ipcMain.handle("license:activate", async (_event, payload) =>
    require("./license-manager").activateLicense(payload?.token || payload));
  ipcMain.handle("license:clear", () =>
    require("./license-manager").clearLicense());
  ipcMain.handle("license:refresh", () =>
    require("./license-manager").refreshServerLicense());

  ipcMain.handle("service:get-settings", () =>
    require("./service-client").getServiceSettings());
  ipcMain.handle("service:test-connection", () =>
    require("./service-client").testConnection());

  ipcMain.handle("updates:get-settings", () =>
    require("./update-manager").getUpdateSettings());
  ipcMain.handle("updates:get-state", () =>
    require("./update-manager").getUpdateState());
  ipcMain.handle("updates:check", () => {
    const licensed = require("./license-manager").requireValidLicense();
    if (!licensed.ok) return licensed;
    return require("./update-manager").checkForUpdatesState();
  });
  ipcMain.handle("updates:download", () => {
    const licensed = require("./license-manager").requireValidLicense();
    if (!licensed.ok) return licensed;
    return require("./update-manager").downloadUpdate();
  });
  ipcMain.handle("updates:install", (_event, payload) => {
    const licensed = require("./license-manager").requireValidLicense();
    if (!licensed.ok) return licensed;
    return require("./update-manager").installUpdate(payload || {});
  });
  ipcMain.handle("updates:open-download", (_event, payload) => {
    const licensed = require("./license-manager").requireValidLicense();
    if (!licensed.ok) return licensed;
    return require("./update-manager").openUpdateDownload(payload?.url || payload);
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
  registerFileTreeHandlers();
}

module.exports = { registerAll };
