"use strict";

const path = require("node:path");
const fs = require("node:fs");

// Base directories (userData/home/documents) are the ONLY thing config needs
// from the runtime host. Rather than hard-require electron (which coupled all 41
// modules that import config to electron and forced electron mocks in tests and
// env hacks in CLIs), we resolve them lazily, in priority order:
//   1. env override   — agent subprocesses / standalone CLIs / tests
//   2. injected paths  — electron main calls bindRuntimePaths() at startup
//   3. electron app    — defensive fallback if bind wasn't called in-process
//   4. throw           — fail loud rather than silently use a wrong path
// This makes config (and everything that depends on it) usable and testable
// without electron.
const ENV_KEYS = { userData: "LILY_USER_DATA_DIR", home: "LILY_HOME", documents: "LILY_DOCUMENTS_DIR" };
let injectedPaths = null;

/** Electron main injects the host's resolved base dirs once, at startup. */
function bindRuntimePaths(paths = {}) {
  injectedPaths = { ...(injectedPaths || {}), ...paths };
}

function resolveBasePath(name) {
  const envKey = ENV_KEYS[name];
  if (envKey && process.env[envKey]) return process.env[envKey];
  if (injectedPaths && injectedPaths[name]) return injectedPaths[name];
  try {
    const electron = require("electron");
    if (electron && electron.app && typeof electron.app.getPath === "function") {
      return electron.app.getPath(name);
    }
  } catch {
    /* not running under electron */
  }
  throw new Error(
    `config: base path "${name}" is unavailable — call bindRuntimePaths() at startup or set ${envKey || "the host path"}.`,
  );
}

const INSTALLED_CLI_STEM = "lily-workbench";

/** Installed copy under userData; shown in Task Manager / Activity Monitor. */
function installedCliBasename() {
  return process.platform === "win32"
    ? `${INSTALLED_CLI_STEM}.exe`
    : INSTALLED_CLI_STEM;
}

/** Older installed engine binary names to clean up from past installs. */
function legacyInstalledCliBasenames() {
  const win = [
    "智能工作台.exe",
    "workbench-agent.exe",
    "claude.exe",
  ];
  const unix = ["workbench-agent", "claude"];
  return process.platform === "win32" ? win : unix;
}

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_EDITION = "domestic";
const EDITION_CONFIGS = {
  domestic: {
    id: "domestic",
    label: "Domestic",
    serviceApiBaseUrl: "https://lilych.lilywb.cn",
    officialWebsiteUrl: "https://www.lilywb.cn",
    features: {
      account: true,
      billing: true,
    },
  },
  overseas: {
    id: "overseas",
    label: "Overseas",
    serviceApiBaseUrl: "https://lilyxinjiapo.lilywb.cn",
    officialWebsiteUrl: "https://www.lilywb.cn",
    features: {
      account: false,
      billing: false,
    },
  },
};

function normalizeEditionId(value) {
  const id = String(value || "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(EDITION_CONFIGS, id) ? id : DEFAULT_EDITION;
}

function editionFileCandidates() {
  const candidates = [];
  if (process.env.LILY_APP_EDITION_FILE) candidates.push(process.env.LILY_APP_EDITION_FILE);
  candidates.push(path.join(PROJECT_ROOT, "resources", "app-edition.json"));
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, "resources", "app-edition.json"));
  return candidates;
}

function readEditionFile() {
  for (const file of editionFileCandidates()) {
    try {
      if (!file || !fs.existsSync(file)) continue;
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      return {};
    }
  }
  return {};
}

function appEdition() {
  const fileConfig = readEditionFile();
  const id = normalizeEditionId(process.env.LILY_APP_EDITION || fileConfig.id || fileConfig.edition);
  const base = EDITION_CONFIGS[id] || EDITION_CONFIGS[DEFAULT_EDITION];
  return {
    ...base,
    ...fileConfig,
    id,
    features: {
      ...base.features,
      ...(fileConfig.features || {}),
    },
  };
}

