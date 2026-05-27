"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("assistantClient", {
  // --- Assistant -----------------------------------------------------------

  sendMessage: (text, files) =>
    ipcRenderer.invoke("assistant:input", { text, files }),
  interrupt: () => ipcRenderer.invoke("assistant:interrupt"),
  restart: () => ipcRenderer.invoke("assistant:restart"),

  // --- Full State ----------------------------------------------------------

  getFullState: () => ipcRenderer.invoke("state:full"),

  // --- Projects ------------------------------------------------------------

  listProjects: () => ipcRenderer.invoke("project:list"),
  addProject: () => ipcRenderer.invoke("project:add"),
  switchProject: (projectId) => ipcRenderer.invoke("project:switch", projectId),
  renameProject: (projectId, name) => ipcRenderer.invoke("project:rename", projectId, name),
  pinProject: (projectId) => ipcRenderer.invoke("project:pin", projectId),
  openProject: (projectId) => ipcRenderer.invoke("project:open", projectId),
  removeProject: (projectId) => ipcRenderer.invoke("project:remove", projectId),

  // --- Sessions ------------------------------------------------------------

  listSessions: () => ipcRenderer.invoke("session:list"),
  createSession: (title, projectId) => ipcRenderer.invoke("session:create", title, projectId),
  switchSession: (sessionId) => ipcRenderer.invoke("session:switch", sessionId),
  renameSession: (sessionId, title) => ipcRenderer.invoke("session:rename", sessionId, title),
  deleteSession: (sessionId) => ipcRenderer.invoke("session:delete", sessionId),
  archiveSession: (sessionId) => ipcRenderer.invoke("session:archive", sessionId),

  // --- Files ---------------------------------------------------------------

  pickFiles: () => ipcRenderer.invoke("files:pick"),
  stageFile: (filePath, fileName) => ipcRenderer.invoke("files:stage", filePath, fileName),
  pasteImage: (buffer, fileName) => ipcRenderer.invoke("files:paste", buffer, fileName),
  getFileThumbnail: (fileId) => ipcRenderer.invoke("files:thumbnail", fileId),
  removeFile: (fileId) => ipcRenderer.invoke("files:remove", fileId),
  getImageDimensions: (fileId) => ipcRenderer.invoke("files:dimensions", fileId),

  // --- File Tree -----------------------------------------------------------

  getFileTree: (projectId) => ipcRenderer.invoke("filetree:get", projectId),
  watchProject: (projectId) => ipcRenderer.invoke("filetree:watch", projectId),
  unwatchProject: (projectId) => ipcRenderer.invoke("filetree:unwatch", projectId),

  // --- Diff ----------------------------------------------------------------

  getDiff: (projectId) => ipcRenderer.invoke("diff:get", projectId),
  acceptDiff: (filePaths) => ipcRenderer.invoke("diff:accept", null, filePaths),
  rejectDiff: (filePaths) => ipcRenderer.invoke("diff:reject", null, filePaths),

  // --- Terminal ------------------------------------------------------------

  terminalCreate: (opts) => ipcRenderer.invoke("terminal:create", opts),
  terminalWrite: (terminalId, data) => ipcRenderer.invoke("terminal:write", terminalId, data),
  terminalResize: (terminalId, cols, rows) => ipcRenderer.invoke("terminal:resize", terminalId, cols, rows),
  terminalDestroy: (terminalId) => ipcRenderer.invoke("terminal:destroy", terminalId),

  // --- Templates -----------------------------------------------------------

  listTemplates: () => ipcRenderer.invoke("templates:list"),
  addTemplate: (title, prompt) => ipcRenderer.invoke("templates:add", title, prompt),
  removeTemplate: (id) => ipcRenderer.invoke("templates:remove", id),

  // --- Plugins -------------------------------------------------------------

  listPlugins: () => ipcRenderer.invoke("plugins:list"),
  installPlugin: (pluginId, scope) => ipcRenderer.invoke("plugins:install", pluginId, scope),
  setPluginEnabled: (pluginId, scope, enabled) =>
    ipcRenderer.invoke("plugins:set-enabled", pluginId, scope, enabled),
  uninstallPlugin: (pluginId, scope) => ipcRenderer.invoke("plugins:uninstall", pluginId, scope),

  // --- Events from main process --------------------------------------------

  onChunk: (callback) => {
    ipcRenderer.on("assistant:chunk", (_event, data) => callback(data));
  },
  onStatus: (callback) => {
    ipcRenderer.on("assistant:status", (_event, data) => callback(data));
  },
  onDone: (callback) => {
    ipcRenderer.on("assistant:done", (_event, data) => callback(data));
  },
  onError: (callback) => {
    ipcRenderer.on("assistant:error", (_event, data) => callback(data));
  },
  onTool: (callback) => {
    ipcRenderer.on("assistant:tool", (_event, data) => callback(data));
  },
  onToolDone: (callback) => {
    ipcRenderer.on("assistant:tool-done", (_event, data) => callback(data));
  },
  onFileChange: (callback) => {
    ipcRenderer.on("filetree:change", (_event, data) => callback(data));
  },
  onTerminalData: (callback) => {
    ipcRenderer.on("terminal:data", (_event, data) => callback(data));
  },
  onTerminalExit: (callback) => {
    ipcRenderer.on("terminal:exit", (_event, data) => callback(data));
  },
});
