"use strict";

const path = require("node:path");
const { app } = require("electron");
const { userHome, agentBinDir, agentConfigDir } = require("./config");
const { getActivePresetEnv, getUserApiEnv } = require("./model-presets");
const { getSearchSpawnEnv } = require("./search-settings");
const { normalizeToLilyEnv, toEngineEnv } = require("./agent-env");
const { ensureRuntimeNodeShim, runtimeBinDir } = require("./runtime-node");
const { getRuntimePathEntries, getRuntimeEnvExtras } = require("./runtime-python");

function buildAgentSpawnEnv(options = {}) {
  ensureRuntimeNodeShim();
  const { loadSettingsEnv } = require("./agent-settings");
  const home = userHome();
  const lilyEnv = normalizeToLilyEnv({
    ...loadSettingsEnv(),
    ...require("./remote-config").getRemoteRuntimeEnvSync(),
    ...getActivePresetEnv(),
    ...getUserApiEnv(),
  });
  const engineEnv = toEngineEnv(lilyEnv);

  const runtimePaths = getRuntimePathEntries();
  const pathSegments = [runtimeBinDir(), ...runtimePaths, agentBinDir()];
  const devSystem = !app.isPackaged && process.env.DEV_USE_SYSTEM_AGENT === "1";
  if (devSystem) {
    pathSegments.push(
      path.join(home, ".local", "bin"),
      path.join(home, ".npm-global", "bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      process.env.PATH || "",
    );
  } else if (process.platform === "win32") {
    const winRoot = process.env.WINDIR || "C:\\Windows";
    pathSegments.push(
      path.join(winRoot, "System32"),
      path.join(winRoot, "System32", "WindowsPowerShell", "v1.0"),
    );
  } else {
    pathSegments.push("/usr/bin", "/bin");
  }

  const env = {
    ...process.env,
    ...engineEnv,
    ...getSearchSpawnEnv(),
    ...getRuntimeEnvExtras(),
    TERM: "dumb",
    NO_COLOR: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    PATH: pathSegments.join(path.delimiter),
  };

  if (!devSystem) {
    env.CLAUDE_CONFIG_DIR = options.configDir || agentConfigDir();
  }

  return env;
}

module.exports = { buildAgentSpawnEnv };
