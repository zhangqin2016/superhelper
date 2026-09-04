"use strict";

const { contextBridge, ipcRenderer, webUtils } = require("electron");

let collaborationStateSubscriberCount = 0;

contextBridge.exposeInMainWorld("assistantClient", {
  getAppIconUrl: () => ipcRenderer.invoke("app:get-icon-url"),
  getAppVersion: () => ipcRenderer.invoke("app:get-version"),
  getAppEdition: () => ipcRenderer.invoke("app:get-edition"),
  getAppPolicy: () => ipcRenderer.invoke("app:get-policy"),
  getLocale: () => ipcRenderer.invoke("app:get-locale"),
  setLocale: (locale) => ipcRenderer.invoke("app:set-locale", locale),
  sendRendererHeartbeat: (payload) => ipcRenderer.send("app:renderer-heartbeat", payload || {}),
  getWatchdogSnapshot: () => ipcRenderer.invoke("app:watchdog-snapshot"),
  sendMessage: (text, files, sessionId, displayFiles, options = null) =>
    ipcRenderer.invoke("assistant:input", {
      text, files, sessionId, displayFiles,
      characterAuthoringKind: options?.characterAuthoringKind,
      characterWorldsAdjustmentHandle: options?.characterWorldsAdjustmentHandle,
      modelSelection: options?.modelSelection,
    }),
  interruptAndSend: (text, files, sessionId, displayFiles, options = null) =>
    ipcRenderer.invoke("assistant:interrupt-and-send", {
      text, files, sessionId, displayFiles,
      characterAuthoringKind: options?.characterAuthoringKind,
      characterWorldsAdjustmentHandle: options?.characterWorldsAdjustmentHandle,
      modelSelection: options?.modelSelection,
    }),
  steerMessage: (text, files, sessionId, displayFiles, options = null) =>
    ipcRenderer.invoke("assistant:steer", {
      text, files, sessionId, displayFiles,
      characterAuthoringKind: options?.characterAuthoringKind,
      characterWorldsAdjustmentHandle: options?.characterWorldsAdjustmentHandle,
      modelSelection: options?.modelSelection,
    }),
  getFeatureFlags: () => ipcRenderer.invoke("assistant:feature-flags"),
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
  getEngineDiagnostics: (sessionId) =>
    ipcRenderer.invoke("assistant:engine-diagnostics", { sessionId }),
  interrupt: (sessionId) => ipcRenderer.invoke("assistant:interrupt", { sessionId }),
  cancelQueuedMessage: (sessionId, itemId) =>
    ipcRenderer.invoke("assistant:cancel-queued-message", { sessionId, itemId }),

  listScheduledTasks: (filter) => ipcRenderer.invoke("scheduled-tasks:list", filter || {}),
  parseScheduledTaskDraft: (payload) => ipcRenderer.invoke("scheduled-tasks:parse-draft", payload || {}),
  createScheduledTask: (payload) => ipcRenderer.invoke("scheduled-tasks:create", payload || {}),
  createScheduledTaskFromDraftMessage: (payload) =>
    ipcRenderer.invoke("scheduled-tasks:create-from-draft-message", payload || {}),
  rejectScheduledTaskDraftMessage: (payload) =>
    ipcRenderer.invoke("scheduled-tasks:reject-draft-message", payload || {}),
  setScheduledTaskEnabled: (taskId, enabled, scope = {}) =>
    ipcRenderer.invoke("scheduled-tasks:set-enabled", { taskId, enabled, sessionId: scope?.sessionId, projectId: scope?.projectId }),
  removeScheduledTask: (taskId, scope = {}) =>
    ipcRenderer.invoke("scheduled-tasks:remove", { taskId, sessionId: scope?.sessionId, projectId: scope?.projectId }),
  runScheduledTaskNow: (taskId, scope = {}) =>
    ipcRenderer.invoke("scheduled-tasks:run-now", { taskId, sessionId: scope?.sessionId, projectId: scope?.projectId }),

  getFullState: () => ipcRenderer.invoke("state:full"),

  listModels: () => ipcRenderer.invoke("models:list"),
  listModelSelection: (sessionId) => ipcRenderer.invoke("models:selection-list", { sessionId }),
  setModelSelection: (selection, sessionId) => ipcRenderer.invoke("models:set-selection", { selection, sessionId }),
  setActiveModel: (presetId) => ipcRenderer.invoke("models:set-active", presetId),
  saveCustomModel: (payload) => ipcRenderer.invoke("models:save-custom", payload),
  updateCustomModel: (presetId, values) => ipcRenderer.invoke("models:update-custom", { presetId, values }),
  deleteCustomModel: (presetId) => ipcRenderer.invoke("models:delete-custom", presetId),
  setModelApiGateway: (payload) => ipcRenderer.invoke("models:set-api-gateway", payload),
  diagnoseAndRestoreDefaultModel: () => ipcRenderer.invoke("models:diagnose-restore-default"),

  listEngines: () => ipcRenderer.invoke("engine:list"),
  setActiveEngine: (engineId) => ipcRenderer.invoke("engine:set-active", engineId),

  listPermissions: () => ipcRenderer.invoke("permissions:list"),
  setActivePermission: (modeId) => ipcRenderer.invoke("permissions:set-active", modeId),

  listSearchSettings: () => ipcRenderer.invoke("search:list"),
  setSearchProvider: (providerId) => ipcRenderer.invoke("search:set-provider", providerId),
  setSearxngUrl: (url) => ipcRenderer.invoke("search:set-searxng-url", url),
  listMediaProviders: () => ipcRenderer.invoke("media-providers:list"),
  setMediaChoice: (payload) => ipcRenderer.invoke("media-providers:set-choice", payload),
  setMediaProviderKey: (payload) => ipcRenderer.invoke("media-providers:set-key", payload),

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
  listWebCredentials: () => ipcRenderer.invoke("web-credentials:list"),
  saveWebCredential: (payload) => ipcRenderer.invoke("web-credentials:save", payload),
  removeWebCredential: (domainOrId) => ipcRenderer.invoke("web-credentials:remove", domainOrId),

  listSkills: () => ipcRenderer.invoke("skills:list"),
  getSessionSkills: (sessionId) => ipcRenderer.invoke("session:get-skills", sessionId),
  rewindSession: (sessionId, turnId, engineMessageId = null) =>
    ipcRenderer.invoke("session:rewind", { sessionId, turnId, engineMessageId }),
  listCommands: (sessionId) => ipcRenderer.invoke("commands:list", sessionId),
  expandCommand: (sessionId, input) => ipcRenderer.invoke("commands:expand", { sessionId, input }),
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
  importWorkspaceSkill: () => ipcRenderer.invoke("skills:import-workspace"),
  applySkillPreset: (id) => ipcRenderer.invoke("skills:apply-preset", { id }),
  getSkillPresetGuide: () => ipcRenderer.invoke("skills:get-preset-guide"),
  setSkillPresetGuideStatus: (status) =>
    ipcRenderer.invoke("skills:set-preset-guide-status", { status }),

  listProjects: () => ipcRenderer.invoke("project:list"),
  addProject: () => ipcRenderer.invoke("project:add"),
  switchProject: (projectId) => ipcRenderer.invoke("project:switch", projectId),
  renameProject: (projectId, name) => ipcRenderer.invoke("project:rename", projectId, name),
  reorderProjects: (projectIds) => ipcRenderer.invoke("project:reorder", projectIds),
  openProject: (projectId) => ipcRenderer.invoke("project:open", projectId),
  removeProject: (projectId) => ipcRenderer.invoke("project:remove", projectId),
  getProjectVersionStatus: (projectId) => ipcRenderer.invoke("project:version-status", projectId),
  getProjectVersionHistory: (projectId, limit = 50) => ipcRenderer.invoke("project:version-history", projectId, limit),
  getProjectVersionPreview: (projectId, revision) => ipcRenderer.invoke("project:version-preview", projectId, revision),
  saveProjectVersion: (projectId) => ipcRenderer.invoke("project:version-save", projectId),
  restoreProjectVersion: (projectId, revision) => ipcRenderer.invoke("project:version-restore", projectId, revision),
  exportPackPreview: (projectId) => ipcRenderer.invoke("project:export-preview", projectId),
  exportPack: (projectId, options = {}) => ipcRenderer.invoke("project:export-pack", projectId, options),
  inspectWorkspacePackage: (filePath) => ipcRenderer.invoke("project:inspect-pack-path", filePath),
  pickWorkspacePackage: () => ipcRenderer.invoke("project:pick-pack"),
  importWorkspacePackagePath: (payload) => ipcRenderer.invoke("project:import-pack-path", payload),

  listSessions: () => ipcRenderer.invoke("session:list"),
  createSession: (title, projectId) => ipcRenderer.invoke("session:create", title, projectId),
  switchSession: (sessionId) => ipcRenderer.invoke("session:switch", sessionId),
  getSessionConversation: (sessionId, options = {}) =>
    ipcRenderer.invoke("session:get-conversation", { sessionId, ...options }),
  renameSession: (sessionId, title) => ipcRenderer.invoke("session:rename", sessionId, title),
  deleteSession: (sessionId) => ipcRenderer.invoke("session:delete", sessionId),
  archiveSession: (sessionId) => ipcRenderer.invoke("session:archive", sessionId),
  agentRuntime: Object.freeze({
    getGraph: (sessionId, graphId) => ipcRenderer.invoke("agent-runtime:graph-get", { sessionId, graphId }),
    cancelTask: (payload) => ipcRenderer.invoke("agent-runtime:task-cancel", payload),
    listCheckpoints: (sessionId, limit = 50) => ipcRenderer.invoke("agent-runtime:checkpoint-list", { sessionId, limit }),
    createCheckpoint: (payload) => ipcRenderer.invoke("agent-runtime:checkpoint-create", payload),
    restoreCheckpoint: (payload) => ipcRenderer.invoke("agent-runtime:checkpoint-restore", payload),
    forkCheckpoint: (payload) => ipcRenderer.invoke("agent-runtime:checkpoint-fork", payload),
    listHooks: (sessionId = "", limit = 100) => ipcRenderer.invoke("agent-runtime:hook-list", { sessionId, limit }),
    upsertHook: (hook) => ipcRenderer.invoke("agent-runtime:hook-upsert", { hook }),
    removeHook: (id) => ipcRenderer.invoke("agent-runtime:hook-remove", { id }),
  }),
  getSessionPermission: (sessionId) => ipcRenderer.invoke("session:get-permission", sessionId),
  setSessionPermission: (sessionId, modeId) =>
    ipcRenderer.invoke("session:set-permission", { sessionId, modeId }),

  // Character Worlds: narrow facade — payloads are whitelisted field-by-field
  // so owner scope, account IDs, and filesystem paths can never ride along
  // (design spec §15). Owner is derived in the main process on every call.
  characterWorlds: Object.freeze({
    getReceiptActions: (sessionId, receiptId) => ipcRenderer.invoke("character-worlds:receipt-actions", { sessionId, receiptId }),
    getReceiptView: (sessionId, receiptId, actionToken) => ipcRenderer.invoke("character-worlds:receipt-view", {
      sessionId, receiptId, actionToken,
    }),
    getPreview: (sessionId) => ipcRenderer.invoke("character-worlds:preview-get", { sessionId }),
    startPreview: (payload) => ipcRenderer.invoke("character-worlds:preview-start", {
      sessionId: payload?.sessionId, receiptId: payload?.receiptId,
      actionToken: payload?.actionToken, expectedPreviewVersion: payload?.expectedPreviewVersion,
    }),
    exitPreview: (sessionId, expectedPreviewVersion) => ipcRenderer.invoke("character-worlds:preview-exit", { sessionId, expectedPreviewVersion }),
    activatePreview: (payload) => ipcRenderer.invoke("character-worlds:preview-activate", {
      sessionId: payload?.sessionId, receiptId: payload?.receiptId,
      actionToken: payload?.actionToken, expectedPreviewVersion: payload?.expectedPreviewVersion,
      expectedBindingVersion: payload?.expectedBindingVersion,
    }),
    activateLibraryItem: (payload = {}) => ipcRenderer.invoke("character-worlds:library-activate", {
      sessionId: payload?.sessionId,
      kind: payload?.kind,
      revisionId: payload?.revisionId,
      action: payload?.action,
      scope: payload?.scope,
      mergeStrategy: payload?.mergeStrategy,
      expectedBindingVersion: payload?.expectedBindingVersion,
    }),
    adjustTarget: (payload) => ipcRenderer.invoke("character-worlds:adjust-target", {
      sessionId: payload?.sessionId, receiptId: payload?.receiptId, actionToken: payload?.actionToken,
    }),
    listCharacters: () => ipcRenderer.invoke("character:list"),
    listOfficialCharacters: () => ipcRenderer.invoke("character:list-official"),
    getOfficialCharacter: (officialId) => ipcRenderer.invoke("character:get-official", { officialId }),
    installOfficialCharacter: (officialId) => ipcRenderer.invoke("character:install-official", { officialId }),
    getCharacter: (characterId) => ipcRenderer.invoke("character:get", { characterId }),
    previewCharacterImport: (options = {}) => (options?.sourcePath
      ? ipcRenderer.invoke("character:import-preview", { sourcePath: options.sourcePath })
      : ipcRenderer.invoke("character:import-preview")),
    commitCharacterImport: (payload = {}) =>
      ipcRenderer.invoke("character:import-commit", {
        previewToken: payload?.previewToken,
        duplicateResolution: payload?.duplicateResolution,
      }),
    exportCharacter: (revisionId) => ipcRenderer.invoke("character:export", { revisionId }),
    getSessionCharacterBinding: (sessionId) =>
      ipcRenderer.invoke("session-character:get-binding", { sessionId }),
    setSessionCharacterBinding: (payload = {}) =>
      ipcRenderer.invoke("session-character:set-binding", {
        sessionId: payload?.sessionId,
        expectedBindingVersion: payload?.expectedBindingVersion,
        mode: payload?.mode,
        characterRevisionId: payload?.characterRevisionId,
        personaRevisionId: payload?.personaRevisionId,
      }),
    getSessionCharacterEvents: (sessionId, options = {}) =>
      ipcRenderer.invoke("session-character:get-events", {
        sessionId,
        afterVersion: options?.afterVersion,
        limit: options?.limit,
      }),
    // Read-only persona inspection (Phase 2B): whitelisted summaries only —
    // the persona narrative description and any mutation surface stay main-side.
    listPersonas: () => ipcRenderer.invoke("persona:list"),
    listOfficialPersonas: () => ipcRenderer.invoke("persona:list-official"),
    getPersona: (personaId) => ipcRenderer.invoke("persona:get", { personaId }),
    getOfficialPersona: (officialId) => ipcRenderer.invoke("persona:get-official", { officialId }),
    installOfficialPersona: (officialId) => ipcRenderer.invoke("persona:install-official", { officialId }),
    // Read-only world-book inspection (Phase 2A): whitelisted summaries only —
    // no raw book content and no mutation surface crosses the bridge.
    listWorldBooks: () => ipcRenderer.invoke("world-book:list"),
    getWorldBook: (worldBookId) => ipcRenderer.invoke("world-book:get", { worldBookId }),
    getWorldBookRevision: (revisionId) => ipcRenderer.invoke("world-book:get-revision", { revisionId }),
    listOfficialWorldBooks: () => ipcRenderer.invoke("world-book:list-official"),
    getOfficialWorldBook: (officialId) => ipcRenderer.invoke("world-book:get-official", { officialId }),
    installOfficialWorldBook: (officialId) => ipcRenderer.invoke("world-book:install-official", { officialId }),
    // Authoring (Phase 2B): guarded mutations on the validated domain API plus
    // revision history/canonical reads for the library editor. Payloads are
    // whitelisted field-by-field; owner scope is derived in main on every call
    // and the rollout policy gate is enforced main-side.
    createCharacter: (payload = {}) =>
      ipcRenderer.invoke("character:create", { canonical: payload?.canonical }),
    updateCharacterRevision: (payload = {}) =>
      ipcRenderer.invoke("character:update-revision", {
        characterId: payload?.characterId,
        expectedBaseRevisionId: payload?.expectedBaseRevisionId,
        canonical: payload?.canonical,
      }),
    restoreCharacterRevision: (payload = {}) =>
      ipcRenderer.invoke("character:restore-revision", {
        characterId: payload?.characterId,
        revisionId: payload?.revisionId,
        expectedBaseRevisionId: payload?.expectedBaseRevisionId,
      }),
    duplicateCharacter: (characterId) => ipcRenderer.invoke("character:duplicate", { characterId }),
    archiveCharacter: (characterId) => ipcRenderer.invoke("character:archive", { characterId }),
    getCharacterRevision: (revisionId) => ipcRenderer.invoke("character:get-revision", { revisionId }),
    getCharacterHistory: (characterId, options = {}) =>
      ipcRenderer.invoke("character:history", { characterId, limit: options?.limit }),
    createPersona: (payload = {}) =>
      ipcRenderer.invoke("persona:create", { canonical: payload?.canonical }),
    updatePersonaRevision: (payload = {}) =>
      ipcRenderer.invoke("persona:update-revision", {
        personaId: payload?.personaId,
        expectedBaseRevisionId: payload?.expectedBaseRevisionId,
        canonical: payload?.canonical,
      }),
    archivePersona: (personaId) => ipcRenderer.invoke("persona:archive", { personaId }),
    getPersonaRevision: (revisionId) => ipcRenderer.invoke("persona:get-revision", { revisionId }),
    getPersonaHistory: (personaId, options = {}) =>
      ipcRenderer.invoke("persona:history", { personaId, limit: options?.limit }),
    createWorldBook: (payload = {}) =>
      ipcRenderer.invoke("world-book:create", { canonical: payload?.canonical }),
    updateWorldBookRevision: (payload = {}) =>
      ipcRenderer.invoke("world-book:update-revision", {
        worldBookId: payload?.worldBookId,
        expectedBaseRevisionId: payload?.expectedBaseRevisionId,
        canonical: payload?.canonical,
      }),
    archiveWorldBook: (worldBookId) => ipcRenderer.invoke("world-book:archive", { worldBookId }),
    getWorldBookHistory: (worldBookId, options = {}) =>
      ipcRenderer.invoke("world-book:history", { worldBookId, limit: options?.limit }),
    getWorldBookAuthoringRevision: (revisionId) =>
      ipcRenderer.invoke("world-book:get-authoring-revision", { revisionId }),
    getScene: (sessionId) => ipcRenderer.invoke("scene:get", { sessionId }),
    getSceneMemory: (sessionId, characterRevisionId) => ipcRenderer.invoke("scene:memory", { sessionId, characterRevisionId }),
    getGreetings: (revisionId) => ipcRenderer.invoke("character:greetings", { revisionId }),
    updateScene: (payload = {}) =>
      ipcRenderer.invoke("scene:update", {
        sessionId: payload?.sessionId,
        participantCharacterRevisionIds: payload?.participantCharacterRevisionIds,
        replyStrategy: payload?.replyStrategy,
        promptMode: payload?.promptMode,
        activeSpeakerRevisionId: payload?.activeSpeakerRevisionId,
      }),
  }),

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
  pasteClipboardFiles: () => ipcRenderer.invoke("files:paste-clipboard"),
  pasteImage: (buffer, fileName) => ipcRenderer.invoke("files:paste", buffer, fileName),
  getFileThumbnail: (fileId) => ipcRenderer.invoke("files:thumbnail", fileId),
  getImageDimensions: (fileId) => ipcRenderer.invoke("files:dimensions", fileId),
  readTextFile: (filePath, options = {}) =>
    ipcRenderer.invoke("files:read-text", { ...(options || {}), filePath }),
  clearStagingCache: () => ipcRenderer.invoke("files:clear-staging"),

  getLicenseStatus: () => ipcRenderer.invoke("license:status"),
  activateLicense: (token) => ipcRenderer.invoke("license:activate", { token }),
  refreshLicense: () => ipcRenderer.invoke("license:refresh"),
  clearLicense: () => ipcRenderer.invoke("license:clear"),

  getAccountStatus: () => ipcRenderer.invoke("account:status"),
  sendAccountSmsCode: (phone) => ipcRenderer.invoke("account:sms-send", { phone }),
  loginAccountWithPassword: (payload) => ipcRenderer.invoke("account:password-login", payload || {}),
  changeAccountPassword: (payload) => ipcRenderer.invoke("account:password-change", payload || {}),
  loginAccountWithSms: (phoneOrPayload, code) => {
    const payload = phoneOrPayload && typeof phoneOrPayload === "object"
      ? phoneOrPayload
      : { phone: phoneOrPayload, code };
    return ipcRenderer.invoke("account:sms-login", payload);
  },
  refreshAccountEntitlements: () => ipcRenderer.invoke("account:entitlements"),
  createAccountBillingLink: () => ipcRenderer.invoke("account:billing-link"),
  logoutAccount: () => ipcRenderer.invoke("account:logout"),
  fetchAccountOrganizations: () => ipcRenderer.invoke("account:organizations"),
  getCurrentOrganizationId: () => ipcRenderer.invoke("account:current-organization"),
  setCurrentOrganizationId: (organizationId) => ipcRenderer.invoke("account:set-current-organization", organizationId),

  getServiceSettings: () => ipcRenderer.invoke("service:get-settings"),
  testServiceConnection: () => ipcRenderer.invoke("service:test-connection"),
  listWorkspaceApps: () => ipcRenderer.invoke("apps:catalog"),
  installWorkspaceApp: (app) => ipcRenderer.invoke("apps:install", app),
  openInstalledWorkspaceApp: (appId) => ipcRenderer.invoke("apps:open-installed", { id: appId }),
  uninstallWorkspaceApp: (appId) => ipcRenderer.invoke("apps:uninstall", { id: appId }),
  listRuntimePacks: () => ipcRenderer.invoke("runtime-packs:list"),
  getRuntimePackLocation: () => ipcRenderer.invoke("runtime-packs:location"),
  chooseRuntimePackLocation: () => ipcRenderer.invoke("runtime-packs:choose-location"),
  resetRuntimePackLocation: () => ipcRenderer.invoke("runtime-packs:reset-location"),
  checkRuntimePackAvailability: (ids = []) => ipcRenderer.invoke("runtime-packs:availability", { ids }),
  checkRuntimePackHealth: (id = "") => ipcRenderer.invoke("runtime-packs:health", id ? { id } : {}),
  preflightRuntimePacks: (payload = {}) => ipcRenderer.invoke("runtime-packs:preflight", payload),
  installRuntimePack: (payload) => ipcRenderer.invoke(
    "runtime-packs:install",
    typeof payload === "object" && payload ? payload : { id: payload },
  ),
  uninstallRuntimePack: (id) => ipcRenderer.invoke("runtime-packs:uninstall", { id }),

  mobilePairingCreateChallenge: () => ipcRenderer.invoke("mobile-pairing:create-challenge"),
  mobilePairingCreateDirectCode: () => ipcRenderer.invoke("mobile-pairing:create-direct-code"),
  mobilePairingPollPending: () => ipcRenderer.invoke("mobile-pairing:poll-pending"),
  mobilePairingListDevices: () => ipcRenderer.invoke("mobile-pairing:list-devices"),
  mobilePairingApprove: (grantId) => ipcRenderer.invoke("mobile-pairing:approve", grantId),
  mobilePairingDeny: (grantId) => ipcRenderer.invoke("mobile-pairing:deny", grantId),
  mobilePairingRevoke: (payload) => ipcRenderer.invoke("mobile-pairing:revoke", payload),
  mobilePairingStatus: () => ipcRenderer.invoke("mobile-pairing:status"),

  voiceDictationStart: () => ipcRenderer.invoke("voice:start"),
  voiceDictationStop: () => ipcRenderer.invoke("voice:stop"),
  voiceDictationAudio: (base64Audio) => ipcRenderer.send("voice:audio", base64Audio),
  onVoiceDictationEvent: (callback) => {
    ipcRenderer.on("voice:event", (_event, payload) => callback(payload));
  },

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
  runSupportDiagnostics: () => ipcRenderer.invoke("support:run-diagnostics"),
  submitDiagnosticsFeedback: (payload) => ipcRenderer.invoke("support:submit-diagnostics-feedback", payload),

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
  listMemory: (sessionId, options = {}) =>
    ipcRenderer.invoke("assistant:memory:list", { sessionId, ...(options || {}) }),
  exportMemory: (sessionId) =>
    ipcRenderer.invoke("assistant:memory:export", { sessionId }),
  setMemoryCategoryEnabled: (sessionId, kind, enabled) =>
    ipcRenderer.invoke("assistant:memory:set-category-enabled", { sessionId, kind, enabled }),
  removeLearnedMemory: (sessionId, key) =>
    ipcRenderer.invoke("assistant:memory:remove-learned", { sessionId, key }),
  clearLearnedMemory: (sessionId) =>
    ipcRenderer.invoke("assistant:memory:clear-learned", { sessionId }),
  listMemoryProposals: (sessionId, options = {}) =>
    ipcRenderer.invoke("assistant:memory-proposals:list", { sessionId, ...(options || {}) }),
  approveMemoryProposal: (sessionId, key) =>
    ipcRenderer.invoke("assistant:memory-proposals:approve", { sessionId, key }),
  dismissMemoryProposal: (sessionId, key) =>
    ipcRenderer.invoke("assistant:memory-proposals:dismiss", { sessionId, key }),
  revealInFolder: (filePath, sessionId = "") =>
    ipcRenderer.invoke("filetree:reveal", { filePath, sessionId }),
  openLocalFile: (filePath, sessionId = "") =>
    ipcRenderer.invoke("filetree:open", { filePath, sessionId }),
  localMediaStatus: (filePath) =>
    ipcRenderer.invoke("files:local-media-status", { filePath }),

  // Intentionally a closed command set. The renderer never receives bearer
  // credentials, device signatures, encrypted key material, or local paths.
  collaboration: {
    getTransfers: () => ipcRenderer.invoke("collaboration:get-transfers"),
    prepareAttachment: (conversationId) => ipcRenderer.invoke("collaboration:prepare-attachment", { conversationId }),
    enqueueTransfer: (transferId) => ipcRenderer.invoke("collaboration:enqueue-transfer", { transferId }),
    pauseTransfer: (transferId) => ipcRenderer.invoke("collaboration:pause-transfer", { transferId }),
    cancelTransfer: (transferId) => ipcRenderer.invoke("collaboration:cancel-transfer", { transferId }),
    prepareDownload: ({ conversationId, messageId, objectId }) => ipcRenderer.invoke("collaboration:prepare-download", { conversationId, messageId, objectId }),
    saveDownload: (transferId) => ipcRenderer.invoke("collaboration:save-download", { transferId }),
    resolveTransferPreview: (transferId) => ipcRenderer.invoke("collaboration:resolve-preview", { transferId }),
    sendAttachments: ({ conversationId, transferIds, bodyText, clientCommandId } = {}) => ipcRenderer.invoke("collaboration:send-attachments", { conversationId, transferIds, bodyText, ...(clientCommandId == null ? {} : { clientCommandId }) }),
    getDirectory: () => ipcRenderer.invoke("collaboration:get-directory"),
    getState: () => ipcRenderer.invoke("collaboration:get-state"),
    bootstrap: () => ipcRenderer.invoke("collaboration:bootstrap"),
    list: () => ipcRenderer.invoke("collaboration:list"),
    open: (conversationId, beforeSeq) => ipcRenderer.invoke("collaboration:open", { conversationId, ...(beforeSeq == null ? {} : { beforeSeq }) }),
    getDraft: (conversationId) => ipcRenderer.invoke("collaboration:get-draft", { conversationId }),
    getEditDraft: ({ conversationId, messageId } = {}) => ipcRenderer.invoke("collaboration:get-edit-draft", { conversationId, messageId }),
    saveEditDraft: ({ conversationId, messageId, bodyText, baseRevision, expectedGeneration } = {}) => ipcRenderer.invoke("collaboration:save-edit-draft", { conversationId, messageId, bodyText, baseRevision, expectedGeneration }),
    clearEditDraft: ({ conversationId, messageId, expectedGeneration } = {}) => ipcRenderer.invoke("collaboration:clear-edit-draft", { conversationId, messageId, expectedGeneration }),
    readMessages: ({ conversationId, messageIds }) => ipcRenderer.invoke("collaboration:read-messages", { conversationId, messageIds }),
    readMessageOperations: ({ conversationId, outboxIds }) => ipcRenderer.invoke("collaboration:read-message-operations", { conversationId, outboxIds }),
    saveDraft: ({ conversationId, text, replyToMessageId, mentionUserIds }) => ipcRenderer.invoke("collaboration:save-draft", { conversationId, text, replyToMessageId, mentionUserIds }),
    send: ({ conversationId, clientCommandId, bodyText, replyToMessageId, mentionUserIds }) => ipcRenderer.invoke("collaboration:send", {
      conversationId, clientCommandId, bodyText, replyToMessageId, mentionUserIds,
    }),
    edit: ({ conversationId, messageId, clientCommandId, expectedRevision, bodyText }) => ipcRenderer.invoke("collaboration:edit", {
      conversationId, messageId, clientCommandId, expectedRevision, bodyText,
    }),
    revoke: ({ conversationId, messageId, clientCommandId, expectedRevision }) => ipcRenderer.invoke("collaboration:revoke", {
      conversationId, messageId, clientCommandId, expectedRevision,
    }),
    friend: (command) => ipcRenderer.invoke("collaboration:friend", command),
    conversation: (command) => ipcRenderer.invoke("collaboration:conversation", command),
    getSocialCommands: () => ipcRenderer.invoke("collaboration:get-social-commands"),
    retrySocial: (clientCommandId) => ipcRenderer.invoke("collaboration:retry-social", { clientCommandId }),
    openFriend: (peerUserId) => ipcRenderer.invoke("collaboration:open-friend", { peerUserId }),
    lookupFriend: (lilyId) => ipcRenderer.invoke("collaboration:lookup-friend", { lilyId }),
    detachWindow: () => ipcRenderer.invoke("collaboration:detach"),
    attachWindow: () => ipcRenderer.invoke("collaboration:attach"),
    windowStatus: () => ipcRenderer.invoke("collaboration:window-status"),
    onWindowState: (handler) => {
      if (typeof handler !== "function") return () => {};
      const listener = (_event, payload) => { try { handler(payload || {}); } catch { /* renderer decides */ } };
      ipcRenderer.on("collaboration:window-state", listener);
      return () => ipcRenderer.removeListener("collaboration:window-state", listener);
    },
    getConversationDetails: (conversationId) => ipcRenderer.invoke("collaboration:get-conversation-details", { conversationId }),
    getMentionCandidates: (conversationId) => ipcRenderer.invoke("collaboration:get-mention-candidates", { conversationId }),
    retry: (outboxId) => ipcRenderer.invoke("collaboration:retry", { outboxId }),
    cancel: (outboxId) => ipcRenderer.invoke("collaboration:cancel", { outboxId }),
    skip: (outboxId) => ipcRenderer.invoke("collaboration:skip", { outboxId }),
    markRead: (conversationId, seq) => ipcRenderer.invoke("collaboration:mark-read", { conversationId, seq }),
    typing: (conversationId) => ipcRenderer.invoke("collaboration:typing", { conversationId }),
    react: ({ conversationId, messageId, clientCommandId, emoji, active } = {}) =>
      ipcRenderer.invoke("collaboration:react", { conversationId, messageId, clientCommandId, emoji, active }),
    onStateChange: (callback) => {
      if (typeof callback !== "function") return () => {};
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on("collaboration:state", handler);
      collaborationStateSubscriberCount += 1;
      if (collaborationStateSubscriberCount === 1) {
        void ipcRenderer.invoke("collaboration:subscribe").then((state) => callback({ type: "initial", state })).catch(() => callback({ type: "initial", state: { ok: false, code: "COLLABORATION_UNAVAILABLE" } }));
      }
      return () => {
        ipcRenderer.removeListener("collaboration:state", handler);
        collaborationStateSubscriberCount = Math.max(0, collaborationStateSubscriberCount - 1);
        if (collaborationStateSubscriberCount === 0) void ipcRenderer.invoke("collaboration:unsubscribe");
      };
    },
  },

  onRuntimeEvents: (callback) => {
    ipcRenderer.on("assistant:runtime-events", (_event, batch) => callback(batch));
  },
  onUpdateState: (callback) => {
    ipcRenderer.on("updates:state", (_event, data) => callback(data));
  },
  onRuntimePackProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("runtime-packs:progress", handler);
    return () => ipcRenderer.removeListener("runtime-packs:progress", handler);
  },
  onFocusSession: (callback) => {
    ipcRenderer.on("assistant:focus-session", (_event, data) => callback(data));
  },
  getNotificationSettings: () => ipcRenderer.invoke("notifications:get"),
  setNotificationSettings: (patch) => ipcRenderer.invoke("notifications:set", patch),
  notifyTaskDone: (payload) => ipcRenderer.invoke("notifications:task-done", payload),
  onFileDiff: (callback) => {
    ipcRenderer.on("assistant:file-diff", (_event, data) => callback(data));
  },
  onMigrationProgress: (callback) => {
    ipcRenderer.on("sessions:migration-progress", (_event, data) => callback(data));
  },
  onStartupHealth: (callback) => {
    ipcRenderer.on("app:startup-health", (_event, data) => callback(data));
  },

});