/** User-writable default workspace — never use PROJECT_ROOT in packaged builds (resolves to app.asar). */
function defaultWorkspacePath() {
  const folderName = "Lily Workbench";
  const base = process.platform === "win32" ? resolveBasePath("documents") : resolveBasePath("home");
  return path.join(base, folderName);
}

function userDataPath(...segments) {
  return path.join(resolveBasePath("userData"), ...segments);
}

function legacyRuntimePackBaseDir() {
  return userDataPath();
}

function legalKnowledgePackRoot() {
  return userDataPath("legal-kb");
}

function legalKnowledgePackStatePath() {
  return path.join(legalKnowledgePackRoot(), "state.json");
}

function runtimePackRootConfigPath() {
  return userDataPath("runtime-pack-root.json");
}

function runtimePackRootConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(runtimePackRootConfigPath(), "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function configuredRuntimePackBaseDir() {
  if (process.env.LILY_RUNTIME_PACK_ROOT) return process.env.LILY_RUNTIME_PACK_ROOT;
  const root = typeof runtimePackRootConfig().root === "string" ? runtimePackRootConfig().root.trim() : "";
  return root || "";
}

function runtimePackFallbackBaseDirs() {
  const roots = Array.isArray(runtimePackRootConfig().fallbackRoots)
    ? runtimePackRootConfig().fallbackRoots
    : [];
  const seen = new Set();
  return roots
    .map((root) => (typeof root === "string" ? root.trim() : ""))
    .filter(Boolean)
    .map((root) => path.resolve(root))
    .filter((root) => fs.existsSync(root))
    .filter((root) => {
      if (seen.has(root)) return false;
      seen.add(root);
      return true;
    });
}

function runtimePackBaseDir() {
  const configured = configuredRuntimePackBaseDir();
  return path.resolve(configured || legacyRuntimePackBaseDir());
}

function legacyRuntimePackPacksRoot() {
  return path.join(legacyRuntimePackBaseDir(), "runtime-packs");
}

function legacyRuntimePackStatePath() {
  return path.join(legacyRuntimePackBaseDir(), "runtime-packs.json");
}

function runtimePackPacksRoot() {
  return path.join(runtimePackBaseDir(), "runtime-packs");
}

function runtimePackStatePath() {
  return path.join(runtimePackBaseDir(), "runtime-packs.json");
}

function sessionsConfigPath() {
  return userDataPath("sessions.json");
}

function sessionsIndexPath() {
  return userDataPath("sessions-index.json");
}

function sessionMessagesDir() {
  return userDataPath("session-messages");
}

/** SQLite database holding all conversation messages, blob catalog, and FTS index. */
function messageDbPath() {
  return userDataPath("messages.db");
}

/**
 * Dedicated collaboration cache. It must never share a database or recovery
 * path with the AI transcript store: collaboration corruption is recoverable
 * from the server, while messages.db is not owned by collaboration.
 */
function collaborationDbPath() {
  return userDataPath("collaboration.db");
}

/** Private encrypted transfer staging; never use the general blob root. */
function collaborationTransferRoot() {
  return userDataPath("collaboration-transfer");
}

function longTaskDbPath() {
  return userDataPath("long-tasks.db");
}

function longTaskSecretPath() {
  return userDataPath("long-task-scope.key");
}

/** Content-addressed blob store (images / attachments / large payloads). */
function blobStoreDir() {
  return userDataPath("blobs");
}

/** Legacy parent dir for older per-session OpenCode SQLite caches. */
function opencodeSessionsDir() {
  return userDataPath("opencode-sessions");
}

/** Legacy OpenCode engine data dir for one session. Kept for cleanup/migration only. */
function opencodeSessionDir(sessionId) {
  return userDataPath("opencode-sessions", sessionId);
}

/** App-level OpenCode data dir. The shared serve hosts every Lily session. */
function opencodeSharedDir() {
  return userDataPath("opencode-shared");
}

