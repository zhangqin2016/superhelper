"use strict";

const { app, BrowserWindow } = require("electron");
const path = require("node:path");

const { defaultWorkspacePath } = require("./main/config");
const { loadAppIconImage } = require("./main/app-icon");
const { bootstrapAgent } = require("./main/agent-bootstrap");
const ProjectManager = require("./main/project-manager");
const SessionManager = require("./main/session-manager");
const FileStagingManager = require("./main/file-staging-manager");
const { SessionRunnerPool } = require("./main/session-runner-pool");
const ipcHandlers = require("./main/ipc-handlers");
const { wireExternalLinks } = require("./main/window-links");
const { wireContextMenu } = require("./main/window-context-menu");

let mainWindow = null;
let runnerPoolRef = null;
let sessionManagerRef = null;
/** @type {{ ok: boolean, mode?: string, error?: string, message?: string } | null} */
let agentBootstrap = null;

// Keep persisted app data stable across display-name changes.
app.setPath("userData", path.join(app.getPath("appData"), "lily-workbench"));
app.setName("Lily Workbench");

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

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  wireExternalLinks(mainWindow);
  wireContextMenu(mainWindow);
  require("./main/update-manager").configure({ mainWindow });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  const appIcon = loadAppIconImage();
  if (appIcon && process.platform === "darwin" && app.dock) {
    const ok = app.dock.setIcon(appIcon);
    if (!ok) {
      console.warn("[app-icon] app.dock.setIcon returned false");
    }
  }

  agentBootstrap = bootstrapAgent();
  if (!agentBootstrap.ok) {
    console.error("[agent-bootstrap]", agentBootstrap.error);
  } else {
    console.info(
      "[agent-bootstrap]",
      agentBootstrap.mode,
      agentBootstrap.cliPath || "(dev-system)",
    );
  }

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

  const stagingManager = new FileStagingManager();
  const runnerPool = new SessionRunnerPool();
  runnerPoolRef = runnerPool;

  createWindow();
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
    })
    .catch((err) => console.warn("[device-register]", err?.message || err));

  require("./main/license-manager")
    .refreshServerLicense()
    .catch((err) => console.warn("[license-refresh]", err?.message || err));

  ipcHandlers.registerAll({
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
  });

  require("./main/update-scheduler").startBackgroundUpdateChecks();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("before-quit", () => {
  sessionManagerRef?.saveImmediate();
  runnerPoolRef?.terminateAll();
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
