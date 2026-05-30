"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");
const { userDataPath, agentBinDir, agentConfigDir } = require("./config");
const { LEGACY_TO_LILY } = require("./agent-env");

const LEGACY_BIN_DIR = "claude-bin";
const LEGACY_CONFIG_DIR = "claude-config";
const LEGACY_SKILL_ID = "claude-vision";
const CURRENT_SKILL_ID = "lily-vision";

/** Previous Electron userData folder names (package / product renames). */
const LEGACY_USER_DATA_DIR_NAMES = ["terminal-chat-claude", "智能工作台"];

const APP_DATA_FILES = [
  "projects.json",
  "sessions.json",
  "workspaces.json",
  "mcp-active.json",
  "model-settings.json",
  "skills-state.json",
  "permission-settings.json",
];

const APP_DATA_DIRS = [
  "claude-bin",
  "lily-bin",
  "claude-config",
  "lily-config",
  "file-staging",
  "runtime-bin",
  "skills-cache",
  "skills-backup",
];

function legacyUserDataRoots() {
  const currentRoot = app.getPath("userData");
  const parent = path.dirname(currentRoot);
  return LEGACY_USER_DATA_DIR_NAMES.map((name) => path.join(parent, name)).filter(
    (root) => root !== currentRoot && fs.existsSync(root),
  );
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function shouldPreferLegacyJson(fileName, destPath, srcPath) {
  if (!fs.existsSync(srcPath)) return false;
  if (!fs.existsSync(destPath)) return true;

  const dest = readJsonSafe(destPath);
  const src = readJsonSafe(srcPath);
  if (!src) return false;
  if (!dest) return true;

  // Once projects/sessions exist locally (even empty), user state wins — do not
  // restore from a legacy userData folder after the user removed all workspaces.
  if (fileName === "projects.json" || fileName === "sessions.json") {
    return false;
  }
  if (fileName === "skills-state.json") {
    const destSkills = dest.skills && typeof dest.skills === "object" ? dest.skills : {};
    const srcSkills = src.skills && typeof src.skills === "object" ? src.skills : {};
    return Object.keys(srcSkills).length > Object.keys(destSkills).length;
  }

  return false;
}

function copyFileIfNeeded(src, dest, fileName) {
  if (!fs.existsSync(src)) return false;
  if (fs.existsSync(dest) && !shouldPreferLegacyJson(fileName, dest, src)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return true;
}

function mergeDirectory(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      mergeDirectory(src, dest);
    } else if (!fs.existsSync(dest)) {
      fs.copyFileSync(src, dest);
    }
  }
}

/**
 * Copy projects/sessions/config from pre-rename userData roots (e.g. terminal-chat-claude).
 */
function migrateLegacyUserDataRoot() {
  const currentRoot = app.getPath("userData");
  for (const legacyRoot of legacyUserDataRoots()) {
    let copied = false;
    for (const file of APP_DATA_FILES) {
      if (copyFileIfNeeded(path.join(legacyRoot, file), path.join(currentRoot, file), file)) {
        copied = true;
      }
    }
    for (const dir of APP_DATA_DIRS) {
      const before = fs.existsSync(path.join(currentRoot, dir));
      mergeDirectory(path.join(legacyRoot, dir), path.join(currentRoot, dir));
      if (!before && fs.existsSync(path.join(currentRoot, dir))) copied = true;
    }
    if (copied) {
      console.info(`[data-migration] restored user data from ${legacyRoot}`);
    }
  }
}

function renameDirIfNeeded(fromName, toName) {
  const from = userDataPath(fromName);
  const to = userDataPath(toName);
  if (from === to) return;
  if (!fs.existsSync(from)) return;
  if (fs.existsSync(to)) {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const src = path.join(from, entry.name);
      const dst = path.join(to, entry.name);
      if (entry.isDirectory()) {
        if (!fs.existsSync(dst)) fs.renameSync(src, dst);
      } else if (!fs.existsSync(dst)) {
        fs.renameSync(src, dst);
      }
    }
    try {
      fs.rmSync(from, { recursive: true, force: true });
    } catch {
      // ignore
    }
    return;
  }
  fs.renameSync(from, to);
}

