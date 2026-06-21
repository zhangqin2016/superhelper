"use strict";

/**
 * Built-in @playwright/mcp wiring.
 *
 * When the platform runtime bundle ships node + @playwright/mcp + Chromium
 * (see docs/playwright-builtin-plan.md), this module emits the `--mcp-config`
 * file that registers the Playwright MCP server with the Claude CLI, so the
 * model can drive a browser via the accessibility tree.
 *
 * Everything here is gated on the bundle actually being present: if node or the
 * @playwright/mcp entry is missing, every function returns null and the engine
 * spawn adds no `--mcp-config` — a hard no-op until the new bundle ships. That
 * keeps current builds (no bundled browser runtime) completely unaffected.
 *
 * Expected bundle layout under <runtimeDir> (built by build-runtime-bundle.mjs):
 *   node/bin/node            (node binary; node.exe on win32)
 *   web/node_modules/@playwright/mcp/cli.js
 *   web/node_modules/playwright (used by execute_web_playbook.cjs too)
 *   web/browsers/            (PLAYWRIGHT_BROWSERS_PATH — bundled Chromium)
 */

const fs = require("node:fs");
const path = require("node:path");

function nodeBinaryPath(runtimeDir) {
  const exe = process.platform === "win32" ? "node.exe" : "node";
  const candidate = path.join(runtimeDir, "node", "bin", exe);
  // Windows node-build-standalone puts node.exe at the root, not under bin.
  const winRoot = path.join(runtimeDir, "node", exe);
  if (fs.existsSync(candidate)) return candidate;
  if (fs.existsSync(winRoot)) return winRoot;
  return "";
}

function playwrightMcpEntry(runtimeDir) {
  return path.join(runtimeDir, "web", "node_modules", "@playwright", "mcp", "cli.js");
}

function bundledBrowsersDir(runtimeDir) {
  return path.join(runtimeDir, "web", "browsers");
}

function bundledNodeModulesDir(runtimeDir) {
  return path.join(runtimeDir, "web", "node_modules");
}

/** True only when the bundle actually carries node + @playwright/mcp. */
function playwrightMcpAvailable(runtimeDir) {
  if (!runtimeDir) return false;
  return Boolean(nodeBinaryPath(runtimeDir)) && fs.existsSync(playwrightMcpEntry(runtimeDir));
}

/**
 * The Claude CLI `--mcp-config` document, or null when the bundle is absent.
 * @param {string} runtimeDir
 */
function buildPlaywrightMcpConfig(runtimeDir) {
  if (!playwrightMcpAvailable(runtimeDir)) return null;
  const browsers = bundledBrowsersDir(runtimeDir);
  const env = {};
  if (fs.existsSync(browsers)) env.PLAYWRIGHT_BROWSERS_PATH = browsers;
  return {
    mcpServers: {
      playwright: {
        command: nodeBinaryPath(runtimeDir),
        // Bundled Chromium, headless, isolated profile; never reuse credentials
        // from the host — the model logs in interactively when needed.
        args: [playwrightMcpEntry(runtimeDir), "--browser", "chromium", "--headless", "--isolated"],
        env,
      },
    },
  };
}

/**
 * Write the active MCP config to disk and return its path, or null if the
 * bundle is absent (caller then adds no --mcp-config).
 * @param {string} runtimeDir
 * @param {string} outPath
 */

/**
 * The mail connector MCP server entry, or null when the connector bridge isn't
 * running. Launched via the app binary in node mode (ELECTRON_RUN_AS_NODE) so it
 * can require the bundled MCP SDK; it proxies to the bridge for credentials.
 */
function buildMailMcpEntry() {
  let env;
  try {
    env = require("./connector-bridge").getConnectorBridgeEnvSync();
  } catch {
    return null;
  }
  if (!env?.LILY_CONNECTOR_BRIDGE_URL || !env?.LILY_CONNECTOR_BRIDGE_TOKEN) return null;
  return {
    command: process.execPath,
    args: [path.join(__dirname, "mcp", "mail-mcp-stdio.js")],
    env: { ELECTRON_RUN_AS_NODE: "1", ...env },
  };
}

/** MCP server entry for one learned web system (its capabilities as typed tools). */
function webSystemMcpEntry(draftDir) {
  if (
    !draftDir ||
    !fs.existsSync(path.join(draftDir, "capability-map.json")) ||
    !fs.existsSync(path.join(draftDir, "web-system-playbook.json"))
  ) {
    return null;
  }
  return {
    command: process.execPath,
    args: [path.join(__dirname, "mcp", "web-system-mcp-stdio.js"), "--system", draftDir],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
}

function serverNameForSystem(draftDir) {
  const base = path.basename(String(draftDir || "")).replace(/[^a-z0-9]+/gi, "_").toLowerCase();
  return `web_${base || "system"}`.slice(0, 64);
}

/** Installed learned skills that carry a web-system playbook (one per system).
 *  `allowedSkillIds` (when provided) scopes this to the skills ACTIVE for the
 *  current session — a learned workspace skill the user disabled / did not select
 *  must not expose its web-system MCP tools, otherwise the assistant "sees" a
 *  connected system the skills panel shows as off and offers to operate it.
 *  Null (e.g. tests / no session) keeps the old behavior of returning all. */
function learnedWebSystemDirs(allowedSkillIds = null) {
  try {
    const { agentConfigDir } = require("./config");
    const root = path.join(agentConfigDir(), "skills");
    const allow = allowedSkillIds ? new Set(allowedSkillIds) : null;
    return fs
      .readdirSync(root)
      .filter((name) => name.startsWith("learned-"))
      .filter((name) => !allow || allow.has(name))
      .map((name) => path.join(root, name))
      .filter((dir) => fs.existsSync(path.join(dir, "web-system-playbook.json")));
  } catch {
    return [];
  }
}

/** {serverName: entry} for the given learned-system dirs. */
function buildWebSystemMcpEntries(systemDirs) {
  const out = {};
  for (const dir of Array.isArray(systemDirs) ? systemDirs : []) {
    const entry = webSystemMcpEntry(dir);
    if (entry) out[serverNameForSystem(dir)] = entry;
  }
  return out;
}

function writeActiveMcpConfig(runtimeDir, outPath, allowedSkillIds = null) {
  const mcpServers = {};
  const playwright = runtimeDir ? buildPlaywrightMcpConfig(runtimeDir) : null;
  if (playwright?.mcpServers) Object.assign(mcpServers, playwright.mcpServers);
  const mail = buildMailMcpEntry();
  if (mail) mcpServers.mail = mail;
  // Each learned web system becomes its own MCP server (typed tools), but only
  // for the learned skills active in this session — see learnedWebSystemDirs.
  Object.assign(mcpServers, buildWebSystemMcpEntries(learnedWebSystemDirs(allowedSkillIds)));
  if (!Object.keys(mcpServers).length) return null;
  fs.writeFileSync(outPath, `${JSON.stringify({ mcpServers }, null, 2)}\n`);
  return outPath;
}

module.exports = {
  nodeBinaryPath,
  playwrightMcpEntry,
  buildMailMcpEntry,
  bundledBrowsersDir,
  bundledNodeModulesDir,
  playwrightMcpAvailable,
  buildPlaywrightMcpConfig,
  webSystemMcpEntry,
  buildWebSystemMcpEntries,
  learnedWebSystemDirs,
  writeActiveMcpConfig,
};
