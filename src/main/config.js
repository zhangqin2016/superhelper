"use strict";

const { app } = require("electron");
const path = require("node:path");

const DEFAULT_AGENT_COMMAND = process.env.DEFAULT_AGENT_COMMAND || "claude";

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
  return userDataPath("claude-bin");
}

function agentConfigDir() {
  return userDataPath("claude-config");
}

module.exports = {
  DEFAULT_AGENT_COMMAND,
  PROJECT_ROOT,
  userDataPath,
  sessionsConfigPath,
  projectsConfigPath,
  mcpConfigPath,
  userHome,
  fileStagingDir,
  agentBinDir,
  agentConfigDir,
};
