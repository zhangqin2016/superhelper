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
function writeActiveMcpConfig(runtimeDir, outPath) {
  const config = buildPlaywrightMcpConfig(runtimeDir);
  if (!config) return null;
  fs.writeFileSync(outPath, `${JSON.stringify(config, null, 2)}\n`);
  return outPath;
}

module.exports = {
  nodeBinaryPath,
  playwrightMcpEntry,
  bundledBrowsersDir,
  bundledNodeModulesDir,
  playwrightMcpAvailable,
  buildPlaywrightMcpConfig,
  writeActiveMcpConfig,
};
