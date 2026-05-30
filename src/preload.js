"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("assistantClient", {
  getAppIconUrl: () => ipcRenderer.invoke("app:get-icon-url"),
  getLocale: () => ipcRenderer.invoke("app:get-locale"),
  setLocale: (locale) => ipcRenderer.invoke("app:set-locale", locale),
  sendMessage: (text, files) =>
    ipcRenderer.invoke("assistant:input", { text, files }),
  interrupt: () => ipcRenderer.invoke("assistant:interrupt"),

  getFullState: () => ipcRenderer.invoke("state:full"),

  listModels: () => ipcRenderer.invoke("models:list"),
  setActiveModel: (presetId) => ipcRenderer.invoke("models:set-active", presetId),
  saveCustomModel: (payload) => ipcRenderer.invoke("models:save-custom", payload),
  deleteCustomModel: (presetId) => ipcRenderer.invoke("models:delete-custom", presetId),
  setModelApiGateway: (payload) => ipcRenderer.invoke("models:set-api-gateway", payload),

  listPermissions: () => ipcRenderer.invoke("permissions:list"),
  setActivePermission: (modeId) => ipcRenderer.invoke("permissions:set-active", modeId),

  listSearchSettings: () => ipcRenderer.invoke("search:list"),
  setSearchProvider: (providerId) => ipcRenderer.invoke("search:set-provider", providerId),
  setSearxngUrl: (url) => ipcRenderer.invoke("search:set-searxng-url", url),

  listSkills: () => ipcRenderer.invoke("skills:list"),
  getSessionSkills: (sessionId) => ipcRenderer.invoke("session:get-skills", sessionId),
  setSessionSkills: (sessionId, enabledSkillIds) =>
    ipcRenderer.invoke("session:set-skills", { sessionId, enabledSkillIds }),
  setSkillEnabled: (id, enabled) =>
    ipcRenderer.invoke("skills:set-enabled", { id, enabled }),
  refreshSkills: () => ipcRenderer.invoke("skills:refresh"),
  restoreBundledSkill: (id) => ipcRenderer.invoke("skills:restore-bundled", { id }),
  getRegistryUrl: () => ipcRenderer.invoke("skills:get-registry-url"),
  setRegistryUrl: (url) => ipcRenderer.invoke("skills:set-registry-url", { url }),
  checkSkillUpdates: () => ipcRenderer.invoke("skills:check-updates"),
  installSkill: (id, version) => ipcRenderer.invoke("skills:install", { id, version }),
  updateSkill: (id) => ipcRenderer.invoke("skills:update", { id }),
  uninstallSkill: (id) => ipcRenderer.invoke("skills:uninstall", { id }),

  listProjects: () => ipcRenderer.invoke("project:list"),
  addProject: () => ipcRenderer.invoke("project:add"),
  switchProject: (projectId) => ipcRenderer.invoke("project:switch", projectId),
  renameProject: (projectId, name) => ipcRenderer.invoke("project:rename", projectId, name),
  pinProject: (projectId) => ipcRenderer.invoke("project:pin", projectId),
  openProject: (projectId) => ipcRenderer.invoke("project:open", projectId),
  removeProject: (projectId) => ipcRenderer.invoke("project:remove", projectId),

  listSessions: () => ipcRenderer.invoke("session:list"),
  createSession: (title, projectId) => ipcRenderer.invoke("session:create", title, projectId),
  switchSession: (sessionId) => ipcRenderer.invoke("session:switch", sessionId),
  renameSession: (sessionId, title) => ipcRenderer.invoke("session:rename", sessionId, title),
  deleteSession: (sessionId) => ipcRenderer.invoke("session:delete", sessionId),
  archiveSession: (sessionId) => ipcRenderer.invoke("session:archive", sessionId),

  pickFiles: () => ipcRenderer.invoke("files:pick"),
  stageFile: (filePath, fileName) => ipcRenderer.invoke("files:stage", filePath, fileName),
  pasteImage: (buffer, fileName) => ipcRenderer.invoke("files:paste", buffer, fileName),
  getFileThumbnail: (fileId) => ipcRenderer.invoke("files:thumbnail", fileId),
  getImageDimensions: (fileId) => ipcRenderer.invoke("files:dimensions", fileId),
  clearStagingCache: () => ipcRenderer.invoke("files:clear-staging"),

  onChunk: (callback) => {
    ipcRenderer.on("assistant:chunk", (_event, data) => callback(data));
  },
  onDone: (callback) => {
    ipcRenderer.on("assistant:done", (_event, data) => callback(data));
  },
  onError: (callback) => {
    ipcRenderer.on("assistant:error", (_event, data) => callback(data));
  },
  onStatus: (callback) => {
    ipcRenderer.on("assistant:status", (_event, data) => callback(data));
  },
  onTool: (callback) => {
    ipcRenderer.on("assistant:tool", (_event, data) => callback(data));
  },
  onToolDone: (callback) => {
    ipcRenderer.on("assistant:tool-done", (_event, data) => callback(data));
  },
  onFocusSession: (callback) => {
    ipcRenderer.on("assistant:focus-session", (_event, data) => callback(data));
  },
});
