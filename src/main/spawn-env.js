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
const {
  discoverHostExecutablePaths,
  platformPathCandidates,
  sanitizeExecutablePathEntries,
} = require("./executable-paths");

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

function utf8Locale(value) {
  return /utf-?8/i.test(String(value || "")) ? String(value) : "C.UTF-8";
}

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || ""));
}

function findDevelopmentPlaywrightNodeModules() {
  try {
    const fs = require("node:fs");
    const { PROJECT_ROOT } = require("./config");
    const bunDir = path.join(PROJECT_ROOT, "opencode", "node_modules", ".bun");
    if (!fs.existsSync(bunDir)) return "";
    const entries = fs.readdirSync(bunDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("playwright@")) continue;
      const nodeModules = path.join(bunDir, entry.name, "node_modules");
      if (fs.existsSync(path.join(nodeModules, "playwright", "package.json"))) return nodeModules;
    }
  } catch {
    return "";
  }
  return "";
}

function buildAgentSpawnEnv(options = {}) {
  ensureRuntimeNodeShim();
  const home = userHome();
  const lilyEnv = options.lilyEnv || resolveLilyEnv();
  const engineEnv = toEngineEnv(lilyEnv);

  const runtimePaths = getRuntimePathEntries();
  const pathSegments = [runtimeBinDir(), ...runtimePaths, agentBinDir()];
  const discoverHostPath = options.discoverHostPath || discoverHostExecutablePaths;
  pathSegments.push(...platformPathCandidates({ home, env: process.env, platform: process.platform }));
  pathSegments.push(...discoverHostPath({ home, env: process.env, platform: process.platform }));
  const devSystem = !app.isPackaged && process.env.DEV_USE_SYSTEM_AGENT === "1";

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
      if (fs.existsSync(nodeModules)) {
        webRuntimeEnv.NODE_PATH = nodeModules;
        webRuntimeEnv.LILY_PLAYWRIGHT_NODE_MODULES = nodeModules;
      }
      const browsers = bundledBrowsersDir(runtimeDir);
      if (fs.existsSync(browsers)) webRuntimeEnv.PLAYWRIGHT_BROWSERS_PATH = browsers;
    }
    if (!webRuntimeEnv.LILY_PLAYWRIGHT_NODE_MODULES && !app.isPackaged) {
      const devNodeModules = findDevelopmentPlaywrightNodeModules();
      if (devNodeModules) {
        webRuntimeEnv.NODE_PATH = devNodeModules;
        webRuntimeEnv.LILY_PLAYWRIGHT_NODE_MODULES = devNodeModules;
      }
    }
  } catch {
    /* browser runtime is optional; never block spawn env on it */
  }

  const executablePath = sanitizeExecutablePathEntries(pathSegments, { platform: process.platform });

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
    // Windows + non-ASCII workspace names: agent tools commonly print generated
    // artifact paths (images/audio/video) and the renderer later uses those exact
    // strings for preview/reveal. Keep every Python/Node/tool subprocess on UTF-8
    // so paths like `交互模块\generated-assets\file.wav` do not round-trip as
    // mojibake (`���...`) through OpenCode's tool output stream.
    LANG: utf8Locale(process.env.LANG),
    LC_ALL: utf8Locale(process.env.LC_ALL || process.env.LANG),
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    PATH: executablePath.join(path.delimiter),
    // Lets agent-run CLIs (e.g. runtime-pack-cli) resolve the same userData
    // dir the main process uses — they run as plain node without electron.
    LILY_USER_DATA_DIR: app.getPath("userData"),
  };

  if (truthy(lilyEnv.LILY_TLS_SKIP_VERIFY)) {
    env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }

  try {
    const fs = require("node:fs");
    const bundledRoots = require("./runtime-packs")
      .bundledPacksRootCandidates()
      .filter((dir) => fs.existsSync(dir));
    if (bundledRoots.length) {
      env.LILY_BUNDLED_RUNTIME_PACK_ROOTS = bundledRoots.join(path.delimiter);
    }
  } catch {
    /* runtime pack root hints are optional */
  }

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
