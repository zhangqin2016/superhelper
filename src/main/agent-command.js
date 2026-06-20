"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { ensureBundledCliInstalled, installedCliPath } = require("./agent-bootstrap");
const { installedCliBasename } = require("./config");

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function resolveSystemAgent() {
  const bundledName = installedCliBasename();
  const fallbacks = [
    installedCliPath(),
    path.join(os.homedir(), ".local", "bin", bundledName),
    "/opt/homebrew/bin/lily-workbench",
    "/usr/local/bin/lily-workbench",
  ];
  for (const p of fallbacks) {
    if (p && fs.existsSync(p)) return p;
  }

  try {
    if (process.platform === "win32") {
      const result = spawnSync("where", [bundledName], { encoding: "utf8" });
      const resolved = String(result.stdout || "").trim().split(/\r?\n/)[0];
      if (resolved && fs.existsSync(resolved)) return resolved;
    } else {
      const result = spawnSync(
        process.env.SHELL || "/bin/zsh",
        ["-lc", `command -v ${shellQuote(bundledName)}`],
        { encoding: "utf8" },
      );
      const resolved = String(result.stdout || "").trim();
      if (resolved && fs.existsSync(resolved)) return resolved;
    }
  } catch {
    // fall through
  }

  return null;
}

function resolveAgentCommand() {
  const bundled = ensureBundledCliInstalled();
  if (bundled) return bundled;

  if (process.env.DEV_USE_SYSTEM_AGENT === "1") {
    return resolveSystemAgent();
  }

  return null;
}

/**
 * Resolve the OpenCode engine binary, in priority order:
 *   1. OPENCODE_BIN (dev override — e.g. scripts/opencode-dev.sh or a prebuilt path)
 *   2. the bundled binary at bundles/<platform>/opencode/bin/opencode (packaged app)
 * Returns null if none found.
 */
function resolveOpencodeCommand() {
  const fromEnv = process.env.OPENCODE_BIN;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const bundled = require("./bundle-locator").findBundledOpencodeBinary();
  if (bundled) return bundled;
  return null;
}

module.exports = { resolveAgentCommand, resolveSystemAgent, resolveOpencodeCommand };
