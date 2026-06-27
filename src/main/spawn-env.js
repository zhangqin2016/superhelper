"use strict";

const path = require("node:path");
const { app } = require("electron");
const { userHome, agentBinDir, agentConfigDir } = require("./config");
const { getActivePresetEnv, getUserApiEnv } = require("./model-presets");
const { getSearchSpawnEnv } = require("./search-settings");
const { getMediaProviderSpawnEnv } = require("./media-provider-settings");
const { normalizeToLilyEnv, toEngineEnv } = require("./agent-env");
const { ensureRuntimeNodeShim, runtimeBinDir } = require("./runtime-node");
const { getRuntimePathEntries, getRuntimeEnvExtras } = require("./runtime-python");
const { pickInheritedEnv } = require("./spawn-env-allowlist");

/**
 * Resolve the distributed model config in LILY_* form (gateway URL / token /
 * model), from the same sources buildAgentSpawnEnv uses. Shared so non-Claude
 * engines (OpenCode) translate the SAME "下发的模型" instead of re-resolving it.
 * @returns {Record<string, string>}
 */
function resolveLilyEnv() {
  const { loadSettingsEnv } = require("./agent-settings");
  return normalizeToLilyEnv({
    ...loadSettingsEnv(),
    ...require("./remote-config").getRemoteRuntimeEnvSync(),
    ...getActivePresetEnv(),
    ...getUserApiEnv(),
  });
}

function buildAgentSpawnEnv(options = {}) {
  ensureRuntimeNodeShim();
  const home = userHome();
  const lilyEnv = resolveLilyEnv();
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

  // Built-in browser runtime (node + playwright + bundled Chromium) for the web
  // learning skill's foreground tools. Gated on the platform bundle actually
  // shipping it → a no-op on builds without it.
  const webRuntimeEnv = {};
  try {
    const fs = require("node:fs");
    const { bundleRuntimeDir } = require("./bundle-locator");
    const { nodeBinaryPath, bundledNodeModulesDir, bundledBrowsersDir } = require("./mcp-config");
    const runtimeDir = bundleRuntimeDir();
    if (runtimeDir) {
      const nodeBin = nodeBinaryPath(runtimeDir);
      if (nodeBin) pathSegments.unshift(path.dirname(nodeBin));
      const nodeModules = bundledNodeModulesDir(runtimeDir);
      if (fs.existsSync(nodeModules)) webRuntimeEnv.NODE_PATH = nodeModules;
      const browsers = bundledBrowsersDir(runtimeDir);
      if (fs.existsSync(browsers)) webRuntimeEnv.PLAYWRIGHT_BROWSERS_PATH = browsers;
    }
  } catch {
    /* browser runtime is optional; never block spawn env on it */
  }

  const env = {
    ...pickInheritedEnv(process.env),
    ...engineEnv,
    ...getSearchSpawnEnv(),
    ...getRuntimeEnvExtras(),
    // After getRuntimeEnvExtras (server-delivered LILY_*_PROVIDER default) so an
    // explicit local user choice wins; emits nothing when set to "auto".
    ...getMediaProviderSpawnEnv(),
    ...require("./connector-bridge").getConnectorBridgeEnvSync(),
    ...webRuntimeEnv,
    TERM: "dumb",
    NO_COLOR: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    PATH: pathSegments.join(path.delimiter),
    // Lets agent-run CLIs (e.g. runtime-pack-cli) resolve the same userData
    // dir the main process uses — they run as plain node without electron.
    LILY_USER_DATA_DIR: app.getPath("userData"),
  };

  if (!devSystem) {
    env.CLAUDE_CONFIG_DIR = options.configDir || agentConfigDir();
  }

  // Skill scripts localize their user-visible output by this (en fallback).
  try {
    env.LILY_LOCALE = require("./locale-settings").getLocale() || "en";
  } catch {
    env.LILY_LOCALE = "en";
  }

  return env;
}

module.exports = { buildAgentSpawnEnv, resolveLilyEnv };
