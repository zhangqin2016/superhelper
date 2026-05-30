"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { agentConfigDir } = require("./config");

/** Upstream engine reads this filename inside CLAUDE_CONFIG_DIR — not shown in UI. */
const ENGINE_GUIDE_BASENAME = "CLAUDE.md";

function hideFileIfSupported(filePath) {
  if (!fs.existsSync(filePath)) return;
  try {
    const { execFileSync } = require("node:child_process");
    if (process.platform === "win32") {
      execFileSync("attrib", ["+H", filePath], { stdio: "ignore" });
    } else if (process.platform === "darwin") {
      execFileSync("chflags", ["hidden", filePath], { stdio: "ignore" });
    }
  } catch {
    // ignore
  }
}

function syncEngineGuideMirror(agentGuideFile, configDir = agentConfigDir()) {
  const mirror = path.join(configDir, ENGINE_GUIDE_BASENAME);
  if (!fs.existsSync(agentGuideFile)) return;
  fs.copyFileSync(agentGuideFile, mirror);
  hideFileIfSupported(mirror);
}

module.exports = { syncEngineGuideMirror, ENGINE_GUIDE_BASENAME };
