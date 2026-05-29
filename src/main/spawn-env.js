"use strict";

const path = require("node:path");
const { app } = require("electron");
const { userHome, agentBinDir, agentConfigDir } = require("./config");
const { getActivePresetEnv } = require("./model-presets");
const { getSearchSpawnEnv } = require("./search-settings");
const { normalizeToLilyEnv, toEngineEnv } = require("./agent-env");
const { ensureRuntimeNodeShim, runtimeBinDir } = require("./runtime-node");

function buildAgentSpawnEnv() {
  ensureRuntimeNodeShim();
  const { loadSettingsEnv } = require("./agent-settings");
  const home = userHome();
  const lilyEnv = normalizeToLilyEnv({
    ...loadSettingsEnv(),
    ...getActivePresetEnv(),
  });
  const engineEnv = toEngineEnv(lilyEnv);

  const env = {
    ...process.env,
    ...engineEnv,
    ...getSearchSpawnEnv(),
    TERM: "dumb",
    NO_COLOR: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    PATH: [
      runtimeBinDir(),
      agentBinDir(),
      path.join(home, ".local", "bin"),
      path.join(home, ".npm-global", "bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      process.env.PATH || "",
    ].join(path.delimiter),
  };

  const devSystem = !app.isPackaged && process.env.DEV_USE_SYSTEM_AGENT === "1";
  if (!devSystem) {
    env.CLAUDE_CONFIG_DIR = agentConfigDir();
  }

  return env;
}

module.exports = { buildAgentSpawnEnv };
