"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { agentConfigDir, userDataPath } = require("./config");

const AGENT_GUIDE_BASENAME = "AGENT.md";

/** Upstream engine reads this filename inside CLAUDE_CONFIG_DIR — not shown in UI. */
const ENGINE_GUIDE_BASENAME = "CLAUDE.md";

function execQuiet(cmd, args) {
  try {
    const { execFileSync } = require("node:child_process");
    execFileSync(cmd, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Windows: hidden/read-only CLAUDE.md makes copyFileSync fail with EPERM on update. */
function clearMirrorAttributes(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return;
  if (process.platform === "win32") {
    execQuiet("attrib", ["-H", "-R", "-S", filePath]);
    try {
      fs.chmodSync(filePath, 0o666);
    } catch {
      // ignore
    }
    return;
  }
  if (process.platform === "darwin") {
    execQuiet("chflags", ["nohidden", filePath]);
  }
}

function hideFileIfSupported(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return;
  // Windows: +H caused EPERM when updating the mirror on session switch / skill install.
  if (process.platform === "win32") return;
  if (process.platform === "darwin") {
    execQuiet("chflags", ["hidden", filePath]);
  }
}

function writeMirrorContent(mirror, content) {
  const tmp = `${mirror}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, "utf8");
  try {
    fs.renameSync(tmp, mirror);
  } catch {
    try {
      fs.unlinkSync(mirror);
    } catch {
      // ignore
    }
    fs.renameSync(tmp, mirror);
  }
}

/**
 * Mirror AGENT.md → CLAUDE.md for the upstream engine.
 * @returns {boolean} false only when the mirror could not be written
 */
function syncEngineGuideMirror(agentGuideFile, configDir = agentConfigDir()) {
  const mirror = path.join(configDir, ENGINE_GUIDE_BASENAME);
  if (!agentGuideFile || !fs.existsSync(agentGuideFile)) return false;

  try {
    fs.mkdirSync(configDir, { recursive: true });
    clearMirrorAttributes(mirror);

    const content = fs.readFileSync(agentGuideFile, "utf8");
    try {
      fs.writeFileSync(mirror, content, "utf8");
    } catch {
      writeMirrorContent(mirror, content);
    }

    hideFileIfSupported(mirror);
    return true;
  } catch (err) {
    console.error("[agent-guide-mirror]", mirror, err.message);
    return false;
  }
}

function repairGuideDir(configDir) {
  if (!configDir) return false;
  let stat;
  try {
    stat = fs.statSync(configDir);
  } catch {
    return false;
  }
  if (!stat.isDirectory()) return false;

  const agentGuide = path.join(configDir, AGENT_GUIDE_BASENAME);
  if (!fs.existsSync(agentGuide)) return false;

  const mirror = path.join(configDir, ENGINE_GUIDE_BASENAME);
  clearMirrorAttributes(mirror);
  return syncEngineGuideMirror(agentGuide, configDir);
}

/**
 * Fix existing installs: hidden/read-only CLAUDE.md from older builds.
 * Safe on every startup — no user action required.
 */
function repairAllEngineGuideMirrors() {
  let repaired = 0;
  if (repairGuideDir(agentConfigDir())) repaired += 1;

  const guidesRoot = userDataPath("session-guides");
  if (fs.existsSync(guidesRoot)) {
    for (const name of fs.readdirSync(guidesRoot)) {
      const dir = path.join(guidesRoot, name);
      if (repairGuideDir(dir)) repaired += 1;
    }
  }

  if (repaired > 0) {
    console.info(`[agent-guide-mirror] repaired ${repaired} guide mirror(s)`);
  }
  return repaired;
}

module.exports = {
  syncEngineGuideMirror,
  repairGuideDir,
  repairAllEngineGuideMirrors,
  clearMirrorAttributes,
  hideFileIfSupported,
  ENGINE_GUIDE_BASENAME,
  AGENT_GUIDE_BASENAME,
};
