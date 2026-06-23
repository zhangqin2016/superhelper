"use strict";

const path = require("node:path");

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

/** User-writable default workspace — never use PROJECT_ROOT in packaged builds (resolves to app.asar). */
function defaultWorkspacePath() {
  const folderName = "Lily Workbench";
  const base = process.platform === "win32" ? resolveBasePath("documents") : resolveBasePath("home");
  return path.join(base, folderName);
}

function userDataPath(...segments) {
  return path.join(resolveBasePath("userData"), ...segments);
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

function legacySessionsBackupPath() {
  return userDataPath("sessions.legacy-backup.json");
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
  isPackaged,
  INSTALLED_CLI_STEM,
  installedCliBasename,
  legacyInstalledCliBasenames,
  PROJECT_ROOT,
  defaultWorkspacePath,
  userDataPath,
  sessionsConfigPath,
  sessionsIndexPath,
  sessionMessagesDir,
  messageDbPath,
  blobStoreDir,
  opencodeSessionsDir,
  opencodeSessionDir,
  opencodeSharedDir,
  opencodeDbPath,
  sessionMessagesImportedDir,
  sessionSummariesDir,
  scheduledTasksPath,
  legacySessionsBackupPath,
  projectsConfigPath,
  mcpConfigPath,
  userHome,
  fileStagingDir,
  agentBinDir,
  agentConfigDir,
  agentGuidePath,
  sessionGuideDir,
};
