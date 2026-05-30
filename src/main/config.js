"use strict";

const { app } = require("electron");
const path = require("node:path");

const INSTALLED_CLI_STEM = "lily-workbench";
const BUNDLED_CLI_STEM = "engine-upstream";

/** Upstream bundle filename in repo / CI artifact (before install rename). */
function bundledCliBasename() {
  return process.platform === "win32"
    ? `${BUNDLED_CLI_STEM}.exe`
    : BUNDLED_CLI_STEM;
}

/** Installed copy under userData; shown in Task Manager / Activity Monitor. */
function installedCliBasename() {
  return process.platform === "win32"
    ? `${INSTALLED_CLI_STEM}.exe`
    : INSTALLED_CLI_STEM;
}

/** Older installed engine binary names to migrate away from. */
function legacyInstalledCliBasenames() {
  const win = [
    "智能工作台.exe",
    "workbench-agent.exe",
    "claude.exe",
  ];
  const unix = ["workbench-agent", "claude"];
  return process.platform === "win32" ? win : unix;
}

/** Older bundled source names (pre-rebrand artifacts). */
function legacyBundledCliBasenames() {
  return process.platform === "win32" ? ["claude.exe"] : ["claude"];
}

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

function userDataPath(...segments) {
  return path.join(app.getPath("userData"), ...segments);
}

function sessionsConfigPath() {
  return userDataPath("sessions.json");
}

function projectsConfigPath() {
  return userDataPath("projects.json");
}

function mcpConfigPath() {
  return userDataPath("mcp-active.json");
}

function userHome() {
  return app.getPath("home");
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
  INSTALLED_CLI_STEM,
  BUNDLED_CLI_STEM,
  bundledCliBasename,
  installedCliBasename,
  legacyInstalledCliBasenames,
  legacyBundledCliBasenames,
  PROJECT_ROOT,
  userDataPath,
  sessionsConfigPath,
  projectsConfigPath,
  mcpConfigPath,
  userHome,
  fileStagingDir,
  agentBinDir,
  agentConfigDir,
  agentGuidePath,
  sessionGuideDir,
};