/** App-level OpenCode SQLite path used as OPENCODE_DB for the shared serve. */
function opencodeDbPath() {
  return path.join(opencodeSharedDir(), "opencode.db");
}

/** Where legacy per-session JSON files are moved after a successful import. */
function sessionMessagesImportedDir() {
  return userDataPath("session-messages.imported");
}

function sessionSummariesDir() {
  return userDataPath("session-summaries");
}

function scheduledTasksPath() {
  return userDataPath("scheduled-tasks.json");
}

function scheduledTasksDbPath() {
  return userDataPath("scheduled-tasks.db");
}

function legacySessionsBackupPath() {
  return userDataPath("sessions.legacy-backup.json");
}

function deletedSessionsPath() {
  return userDataPath("deleted-sessions.json");
}

function projectsConfigPath() {
  return userDataPath("projects.json");
}

function mcpConfigPath() {
  return userDataPath("mcp-active.json");
}

function userHome() {
  return resolveBasePath("home");
}

/**
 * App version / packaged flag — the other two things business modules used to
 * reach into electron for. Resolved like paths (env → electron → default) so
 * those modules can depend on config instead of hard-requiring electron.
 */
function appVersion() {
  if (process.env.LILY_APP_VERSION) return process.env.LILY_APP_VERSION;
  try {
    const electron = require("electron");
    if (electron && electron.app && typeof electron.app.getVersion === "function") {
      return electron.app.getVersion();
    }
  } catch {
    /* not under electron */
  }
  return "0.0.0";
}

function isPackaged() {
  if (process.env.LILY_IS_PACKAGED) return process.env.LILY_IS_PACKAGED === "1";
  try {
    const electron = require("electron");
    if (electron && electron.app) return Boolean(electron.app.isPackaged);
  } catch {
    /* not under electron */
  }
  return false;
}

function fileStagingDir() {
  return userDataPath("file-staging");
}

function agentBinDir() {
  return userDataPath("lily-bin");
}

function agentConfigDir() {
  return userDataPath("lily-config");
}

/** Merged global instructions for the engine (also mirrored for upstream compat). */
function agentGuidePath() {
  return path.join(agentConfigDir(), "AGENT.md");
}

/** Per-session engine config (AGENT.md only; skill scripts stay global). */
function sessionGuideDir(sessionId) {
  return userDataPath("session-guides", sessionId);
}

module.exports = {
  bindRuntimePaths,
  appVersion,
  appEdition,
  isPackaged,
  INSTALLED_CLI_STEM,
  installedCliBasename,
  legacyInstalledCliBasenames,
  PROJECT_ROOT,
  defaultWorkspacePath,
  userDataPath,
  legacyRuntimePackBaseDir,
  legalKnowledgePackRoot,
  legalKnowledgePackStatePath,
  legacyRuntimePackPacksRoot,
  legacyRuntimePackStatePath,
  runtimePackBaseDir,
  runtimePackFallbackBaseDirs,
  runtimePackRootConfig,
  runtimePackPacksRoot,
  runtimePackRootConfigPath,
  runtimePackStatePath,
  sessionsConfigPath,
  sessionsIndexPath,
  sessionMessagesDir,
  messageDbPath,
  collaborationDbPath,
  collaborationTransferRoot,
  longTaskDbPath,
  longTaskSecretPath,
  blobStoreDir,
  opencodeSessionsDir,
  opencodeSessionDir,
  opencodeSharedDir,
  opencodeDbPath,
  sessionMessagesImportedDir,
  sessionSummariesDir,
  scheduledTasksPath,
  scheduledTasksDbPath,
  legacySessionsBackupPath,
  deletedSessionsPath,
  projectsConfigPath,
  mcpConfigPath,
  userHome,
  fileStagingDir,
  agentBinDir,
  agentConfigDir,
  agentGuidePath,
  sessionGuideDir,
};
