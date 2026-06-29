"use strict";

const { app, BrowserWindow } = require("electron");
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
let shouldFocusMainWindowWhenReady = false;
/** @type {{ ok: boolean, mode?: string, error?: string, message?: string } | null} */
let agentBootstrap = null;

// Keep persisted app data stable across display-name changes.
app.setPath("userData", path.join(app.getPath("appData"), "lily-workbench"));
app.setName("Lily Workbench");

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

  const stagingManager = new FileStagingManager();
  const runnerPool = new SessionRunnerPool();
  runnerPoolRef = runnerPool;
  const scheduledTaskManager = new ScheduledTaskManager();
  scheduledTaskManager.load();
  scheduledTaskManagerRef = scheduledTaskManager;
  require("./main/app-watchdog").startAppWatchdog({
    sessionManager,
    runnerPool,
  });
  await ensureConnectorBridgeStarted().catch((err) => {
    console.warn("[connector-bridge]", err?.message || err);
  });

  createWindow();
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
  };

  ipcHandlers.registerAll(appContext);
  scheduledTaskManager.start(appContext);

  require("./main/update-scheduler").startBackgroundUpdateChecks({
    runnerPool,
    sessionManager,
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("before-quit", () => {
  scheduledTaskManagerRef?.stop();
  scheduledTaskManagerRef?.save();
  sessionManagerRef?.saveImmediate();
  runnerPoolRef?.terminateAll();
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
