"use strict";

const { app, BrowserWindow } = require("electron");
const path = require("node:path");

const { PROJECT_ROOT } = require("./main/config");
const { loadAppIconImage } = require("./main/app-icon");
const { bootstrapAgent } = require("./main/agent-bootstrap");
const ProjectManager = require("./main/project-manager");
const SessionManager = require("./main/session-manager");
const FileStagingManager = require("./main/file-staging-manager");
const { SessionRunnerPool } = require("./main/session-runner-pool");
const ipcHandlers = require("./main/ipc-handlers");
const { wireExternalLinks } = require("./main/window-links");

let mainWindow = null;
let runnerPoolRef = null;
/** @type {{ ok: boolean, mode?: string, error?: string, message?: string } | null} */
let agentBootstrap = null;

function createWindow() {
  const appIcon = loadAppIconImage();
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: "智能工作台",
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

  const projectManager = new ProjectManager(PROJECT_ROOT);
  projectManager.load();

  const sessionManager = new SessionManager(projectManager);
  sessionManager.load();

  const stagingManager = new FileStagingManager();
  const runnerPool = new SessionRunnerPool();
  runnerPoolRef = runnerPool;

  createWindow();

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

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("before-quit", () => {
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
