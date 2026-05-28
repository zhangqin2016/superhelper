"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { ensureBundledCliInstalled } = require("./agent-bootstrap");

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function resolveSystemClaude() {
  const name = process.platform === "win32" ? "claude.exe" : "claude";

  const fallbacks = [
    path.join(os.homedir(), ".local", "bin", name),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
  for (const p of fallbacks) {
    if (fs.existsSync(p)) return p;
  }

  try {
    if (process.platform === "win32") {
      const result = spawnSync("where", [name], { encoding: "utf8" });
      const resolved = String(result.stdout || "").trim().split(/\r?\n/)[0];
      if (resolved && fs.existsSync(resolved)) return resolved;
    } else {
      const result = spawnSync(
        process.env.SHELL || "/bin/zsh",
        ["-lc", `command -v ${shellQuote(name)}`],
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

/**
 * Bundled CLI under app userData, optional system CLI in dev, always prefers
 * integrated engine when available.
 */
function resolveAgentCommand() {
  const bundled = ensureBundledCliInstalled();
  if (bundled) return bundled;

  if (process.env.DEV_USE_SYSTEM_CLAUDE === "1") {
    return resolveSystemClaude();
  }

  return null;
}

module.exports = { resolveAgentCommand, resolveSystemClaude };