function migrateSettingsEnvKeys() {
  const settingsPath = path.join(agentConfigDir(), "settings.json");
  if (!fs.existsSync(settingsPath)) return;

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {
    return;
  }
  if (!raw?.env || typeof raw.env !== "object") return;

  let changed = false;
  const env = { ...raw.env };
  for (const [legacyKey, lilyKey] of Object.entries(LEGACY_TO_LILY)) {
    if (env[legacyKey] != null && env[legacyKey] !== "" && env[lilyKey] == null) {
      env[lilyKey] = env[legacyKey];
      changed = true;
    }
    if (legacyKey in env) {
      delete env[legacyKey];
      changed = true;
    }
  }
  if (!changed) return;

  raw.env = env;
  fs.writeFileSync(settingsPath, JSON.stringify(raw, null, 2), "utf8");
}

function migrateSkillsState() {
  const statePath = userDataPath("skills-state.json");
  if (!fs.existsSync(statePath)) return;

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return;
  }
  if (!raw?.skills || typeof raw.skills !== "object") return;

  const entry = raw.skills[LEGACY_SKILL_ID];
  if (!entry) return;

  if (!raw.skills[CURRENT_SKILL_ID]) {
    raw.skills[CURRENT_SKILL_ID] = { ...entry, id: CURRENT_SKILL_ID };
  }
  delete raw.skills[LEGACY_SKILL_ID];
  fs.writeFileSync(statePath, JSON.stringify(raw, null, 2), "utf8");
}

function migrateInstalledSkillDir() {
  const configDir = agentConfigDir();
  const from = path.join(configDir, "skills", LEGACY_SKILL_ID);
  const to = path.join(configDir, "skills", CURRENT_SKILL_ID);
  if (!fs.existsSync(from)) return;
  if (fs.existsSync(to)) {
    try {
      fs.rmSync(from, { recursive: true, force: true });
    } catch {
      // ignore
    }
    return;
  }
  fs.renameSync(from, to);
}

function migrateSessionsResumeId() {
  const sessionsPath = userDataPath("sessions.json");
  if (!fs.existsSync(sessionsPath)) return;

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));
  } catch {
    return;
  }
  const sessions = raw?.sessions;
  if (!Array.isArray(sessions)) return;

  let changed = false;
  for (const session of sessions) {
    if (session.claudeSessionId && !session.agentResumeId) {
      session.agentResumeId = session.claudeSessionId;
      delete session.claudeSessionId;
      changed = true;
    }
  }
  if (!changed) return;
  fs.writeFileSync(sessionsPath, JSON.stringify(raw, null, 2), "utf8");
}

function migrateLegacyGuideFile() {
  const configDir = agentConfigDir();
  const legacyGuide = path.join(configDir, "CLAUDE.md");
  const agentGuide = path.join(configDir, "AGENT.md");
  if (!fs.existsSync(legacyGuide)) return;
  if (!fs.existsSync(agentGuide)) {
    fs.renameSync(legacyGuide, agentGuide);
    return;
  }
  try {
    fs.unlinkSync(legacyGuide);
  } catch {
    // ignore
  }
}

/**
 * One-time migrations for renamed dirs, skills, and persisted fields.
 * Safe to call on every startup.
 */
function runDataMigrations() {
  migrateLegacyUserDataRoot();
  renameDirIfNeeded(LEGACY_BIN_DIR, path.basename(agentBinDir()));
  renameDirIfNeeded(LEGACY_CONFIG_DIR, path.basename(agentConfigDir()));
  migrateInstalledSkillDir();
  migrateSkillsState();
  migrateSessionsResumeId();
  migrateSettingsEnvKeys();
  migrateLegacyGuideFile();
}

module.exports = {
  runDataMigrations,
  migrateSettingsEnvKeys,
  migrateLegacyGuideFile,
  shouldPreferLegacyJson,
};
