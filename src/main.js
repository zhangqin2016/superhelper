"use strict";

const { app, BrowserWindow } = require("electron");
const path = require("node:path");

const { PROJECT_ROOT } = require("./main/config");
const ProjectManager = require("./main/project-manager");
const SessionManager = require("./main/session-manager");
const PluginManager = require("./main/plugin-manager");
const FileStagingManager = require("./main/file-staging-manager");
const { ClaudeRunner } = require("./main/claude-runner");
const FileWatcher = require("./main/file-watcher");
const DiffRunner = require("./main/diff-runner");
const TerminalManager = require("./main/terminal-manager");
const TemplateStore = require("./main/template-store");
const ipcHandlers = require("./main/ipc-handlers");

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: "智能助手",
    backgroundColor: "#0f1119",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  const projectManager = new ProjectManager(PROJECT_ROOT);
  projectManager.load();

  const sessionManager = new SessionManager(projectManager);
  sessionManager.load();

  const pluginManager = new PluginManager(projectManager);
  const stagingManager = new FileStagingManager();
  const fileWatcher = new FileWatcher();
  const diffRunner = new DiffRunner();
  const terminalManager = new TerminalManager();
  const templateStore = new TemplateStore();
  const runner = new ClaudeRunner();

  createWindow();

  ipcHandlers.registerAll({
    get mainWindow() {
      return mainWindow;
    },
    projectManager,
    sessionManager,
    pluginManager,
    stagingManager,
    fileWatcher,
    diffRunner,
    terminalManager,
    templateStore,
    runner,
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("before-quit", () => {
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
