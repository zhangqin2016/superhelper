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

module.exports = { resolveAgentCommand, resolveSystemAgent };
