"use strict";

const path = require("node:path");
const { app } = require("electron");
const { userHome, userDataPath, agentConfigDir } = require("./config");
const { getActivePresetEnv } = require("./model-presets");
const { loadSettingsEnv } = require("./agent-settings");
const { ensureRuntimeNodeShim, runtimeBinDir } = require("./runtime-node");

function buildClaudeSpawnEnv() {
  ensureRuntimeNodeShim();
  const home = userHome();
  const env = {
    ...process.env,
    ...loadSettingsEnv(),
    ...getActivePresetEnv(),
    TERM: "dumb",
    NO_COLOR: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    PATH: [
      runtimeBinDir(),
      userDataPath("claude-bin"),
      path.join(home, ".local", "bin"),
      path.join(home, ".npm-global", "bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      process.env.PATH || "",
    ].join(path.delimiter),
  };

  const devSystem =
    !app.isPackaged && process.env.DEV_USE_SYSTEM_CLAUDE === "1";
  if (!devSystem) {
    env.CLAUDE_CONFIG_DIR = agentConfigDir();
  }

  return env;
}

module.exports = { buildClaudeSpawnEnv };
