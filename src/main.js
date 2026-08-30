"use strict";

const { app, BrowserWindow, powerMonitor } = require("electron");
const path = require("node:path");

const { defaultWorkspacePath } = require("./main/config");
const { loadAppIconImage } = require("./main/app-icon");
const { resolveOpencodeCommand } = require("./main/agent-command");
const ProjectManager = require("./main/project-manager");
const SessionManager = require("./main/session-manager");
const FileStagingManager = require("./main/file-staging-manager");
const { SessionRunnerPool } = require("./main/session-runner-pool");
const { ScheduledTaskManager } = require("./main/scheduled-tasks");
const { ensureConnectorBridgeStarted, stopConnectorBridge } = require("./main/connector-bridge");
const ipcHandlers = require("./main/ipc-handlers");
const { wireExternalLinks } = require("./main/window-links");
const { wireContextMenu } = require("./main/window-context-menu");
const { registerBlobScheme, installBlobProtocol } = require("./main/blob-protocol");
const { registerLocalMediaScheme, installLocalMediaProtocol } = require("./main/local-media-protocol");

// Custom scheme privileges must be declared before app `ready`; the request
// handler itself is installed in whenReady() below.
registerBlobScheme();
registerLocalMediaScheme();

let mainWindow = null;
let runnerPoolRef = null;
let sessionManagerRef = null;
let scheduledTaskManagerRef = null;
let characterWorldsServiceRef = null;
let collaborationServiceRef = null;
let longTaskSupervisorRef = null;
let agentRuntimeControlServerRef = null;
let publicHookBridgeRef = null;
let runtimePackAutoRepairRef = null;
let shouldFocusMainWindowWhenReady = false;
/** @type {{ ok: boolean, mode?: string, error?: string, message?: string } | null} */
let agentBootstrap = null;

// Keep persisted app data stable across display-name changes.
app.setPath("userData", path.join(app.getPath("appData"), "lily-workbench"));
app.setName("Lily Workbench");
if (process.platform === "win32") {
  app.setAppUserModelId("cn.lilywb.workbench");
}

// Hand the host's resolved base dirs to config once, so config (and everything
// that imports it) needs no electron at call time — keeps it testable/reusable.
require("./main/config").bindRuntimePaths({
  userData: app.getPath("userData"),
  home: app.getPath("home"),
  documents: app.getPath("documents"),
});

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return false;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }
  mainWindow.focus();
  return true;
}

if (hasSingleInstanceLock) {
  app.on("second-instance", () => {
    if (!focusMainWindow()) {
      shouldFocusMainWindowWhenReady = true;
    }
  });
}

