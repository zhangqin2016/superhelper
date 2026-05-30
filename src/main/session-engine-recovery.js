"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { agentConfigDir, sessionGuideDir } = require("./config");

const ENGINE_ARTIFACT_DIRS = [
  "sessions",
  "backups",
  "projects",
  "tasks",
  "session-env",
  "telemetry",
  "plans",
  "plugins",
  "shell-snapshots",
  "tasks",
];

/**
 * Copy engine resume artifacts from global lily-config into per-session guide dir
 * so --resume still works after switching CLAUDE_CONFIG_DIR.
 */
function migrateGlobalResumeArtifacts(sessionId, resumeId) {
  if (!sessionId || !resumeId) return false;
  const globalRoot = agentConfigDir();
  const targetRoot = sessionGuideDir(sessionId);
  if (!fs.existsSync(globalRoot)) return false;

  let copied = 0;
  const needle = String(resumeId);

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === "skills") continue;
        walk(full);
        continue;
      }
      if (!ent.name.includes(needle) && !full.includes(needle)) continue;
      const rel = path.relative(globalRoot, full);
      if (rel.startsWith("..")) continue;
      const dest = path.join(targetRoot, rel);
      if (fs.existsSync(dest)) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(full, dest);
      copied += 1;
    }
  }

  walk(globalRoot);
  return copied > 0;
}

/** Drop broken resume linkage and local engine cache (keep AGENT.md / CLAUDE.md). */
function resetSessionEngineCache(sessionId) {
  const dir = sessionGuideDir(sessionId);
  if (!fs.existsSync(dir)) return;
  for (const name of ENGINE_ARTIFACT_DIRS) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) {
      fs.rmSync(p, { recursive: true, force: true });
    }
  }
  const claudeJson = path.join(dir, ".claude.json");
  if (fs.existsSync(claudeJson)) {
    fs.rmSync(claudeJson, { force: true });
  }
}

module.exports = {
  migrateGlobalResumeArtifacts,
  resetSessionEngineCache,
};
