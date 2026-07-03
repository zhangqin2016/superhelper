"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { agentConfigDir, sessionGuideDir, opencodeDbPath, opencodeSessionDir } = require("./config");

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

function treeContainsNeedle(root, needle) {
  if (!needle || !root || !fs.existsSync(root)) return false;
  const token = String(needle);

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.name.includes(token) || full.includes(token)) return true;
      if (ent.isDirectory() && walk(full)) return true;
    }
    return false;
  }

  return walk(root);
}

/** True when local engine cache can still resume this session.
 *
 * For the OpenCode engine the resume artifact is the app-level SQLite used by
 * the shared serve. OpenCode session rows/messages are keyed by the `ses_...`
 * id inside that DB. Older builds used per-session DBs, so we also accept the
 * legacy path during migration. A stale/missing id past this point is handled by
 * createSession falling through to a fresh session. */
function hasResumeArtifacts(sessionId, resumeId) {
  if (!resumeId) return false;
  try {
    const db = opencodeDbPath();
    const st = fs.statSync(db);
    if (st.isFile() && st.size > 0) return true;
  } catch {
    // no shared db -> try legacy per-session db below
  }
  try {
    const legacyDb = path.join(opencodeSessionDir(sessionId), "opencode.db");
    const st = fs.statSync(legacyDb);
    if (st.isFile() && st.size > 0) return true;
  } catch {
    // no legacy db -> fall back to the legacy guide-tree scan below
  }
  const sessionRoot = sessionGuideDir(sessionId);
  const globalRoot = agentConfigDir();
  const candidates = [
    path.join(sessionRoot, "sessions"),
    sessionRoot,
    path.join(globalRoot, "sessions"),
    globalRoot,
  ];
  for (const dir of candidates) {
    if (treeContainsNeedle(dir, resumeId)) return true;
  }
  return false;
}

function isResumeFailureMessage(text) {
  return /resume|session.*not found|unknown session|Session ID .* already in use/i.test(
    String(text || ""),
  );
}

/** Drop broken legacy engine cache (keep AGENT.md).
 *
 * Do NOT remove the app-level OpenCode DB here: it is shared by every Lily
 * session. The caller clears this session's `agentResumeId`; OpenCode will create
 * a new session row on the next prompt if the old id is stale. */
function resetSessionEngineCache(sessionId) {
  try {
    fs.rmSync(opencodeSessionDir(sessionId), { recursive: true, force: true });
  } catch {
    // ignore
  }

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
  hasResumeArtifacts,
  isResumeFailureMessage,
  resetSessionEngineCache,
};
