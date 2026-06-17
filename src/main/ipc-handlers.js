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
const { registerScheduledTaskHandlers } = require("./ipc-scheduled-tasks");
const { registerConnectorHandlers } = require("./ipc-connectors");
const { RuntimeEventBus } = require("./runtime-event-bus");
const { TranscriptStore } = require("./transcript-store");
const { TurnArchive } = require("./turn-archive");
const { TurnOrchestrator } = require("./turn-orchestrator");
const { buildFullStateSnapshot } = require("./state-snapshot");

function registerAll(ctx) {
  const {
    mainWindow, projectManager, sessionManager,
    stagingManager, runnerPool,
  } = ctx;
  ctx.eventBus = new RuntimeEventBus(() => ctx.mainWindow);
  ctx.transcriptStore = new TranscriptStore(sessionManager);
  ctx.turnArchive = new TurnArchive(sessionManager);
  ctx.turnOrchestrator = new TurnOrchestrator(ctx);

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
    const cliPath = resolveAgentCommand();
    const agent = ctx.agentBootstrap || { ok: false };
    const cliReady = Boolean(cliPath && fs.existsSync(cliPath));
    return buildFullStateSnapshot({
      projectState,
      sessionManager,
      runnerPool,
      getRuntimeSnapshot: (sessionId) => ctx.turnOrchestrator.snapshot(sessionId),
      agent,
      cliPath,
      cliReady,
      models: listPresetsPublic(),
      permissions: require("./permission-settings").listPermissionsPublic(),
    });
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
  ipcMain.handle("apps:catalog", () =>
    require("./service-client").workspaceAppCatalog()
      .then((result) => require("./workspace-app-installs").attachInstalledState(result, projectManager)));

  ipcMain.handle("updates:get-settings", () =>
    require("./update-manager").getUpdateSettings());
  ipcMain.handle("updates:get-state", () =>
    require("./update-manager").getUpdateState());
  ipcMain.handle("updates:check", () =>
    require("./update-manager").checkForUpdatesState());
  ipcMain.handle("updates:kick-check", () => require("./update-scheduler").kickUpdateCheck());
  ipcMain.handle("updates:download", () =>
    require("./update-manager").downloadUpdate());
  ipcMain.handle("updates:install", (_event, payload) =>
    require("./update-manager").installUpdate(payload || {}));
  ipcMain.handle("updates:open-download", (_event, payload) =>
    require("./update-manager").openUpdateDownload(payload?.url || payload));

  // Runtime packs are installed by the agent (skill lily-runtime-packs), not by
  // the app — so there is no install IPC here. The app only reads installed
  // packs (runtime-packs.js → getRuntimePackPythonPaths) to upgrade the document
  // extractor's PYTHONPATH; the server admin console manages the catalog.

  // --- Sub-module registrations ---

  registerFileHandlers(mainWindow, stagingManager);
  registerModelHandlers(ctx);
  registerPermissionHandlers(ctx);
  registerSearchHandlers(ctx);
  registerProjectHandlers(ctx);
  registerSessionHandlers(ctx);
  registerSkillHandlers(ctx);
  registerAssistantHandlers(ctx);
  registerFileTreeHandlers(ctx);
  registerScheduledTaskHandlers(ctx);
  registerConnectorHandlers(ctx);

  ipcMain.handle("usage:get-summary", async () => require("./usage-settings").getUsageSettingsPublic());

  ipcMain.handle("support:submit-feedback", async (_event, payload) => {
    const support = require("./support-contact");
    const category = String(payload?.category || "").trim();
    const subject = String(payload?.subject || category || "Feedback").trim().slice(0, 160);
    return support.submitContactRequestPublic({
      name: payload?.name || "Desktop User",
      email: payload?.email,
      subject,
      message: payload?.message,
      source: "desktop-feedback",
      appendContext: support.getFeedbackContext(category),
    });
  });

  ipcMain.handle("support:submit-contact", async (_event, payload) =>
    require("./support-contact").submitContactRequestPublic({
      ...payload,
      source: payload?.source || "desktop-contact",
    }),
  );
}

module.exports = { registerAll };