function createWindow() {
  const appIcon = loadAppIconImage();
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: "Lily Workbench",
    ...(appIcon ? { icon: appIcon } : {}),
    backgroundColor: "#0f1119",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  if (process.env.LILY_DEBUG_RENDERER) {
    mainWindow.webContents.on("console-message", (_e, level, message, line, source) => {
      console.log(`[renderer:${level}] ${message} (${source}:${line})`);
    });
    mainWindow.webContents.on("render-process-gone", (_e, details) => {
      console.log(`[renderer-gone] ${JSON.stringify(details)}`);
    });
    mainWindow.webContents.on("did-fail-load", (_e, code, desc, url) => {
      console.log(`[did-fail-load] ${code} ${desc} ${url}`);
    });
    mainWindow.webContents.on("preload-error", (_e, p, err) => {
      console.log(`[preload-error] ${p} ${err?.stack || err}`);
    });
  }

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  wireExternalLinks(mainWindow);
  wireContextMenu(mainWindow);
  require("./main/update-manager").configure({ mainWindow });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  if (shouldFocusMainWindowWhenReady) {
    shouldFocusMainWindowWhenReady = false;
    focusMainWindow();
  }
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) {
    return;
  }

  installBlobProtocol();
  installLocalMediaProtocol();
  const appIcon = loadAppIconImage();
  if (appIcon && process.platform === "darwin" && app.dock) {
    const ok = app.dock.setIcon(appIcon);
    if (!ok) {
      console.warn("[app-icon] app.dock.setIcon returned false");
    }
  }

  const enginePath = resolveOpencodeCommand();
  agentBootstrap = enginePath
    ? { ok: true, mode: "opencode", cliPath: enginePath }
    : { ok: false, error: "OPENCODE_ENGINE_MISSING" };
  if (!agentBootstrap.ok) {
    console.error("[engine]", agentBootstrap.error);
  } else {
    console.info("[engine]", agentBootstrap.mode, agentBootstrap.cliPath);
  }

  require("./main/data-migration").runDataMigrations();

  const { getRuntimeSummary } = require("./main/runtime-python");
  const runtimeSummary = getRuntimeSummary();
  if (runtimeSummary.available) {
    console.info("[runtime] available at", runtimeSummary.root);
  } else if (process.platform === "win32") {
    console.warn(
      "[runtime] 内置 Python/LibreOffice 不可用 — 请在 Windows 上运行 npm run build:runtime 后重建安装包",
    );
  }

  const projectManager = new ProjectManager(defaultWorkspacePath());
  projectManager.load();

  const sessionManager = new SessionManager(projectManager);
  sessionManager.load();
  sessionManagerRef = sessionManager;
  // Drop OpenCode engine caches left by deleted sessions / crashes (orphans).
  const gcRemoved = sessionManager.gcOrphanEngineSessions();
  if (gcRemoved) console.info("[engine] cleaned", gcRemoved, "orphan opencode session cache(s)");

  // Character Worlds (Phase 1): one service over the existing MessageStore.
  // Import sources are limited to the user's home via the pinned source
  // authority; exports go through save-dialog-approved broker reservations.
  // Owner scope is always derived in this process — never taken from the
  // renderer. Service state is immutable/cache-only (no global "current"
  // character). Construction must NEVER block startup: a corrupt/locked
  // messages.db leaves the feature disabled (IPC fails closed with
  // CHARACTER_WORLDS_UNAVAILABLE, the turn orchestrator runs native Lily).
  let characterWorldsService = null;
  let characterWorldsRepository = null;
  try {
    const characterWorlds = require("./main/character-worlds/service");
    const {
      resolveCharacterOwnerScope,
    } = require("./main/character-worlds/owner-scope");
    const {
      DialogDestinationBroker,
    } = require("./main/character-worlds/dialog-destination-broker");
    characterWorldsRepository = sessionManager._store().characterWorlds();
    characterWorldsService = new characterWorlds.CharacterWorldsService({
      messageStore: sessionManager._store(),
      repository: characterWorldsRepository,
      sourceAuthority: new characterWorlds.CharacterSourceAuthority({
        roots: [require("./main/config").userHome()],
      }),
      destinationWriter: new characterWorlds.CharacterDestinationWriter({
        broker: new DialogDestinationBroker(),
        ownsBroker: true,
      }),
      ownsDestinationWriter: true,
      resolveOwnerScope: async () => resolveCharacterOwnerScope(),
    });
    characterWorldsServiceRef = characterWorldsService;
  } catch (err) {
    characterWorldsService = null;
    characterWorldsRepository = null;
    console.warn("[character-worlds] disabled:", err?.message || err);
  }

  const stagingManager = new FileStagingManager();
  const runnerPool = new SessionRunnerPool();
  runnerPoolRef = runnerPool;
  const scheduledTaskManager = new ScheduledTaskManager();
  scheduledTaskManager.load();
  scheduledTaskManagerRef = scheduledTaskManager;
  // Collaboration is additive. A missing account, disabled signed policy, or
  // locked OS keyring must leave the ordinary workbench entirely unaffected.
  const collaboration = require("./main/collaboration/service");
  const { createCollaborationClient } = require("./main/collaboration/client");
  const remoteConfig = require("./main/remote-config");
  const accountManager = require("./main/account-manager");
  const serviceClient = require("./main/service-client");
  let collaborationService = null;
  let unsubscribeCollaborationService = null;
  const collaborationStateListeners = new Set();
  const notifyCollaborationState = (change) => {
    for (const listener of collaborationStateListeners) {
      try { listener(change || { type: "availability" }); } catch { /* renderer observers are optional */ }
    }
  };
  const refreshCollaborationService = () => {
    try { unsubscribeCollaborationService?.(); } catch { /* optional observer */ }
    unsubscribeCollaborationService = null;
    try { collaborationService?.stop?.(); } catch { /* optional cache only */ }
    collaborationService = collaboration.initializeCollaborationService({
      policy: remoteConfig.getRemoteCollaborationPolicySync(),
      accountStatus: () => accountManager.accountStatus(),
      createService: ({ storeOptions, policy }) => {
        const deviceId = serviceClient.getDeviceId();
        const client = createCollaborationClient({
          accountManager,
          // serviceFetch applies the desktop's signed device headers in the
          // main process. The renderer never sees either those headers or the
          // short-lived bearer token consumed by this client.
          signDeviceRequest: async () => ({}),
          request: async ({ path: requestPath, method, body, headers }) => {
            const result = await serviceClient.serviceFetch(requestPath, {
              method,
              body: JSON.stringify(body || {}),
              headers,
            });
            return {
              ok: result.ok,
              status: result.status || (result.ok ? 200 : 0),
              json: result.json,
              code: result.error,
            };
          },
        });
        return collaboration.createCollaborationService({
          storeOptions,
          client,
          realtimeEnabled: policy?.realtime !== false,
          deviceId,
          transport: {
            submit: (item) => client.submitMessage({
              action: "send",
              deviceId,
              conversationId: item.conversationId,
              clientCommandId: item.clientCommandId,
              bodyText: item.bodyText,
            }),
            lookupReceipt: ({ clientCommandId, conversationId }) => client.lookupCommandReceipt({
              deviceId, clientCommandId, conversationId,
            }),
          },
          realtimeOptions: { syncArgs: { deviceId } },
        });
      },
    });
    if (collaborationService?.ok) collaborationService.start();
    if (collaborationService?.ok) unsubscribeCollaborationService = collaborationService.subscribe?.(notifyCollaborationState) || null;
    collaborationServiceRef = collaborationService?.ok ? collaborationService : null;
    notifyCollaborationState({ type: "availability" });
    return collaborationService;
  };
  refreshCollaborationService();
  remoteConfig.onRemoteConfigRefreshed(refreshCollaborationService);
  require("./main/app-watchdog").startAppWatchdog({
    sessionManager,
    runnerPool,
  });
  await ensureConnectorBridgeStarted({
    scheduledTaskManager,
    // Conversation-created scheduled tasks bind to the ACTIVE session/workspace,
    // mirroring what the Auto-run composer entry does.
    resolveActiveScope: () => {
      const active = sessionManager.getActive();
      return active ? { sessionId: active.id, projectId: active.projectId } : null;
    },
  }).catch((err) => {
    console.warn("[connector-bridge]", err?.message || err);
  });

  createWindow();
  require("./main/startup-health").scheduleStartupHealthCheck({
    getWindow: () => mainWindow,
    getAgentBootstrap: () => agentBootstrap,
  });
  // Surface legacy-message migration progress to the renderer (non-blocking).
  sessionManager.setProgressNotifier((payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("sessions:migration-progress", payload);
    }
  });
  require("./main/update-manager").configure({
    runnerPool,
    sessionManager,
  });

  require("./main/service-client")
    .registerDevice()
    .then((result) => {
      if (!result.ok && result.error !== "NO_SERVICE_URL") {
        console.warn("[device-register]", result.error, result.detail || "");
      }
      return require("./main/remote-config").refreshRemoteConfig();
    })
    .then((result) => {
      if (result && !result.ok && result.error !== "NO_SERVICE_URL") {
        console.warn("[remote-config]", result.error, result.detail || "");
      }
    })
    .catch((err) => console.warn("[device-register]", err?.message || err));

  require("./main/license-manager")
    .refreshServerLicense()
    .then(() => require("./main/remote-config").refreshRemoteConfig())
    .then((result) => {
      if (result && !result.ok && result.error !== "NO_SERVICE_URL") {
        console.warn("[remote-config]", result.error, result.detail || "");
      }
    })
    .catch((err) => console.warn("[license-refresh]", err?.message || err));

  const appContext = {
    get mainWindow() {
      return mainWindow;
    },
    get agentBootstrap() {
      return agentBootstrap;
    },
    projectManager,
    sessionManager,
    stagingManager,
    runnerPool,
    scheduledTaskManager,
    characterWorldsService,
    characterWorldsRepository,
    get collaborationService() {
      return collaborationService;
    },
    refreshCollaborationService,
    onCollaborationStateChange(listener) {
      if (typeof listener !== "function") return () => {};
      collaborationStateListeners.add(listener);
      return () => collaborationStateListeners.delete(listener);
    },
  };

  ipcHandlers.registerAll(appContext);
  agentRuntimeControlServerRef = appContext.agentRuntimeControlServer || null;
  publicHookBridgeRef = appContext.publicHookBridge || null;
  try {
    const { longTaskDbPath } = require("./main/config");
    const { LongTaskSupervisor } = require("./main/long-task/supervisor");
    const { createLongTaskWakeHandler } = require("./main/long-task/session-wakeup");
    const jobsDir = path.join(path.dirname(longTaskDbPath()), "process-jobs");
    const migration = require("./main/long-task/legacy-migration").migrateLegacyProcessJobs({
      legacyPath: path.join(jobsDir, "jobs.json"),
      dbPath: longTaskDbPath(),
    });
    if (!migration.ok) console.warn("[long-task] legacy registry migration:", migration.error);
    const supervisor = new LongTaskSupervisor({
      dbPath: longTaskDbPath(),
      jobsDir,
      onWake: createLongTaskWakeHandler(appContext),
    });
    supervisor.start();
    longTaskSupervisorRef = supervisor;
    powerMonitor.on("resume", () => void supervisor.handleResume());
  } catch (err) {
    console.warn("[long-task] supervisor disabled:", err?.message || err);
  }
  require("./main/voice-dictation-service").registerVoiceDictationIpc();
  try {
    require("./main/ipc-mobile-pairing").registerMobilePairingIpc(appContext);
  } catch (err) {
    console.warn("[mobile-pairing] IPC registration skipped:", err?.message || err);
  }
  scheduledTaskManager.start(appContext);

  require("./main/update-scheduler").startBackgroundUpdateChecks({
    runnerPool,
    sessionManager,
  });

  const runtimePackRepair = require("./main/runtime-pack-auto-repair");
  runtimePackAutoRepairRef = runtimePackRepair.scheduleRuntimePackAutoRepair({
    // Health probes can cold-import several gigabytes of optional runtimes.
    // Run outside Electron at background priority and only after the user and
    // every agent are idle, so self-healing never competes with foreground work.
    isIdle: () => {
      const runnerBusy = runnerPool.getSessionIds().some((sessionId) => runnerPool.get(sessionId)?.isBusy?.());
      return !runnerBusy && powerMonitor.getSystemIdleTime() >= 60;
    },
    startRepair: () => runtimePackRepair.startRuntimePackAutoRepair({
        basePaths: {
          userData: app.getPath("userData"),
          home: app.getPath("home"),
          documents: app.getPath("documents"),
        },
        isPackaged: app.isPackaged,
      }),
  });
  runtimePackAutoRepairRef.promise
      .then((result) => {
        const repaired = (result?.results || []).filter((item) => item.ok && item.repaired);
        if (repaired.length) {
          console.info("[runtime-packs] repaired", repaired.map((item) => item.id).join(", "));
          try {
            require("./main/runner-live-config").terminateIdleRunners(runnerPool);
          } catch {
            // Runner refresh is best-effort; new turns always receive fresh env.
          }
        }
      })
      .catch((err) => console.warn("[runtime-packs] auto-repair failed", err?.message || err));

  if (process.platform === "win32") {
    // Legacy-install healing (改名遗留): old-appId installs pass their local
    // license check but speak a dead protocol, so users launching a stale
    // shortcut see "licensed but never works". Detect + offer one-click
    // uninstall of the OLD product (its own uninstaller, with consent).
    setTimeout(() => {
      require("./main/windows-legacy-installs")
        .maybeHealLegacyInstallsWindows({ mainWindow })
        .then((result) => {
          if (result?.found) console.info("[legacy-installs]", JSON.stringify(result));
        })
        .catch((err) => console.warn("[legacy-installs] check failed", err?.message || err));
    }, 20_000);
  } else if (process.platform === "darwin") {
    // Same 改名遗留 problem on macOS: stale .app bundles pass their local
    // license check but speak a dead protocol. Detect + offer Trash-with-consent.
    setTimeout(() => {
      require("./main/mac-legacy-installs")
        .maybeHealLegacyInstallsMac({ mainWindow })
        .then((result) => {
          if (result?.found) console.info("[legacy-installs]", JSON.stringify(result));
        })
        .catch((err) => console.warn("[legacy-installs] check failed", err?.message || err));
    }, 20_000);
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("before-quit", () => {
  longTaskSupervisorRef?.close();
  runtimePackAutoRepairRef?.cancel?.();
  scheduledTaskManagerRef?.close();
  sessionManagerRef?.saveImmediate();
  runnerPoolRef?.terminateAll();
  try { agentRuntimeControlServerRef?.stop?.().catch?.(() => {}); } catch { /* best effort */ }
  try { publicHookBridgeRef?.stop?.().catch?.(() => {}); } catch { /* best effort */ }
  // Best-effort and intentionally NOT awaited: before-quit cannot block on the
  // async drain of in-flight imports/exports and worker/broker helpers. An
  // export whose commit outcome is unknown at quit is reconciled on next
  // launch (writer/broker reconciliation), and each broker helper's own
  // emergencyCleanup covers the helper-process side.
  try { characterWorldsServiceRef?.close()?.catch?.(() => {}); } catch { /* best effort */ }
  try { collaborationServiceRef?.stop?.(); } catch { /* optional cache only */ }
  // Backstop: reap the shared opencode serve + its whole tool-process tree even
  // if a session leaked its view. This is what keeps closing the app from
  // leaving node/python/engine children alive that lock the install dir (the
  // Windows updater's "could not be closed").
  try { require("./main/runtime/opencode-shared-server").resetSharedServer(); } catch { /* best effort */ }
  stopConnectorBridge();
  try {
    const { fileStagingDir } = require("./main/config");
    const fs = require("node:fs");
    const stagingDir = fileStagingDir();
    if (fs.existsSync(stagingDir)) {
      for (const file of fs.readdirSync(stagingDir)) {
        fs.unlinkSync(path.join(stagingDir, file));
      }
    }
  } catch {
    // ignore cleanup errors
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
