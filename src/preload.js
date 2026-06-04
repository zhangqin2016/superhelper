"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("assistantClient", {
  getAppIconUrl: () => ipcRenderer.invoke("app:get-icon-url"),
  getAppVersion: () => ipcRenderer.invoke("app:get-version"),
  getLocale: () => ipcRenderer.invoke("app:get-locale"),
  setLocale: (locale) => ipcRenderer.invoke("app:set-locale", locale),
  sendMessage: (text, files, sessionId, displayFiles) =>
    ipcRenderer.invoke("assistant:input", { text, files, sessionId, displayFiles }),
  interruptAndSend: (text, files, sessionId, displayFiles) =>
    ipcRenderer.invoke("assistant:interrupt-and-send", { text, files, sessionId, displayFiles }),
  retryLastMessage: (sessionId) =>
    ipcRenderer.invoke("assistant:retry", { sessionId }),
  respondPermission: (sessionId, requestId, allow, options = {}) =>
    ipcRenderer.invoke("assistant:permission-response", {
      sessionId,
      requestId,
      allow,
      remember: Boolean(options.remember),
      message: options.message,
    }),
  respondUserQuestion: (sessionId, requestId, answers, response) =>
    ipcRenderer.invoke("assistant:question-response", {
      sessionId,
      requestId,
      answers,
      response,
    }),
  respondHook: (sessionId, requestId, allow, options = {}) =>
    ipcRenderer.invoke("assistant:hook-response", {
      sessionId,
      requestId,
      allow,
      message: options.message,
      updatedInput: options.updatedInput,
    }),
  getTurnState: (sessionId) =>
    ipcRenderer.invoke("assistant:turn-state:snapshot", { sessionId }),
  interrupt: (sessionId) => ipcRenderer.invoke("assistant:interrupt", { sessionId }),
  cancelQueuedMessage: (sessionId, index) =>
    ipcRenderer.invoke("assistant:cancel-queued-message", { sessionId, index }),

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
  getSessionPermission: (sessionId) => ipcRenderer.invoke("session:get-permission", sessionId),
  setSessionPermission: (sessionId, modeId) =>
    ipcRenderer.invoke("session:set-permission", { sessionId, modeId }),

  pickFiles: () => ipcRenderer.invoke("files:pick"),
  stageFile: (filePath, fileName) => ipcRenderer.invoke("files:stage", filePath, fileName),
  pasteImage: (buffer, fileName) => ipcRenderer.invoke("files:paste", buffer, fileName),
  getFileThumbnail: (fileId) => ipcRenderer.invoke("files:thumbnail", fileId),
  getImageDimensions: (fileId) => ipcRenderer.invoke("files:dimensions", fileId),
  clearStagingCache: () => ipcRenderer.invoke("files:clear-staging"),

  getLicenseStatus: () => ipcRenderer.invoke("license:status"),
  activateLicense: (token) => ipcRenderer.invoke("license:activate", { token }),
  refreshLicense: () => ipcRenderer.invoke("license:refresh"),
  clearLicense: () => ipcRenderer.invoke("license:clear"),

  getServiceSettings: () => ipcRenderer.invoke("service:get-settings"),
  testServiceConnection: () => ipcRenderer.invoke("service:test-connection"),

  getUpdateSettings: () => ipcRenderer.invoke("updates:get-settings"),
  getUpdateState: () => ipcRenderer.invoke("updates:get-state"),
  checkForUpdates: () => ipcRenderer.invoke("updates:check"),
  downloadUpdate: () => ipcRenderer.invoke("updates:download"),
  installUpdate: (options) => ipcRenderer.invoke("updates:install", options || {}),
  openUpdateDownload: (url) => ipcRenderer.invoke("updates:open-download", { url }),

  listDirectory: (dirPath) => ipcRenderer.invoke("filetree:list-dir", { dirPath }),
  acceptChange: (sessionId, filePath) =>
    ipcRenderer.invoke("filetree:accept-change", { sessionId, filePath }),
  rejectChange: (sessionId, filePath, content) =>
    ipcRenderer.invoke("filetree:reject-change", { sessionId, filePath, content }),

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
  onToolUpcoming: (callback) => {
    ipcRenderer.on("assistant:tool-upcoming", (_event, data) => callback(data));
  },
  onToolInputDelta: (callback) => {
    ipcRenderer.on("assistant:tool-input-delta", (_event, data) => callback(data));
  },
  onToolInputDone: (callback) => {
    ipcRenderer.on("assistant:tool-input-done", (_event, data) => callback(data));
  },
  onToolDone: (callback) => {
    ipcRenderer.on("assistant:tool-done", (_event, data) => callback(data));
  },
  onPermissionRequest: (callback) => {
    ipcRenderer.on("assistant:permission-request", (_event, data) => callback(data));
  },
  onUserQuestion: (callback) => {
    ipcRenderer.on("assistant:user-question", (_event, data) => callback(data));
  },
  onPermissionCancelled: (callback) => {
    ipcRenderer.on("assistant:permission-cancelled", (_event, data) => callback(data));
  },
  onHookRequest: (callback) => {
    ipcRenderer.on("assistant:hook-request", (_event, data) => callback(data));
  },
  onHookResolved: (callback) => {
    ipcRenderer.on("assistant:hook-resolved", (_event, data) => callback(data));
  },
  onEngineNotice: (callback) => {
    ipcRenderer.on("assistant:engine-notice", (_event, data) => callback(data));
  },
  onPromptSuggestions: (callback) => {
    ipcRenderer.on("assistant:prompt-suggestions", (_event, data) => callback(data));
  },
  onTurnState: (callback) => {
    ipcRenderer.on("assistant:turn-state", (_event, data) => callback(data));
  },
  onAutoRecover: (callback) => {
    ipcRenderer.on("assistant:auto-recover", (_event, data) => callback(data));
  },
  onSessionEvents: (callback) => {
    ipcRenderer.on("assistant:session-events", (_event, data) => callback(data));
  },
  onQueueState: (callback) => {
    ipcRenderer.on("assistant:queue-state", (_event, data) => callback(data));
  },
  onQueueDispatchFailed: (callback) => {
    ipcRenderer.on("assistant:queue-dispatch-failed", (_event, data) => callback(data));
  },
  onUpdateState: (callback) => {
    ipcRenderer.on("updates:state", (_event, data) => callback(data));
  },
  onFocusSession: (callback) => {
    ipcRenderer.on("assistant:focus-session", (_event, data) => callback(data));
  },
  onFileDiff: (callback) => {
    ipcRenderer.on("assistant:file-diff", (_event, data) => callback(data));
  },
});
