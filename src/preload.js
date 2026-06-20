"use strict";

const { contextBridge, ipcRenderer, webUtils } = require("electron");

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
  getRuntimeSnapshot: (sessionId) =>
    ipcRenderer.invoke("assistant:runtime-snapshot", { sessionId }),
  interrupt: (sessionId) => ipcRenderer.invoke("assistant:interrupt", { sessionId }),
  cancelQueuedMessage: (sessionId, itemId) =>
    ipcRenderer.invoke("assistant:cancel-queued-message", { sessionId, itemId }),

  listScheduledTasks: (filter) => ipcRenderer.invoke("scheduled-tasks:list", filter || {}),
  parseScheduledTaskDraft: (payload) => ipcRenderer.invoke("scheduled-tasks:parse-draft", payload || {}),
  createScheduledTask: (payload) => ipcRenderer.invoke("scheduled-tasks:create", payload || {}),
  createScheduledTaskFromDraftMessage: (payload) =>
    ipcRenderer.invoke("scheduled-tasks:create-from-draft-message", payload || {}),
  setScheduledTaskEnabled: (taskId, enabled) =>
    ipcRenderer.invoke("scheduled-tasks:set-enabled", { taskId, enabled }),
  removeScheduledTask: (taskId) => ipcRenderer.invoke("scheduled-tasks:remove", { taskId }),
  runScheduledTaskNow: (taskId) => ipcRenderer.invoke("scheduled-tasks:run-now", { taskId }),

  getFullState: () => ipcRenderer.invoke("state:full"),

  listModels: () => ipcRenderer.invoke("models:list"),
  setActiveModel: (presetId) => ipcRenderer.invoke("models:set-active", presetId),
  saveCustomModel: (payload) => ipcRenderer.invoke("models:save-custom", payload),
  deleteCustomModel: (presetId) => ipcRenderer.invoke("models:delete-custom", presetId),
  setModelApiGateway: (payload) => ipcRenderer.invoke("models:set-api-gateway", payload),

  listEngines: () => ipcRenderer.invoke("engine:list"),
  setActiveEngine: (engineId) => ipcRenderer.invoke("engine:set-active", engineId),

  listPermissions: () => ipcRenderer.invoke("permissions:list"),
  setActivePermission: (modeId) => ipcRenderer.invoke("permissions:set-active", modeId),

  listSearchSettings: () => ipcRenderer.invoke("search:list"),
  setSearchProvider: (providerId) => ipcRenderer.invoke("search:set-provider", providerId),
  setSearxngUrl: (url) => ipcRenderer.invoke("search:set-searxng-url", url),

  listConnectors: () => ipcRenderer.invoke("connectors:list-playbooks"),
  saveConnectorPlaybook: (payload) => ipcRenderer.invoke("connectors:save-playbook", payload),
  removeConnectorPlaybook: (id) => ipcRenderer.invoke("connectors:remove-playbook", id),
  listMailAccounts: () => ipcRenderer.invoke("mail-accounts:list"),
  autodiscoverMailAccount: (email) => ipcRenderer.invoke("mail-accounts:autodiscover", email),
  saveMailAccount: (payload) => ipcRenderer.invoke("mail-accounts:save", payload),
  removeMailAccount: (id) => ipcRenderer.invoke("mail-accounts:remove", id),
  testMailAccount: (id) => ipcRenderer.invoke("mail-accounts:test", id),
  authorizeMailAccount: (id) => ipcRenderer.invoke("mail-accounts:oauth-start", id),
  searchMailAccount: (payload) => ipcRenderer.invoke("mail-accounts:search", payload),
  readMailAccountMessage: (payload) => ipcRenderer.invoke("mail-accounts:read", payload),
  sendMailAccount: (payload) => ipcRenderer.invoke("mail-accounts:send", payload),

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
  applySkillPreset: (id) => ipcRenderer.invoke("skills:apply-preset", { id }),
  getSkillPresetGuide: () => ipcRenderer.invoke("skills:get-preset-guide"),
  setSkillPresetGuideStatus: (status) =>
    ipcRenderer.invoke("skills:set-preset-guide-status", { status }),

  listProjects: () => ipcRenderer.invoke("project:list"),
  addProject: () => ipcRenderer.invoke("project:add"),
  switchProject: (projectId) => ipcRenderer.invoke("project:switch", projectId),
  renameProject: (projectId, name) => ipcRenderer.invoke("project:rename", projectId, name),
  pinProject: (projectId) => ipcRenderer.invoke("project:pin", projectId),
  openProject: (projectId) => ipcRenderer.invoke("project:open", projectId),
  removeProject: (projectId) => ipcRenderer.invoke("project:remove", projectId),
  exportPackPreview: (projectId) => ipcRenderer.invoke("project:export-preview", projectId),
  exportPack: (projectId, options = {}) => ipcRenderer.invoke("project:export-pack", projectId, options),
  importPack: () => ipcRenderer.invoke("project:import-pack"),

  listSessions: () => ipcRenderer.invoke("session:list"),
  createSession: (title, projectId) => ipcRenderer.invoke("session:create", title, projectId),
  switchSession: (sessionId) => ipcRenderer.invoke("session:switch", sessionId),
  getSessionConversation: (sessionId, options = {}) =>
    ipcRenderer.invoke("session:get-conversation", { sessionId, ...options }),
  renameSession: (sessionId, title) => ipcRenderer.invoke("session:rename", sessionId, title),
  deleteSession: (sessionId) => ipcRenderer.invoke("session:delete", sessionId),
  archiveSession: (sessionId) => ipcRenderer.invoke("session:archive", sessionId),
  getSessionPermission: (sessionId) => ipcRenderer.invoke("session:get-permission", sessionId),
  setSessionPermission: (sessionId, modeId) =>
    ipcRenderer.invoke("session:set-permission", { sessionId, modeId }),

  pickFiles: () => ipcRenderer.invoke("files:pick"),
  getPathForFile: (file) => {
    try {
      return webUtils?.getPathForFile?.(file) || file?.path || "";
    } catch {
      return "";
    }
  },
  stageFile: (filePath, fileName) => ipcRenderer.invoke("files:stage", filePath, fileName),
  pasteFile: (buffer, fileName) => ipcRenderer.invoke("files:paste", buffer, fileName),
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
  listWorkspaceApps: () => ipcRenderer.invoke("apps:catalog"),
  installWorkspaceApp: (app) => ipcRenderer.invoke("apps:install", app),
  openInstalledWorkspaceApp: (appId) => ipcRenderer.invoke("apps:open-installed", { id: appId }),
  uninstallWorkspaceApp: (appId) => ipcRenderer.invoke("apps:uninstall", { id: appId }),

  getUpdateSettings: () => ipcRenderer.invoke("updates:get-settings"),
  getUpdateState: () => ipcRenderer.invoke("updates:get-state"),
  getUsageSummary: () => ipcRenderer.invoke("usage:get-summary"),
  checkForUpdates: () => ipcRenderer.invoke("updates:check"),
  kickUpdateCheck: () => ipcRenderer.invoke("updates:kick-check"),
  downloadUpdate: () => ipcRenderer.invoke("updates:download"),
  installUpdate: (options) => ipcRenderer.invoke("updates:install", options || {}),
  openUpdateDownload: (url) => ipcRenderer.invoke("updates:open-download", { url }),

  submitFeedback: (payload) => ipcRenderer.invoke("support:submit-feedback", payload),
  submitContact: (payload) => ipcRenderer.invoke("support:submit-contact", payload),

  listDirectory: (dirPath) => ipcRenderer.invoke("filetree:list-dir", { dirPath }),
  acceptChange: (sessionId, filePath) =>
    ipcRenderer.invoke("filetree:accept-change", { sessionId, filePath }),
  rejectChange: (sessionId, filePath, content, status) =>
    ipcRenderer.invoke("filetree:reject-change", { sessionId, filePath, content, status }),
  revertTurn: (sessionId, turnId) =>
    ipcRenderer.invoke("filetree:revert-turn", { sessionId, turnId }),
  unrevertTurn: (sessionId, turnId) =>
    ipcRenderer.invoke("filetree:unrevert-turn", { sessionId, turnId }),
  searchFiles: (rootPath, query, limit) =>
    ipcRenderer.invoke("filetree:search-files", { rootPath, query, limit }),
  rememberConvention: (sessionId, text) =>
    ipcRenderer.invoke("assistant:remember-convention", { sessionId, text }),
  revealInFolder: (filePath, sessionId = "") =>
    ipcRenderer.invoke("filetree:reveal", { filePath, sessionId }),

  onRuntimeEvents: (callback) => {
    ipcRenderer.on("assistant:runtime-events", (_event, batch) => callback(batch));
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
  onMigrationProgress: (callback) => {
    ipcRenderer.on("sessions:migration-progress", (_event, data) => callback(data));
  },

});
