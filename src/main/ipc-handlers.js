"use strict";

const fs = require("node:fs");
const { ipcMain } = require("electron");
const { resolveOpencodeCommand } = require("./agent-command");
const { listPresetsPublic } = require("./model-presets");
const { resolveRuntimeIconDataUrl } = require("./app-icon");
const { listLocalesPublic, setLocale } = require("./locale-settings");
const { registerFileHandlers } = require("./ipc-files");
const { registerModelHandlers, registerPermissionHandlers, registerSearchHandlers, registerMediaProviderHandlers } = require("./ipc-models");
const { registerProjectHandlers } = require("./ipc-projects");
const { registerSessionHandlers, registerSkillHandlers } = require("./ipc-sessions");
const { registerAssistantHandlers } = require("./ipc-assistant");
const { registerFileTreeHandlers } = require("./ipc-filetree");
const { registerScheduledTaskHandlers } = require("./ipc-scheduled-tasks");
const { registerConnectorHandlers } = require("./ipc-connectors");
const { registerRuntimePackHandlers } = require("./ipc-runtime-packs");
const { registerCharacterWorldsHandlers } = require("./ipc-character-worlds");
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
  ctx.eventBus = new RuntimeEventBus(() => ctx.mainWindow, {
    persistEvents: (sessionId, events) => sessionManager.appendRuntimeEvents?.(sessionId, events),
  });
  ctx.transcriptStore = new TranscriptStore(sessionManager);
  ctx.turnArchive = new TurnArchive(sessionManager, { eventBus: ctx.eventBus });
  ctx.turnOrchestrator = new TurnOrchestrator(ctx);
  void ctx.turnOrchestrator.startRecoveredTurns();
  // Surface long async media generations even if their turn was torn down before the
  // result stdout was captured (the skill drops a result record on disk).
  try { require("./media-result-tracker").startMediaResultTracker(ctx); } catch { /* optional */ }

  // --- App ---------------------------------------------------------------

  const { getNotificationSettings, setNotificationSettings } = require("./notification-settings");
  ipcMain.handle("notifications:get", () => ({ ok: true, ...getNotificationSettings() }));
  ipcMain.handle("notifications:set", (_event, patch) => ({ ok: true, ...setNotificationSettings(patch || {}) }));
  // The renderer decides WHETHER a turn warrants an alert (it owns the attention
  // context); main only posts the OS notification — and only when the window is
  // not already focused (a focused window would just be noise). Title/body arrive
  // pre-localized. Clicking brings the app forward and switches to that session.
  // `silent` because the renderer plays its own chime.
  ipcMain.handle("notifications:task-done", (_event, payload = {}) => {
    try {
      if (!getNotificationSettings().notify) return { ok: true, shown: false };
      const win = ctx.mainWindow;
      if (win && !win.isDestroyed() && win.isFocused()) return { ok: true, shown: false };
      const { Notification } = require("electron");
      if (!Notification.isSupported()) return { ok: true, shown: false };
      const n = new Notification({
        title: String(payload.title || "").slice(0, 120) || "Lily Workbench",
        body: String(payload.body || "").slice(0, 220),
        silent: true,
      });
      n.on("click", () => {
        if (!win || win.isDestroyed()) return;
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
        if (payload.sessionId) win.webContents.send("assistant:focus-session", { sessionId: payload.sessionId });
      });
      n.show();
      return { ok: true, shown: true };
    } catch {
      return { ok: false };
    }
  });

  ipcMain.handle("app:get-icon-url", () => resolveRuntimeIconDataUrl());
  ipcMain.handle("app:get-version", () => ({ ok: true, version: require("electron").app.getVersion() }));
  ipcMain.handle("app:get-edition", () => ({ ok: true, ...require("./config").appEdition() }));
  ipcMain.handle("app:get-policy", async () => {
    const serviceClient = require("./service-client");
    const policy = await serviceClient.refreshClientBootstrap().catch(() => serviceClient.getClientPolicy());
    return { ok: policy?.ok !== false, ...serviceClient.getClientPolicy(), ...(policy || {}) };
  });
  ipcMain.handle("app:get-locale", () => ({ ok: true, ...listLocalesPublic() }));
  ipcMain.handle("app:set-locale", (_event, locale) => {
    const result = setLocale(locale);
    return { ok: true, locale: result.locale, supported: listLocalesPublic().supported };
  });

  // --- State ---------------------------------------------------------------

  ipcMain.handle("state:full", () => {
    const projectState = projectManager.getAppState();
    const cliPath = resolveOpencodeCommand();
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
  ipcMain.handle("license:activate", async (_event, payload) => {
    const result = await require("./license-manager").activateLicense(payload?.token || payload);
    if (result?.ok) {
      try {
        const configRefresh = await require("./ipc-utils").refreshRemoteConfigForSend({
          force: true,
          timeoutMs: 90_000,
          repairManagedService: true,
          refreshLicense: false,
          reason: "license_activate",
        });
        if (configRefresh?.ok) {
          require("./runner-live-config").terminateIdleRunners(ctx.runnerPool);
        }
        return {
          ...result,
          modelConfigReady: Boolean(configRefresh?.ok),
          modelConfigError: configRefresh?.ok ? "" : String(configRefresh?.error || "CONFIG_REFRESH_FAILED"),
        };
      } catch (err) {
        // Activation stays valid offline; the next send/settings open will refresh again.
        return {
          ...result,
          modelConfigReady: false,
          modelConfigError: err?.message || "CONFIG_REFRESH_FAILED",
        };
      }
    }
    return result;
  });
  ipcMain.handle("license:clear", () =>
    require("./license-manager").clearLicense());
  ipcMain.handle("license:refresh", () =>
    require("./license-manager").refreshServerLicense());

  const accountDisabled = () => {
    const features = require("./service-client").getClientPolicy().features || {};
    return features.account === false || features.accountLogin === false;
  };
  const disabledAccountResult = () => ({ ok: false, error: "ACCOUNT_FEATURE_DISABLED" });
  ipcMain.handle("account:status", () =>
    accountDisabled() ? { ok: true, loggedIn: false, disabled: true } : require("./account-manager").accountStatus());
  ipcMain.handle("account:sms-send", async (_event, payload) =>
    accountDisabled() ? disabledAccountResult() : require("./account-manager").sendSmsCode(payload?.phone || payload));
  ipcMain.handle("account:sms-login", async (_event, payload) => {
    if (accountDisabled()) return disabledAccountResult();
    const result = await require("./account-manager").loginWithSms(payload || {});
    if (!result?.ok) return result;
    ctx.scheduledTaskManager?.handlePrincipalChange?.();
    ctx.turnOrchestrator?.handlePrincipalChange?.();
    try {
      const configRefresh = await require("./ipc-utils").refreshRemoteConfigForSend({
        force: true,
        timeoutMs: 45_000,
        repairManagedService: true,
        refreshLicense: false,
        reason: "account_login",
      });
      if (configRefresh?.ok) {
        require("./runner-live-config").terminateIdleRunners(ctx.runnerPool);
      }
      return {
        ...result,
        modelConfigReady: Boolean(configRefresh?.ok),
        modelConfigError: configRefresh?.ok ? "" : String(configRefresh?.error || "CONFIG_REFRESH_FAILED"),
      };
    } catch (err) {
      return {
        ...result,
        modelConfigReady: false,
        modelConfigError: err?.message || "CONFIG_REFRESH_FAILED",
      };
    }
  });
  ipcMain.handle("account:entitlements", () =>
    accountDisabled() ? disabledAccountResult() : require("./account-manager").refreshEntitlements());
  ipcMain.handle("account:billing-link", () =>
    accountDisabled() ? disabledAccountResult() : require("./account-manager").createBillingLink());
  ipcMain.handle("account:logout", async () => {
    if (accountDisabled()) return { ok: true };
    const result = await require("./account-manager").logout();
    ctx.scheduledTaskManager?.handlePrincipalChange?.();
    ctx.turnOrchestrator?.handlePrincipalChange?.();
    return result;
  });

  ipcMain.handle("service:get-settings", () =>
    require("./service-client").getServiceSettings());
  ipcMain.handle("service:test-connection", () =>
    require("./service-client").testConnection());
  ipcMain.handle("apps:catalog", () =>
    require("./service-client").workspaceAppCatalog()
      .then((result) => {
        const workspaceAppInstalls = require("./workspace-app-installs");
        return workspaceAppInstalls.attachInstalledState(
          workspaceAppInstalls.withCatalogCacheFallback(result),
          projectManager,
        );
      }));

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

  // --- Sub-module registrations ---

  registerFileHandlers(mainWindow, stagingManager);
  registerModelHandlers(ctx);
  registerPermissionHandlers(ctx);
  registerSearchHandlers(ctx);
  registerMediaProviderHandlers(ctx);
  registerProjectHandlers(ctx);
  registerSessionHandlers(ctx);
  registerSkillHandlers(ctx);
  registerAssistantHandlers(ctx);
  registerFileTreeHandlers(ctx);
  registerScheduledTaskHandlers(ctx);
  registerConnectorHandlers(ctx);
  registerRuntimePackHandlers(ctx);
  registerCharacterWorldsHandlers(ctx);

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
  ipcMain.handle("support:run-diagnostics", async () => {
    let workspacePath = "";
    try {
      workspacePath = projectManager?.getActive?.()?.path || "";
    } catch {}
    return require("./support-diagnostics").runSupportDiagnosticsPublic({ workspacePath });
  });
  ipcMain.handle("support:submit-diagnostics-feedback", async (_event, payload) =>
    require("./support-diagnostics").submitDiagnosticsFeedbackPublic(payload || {}));
}

module.exports = { registerAll };
