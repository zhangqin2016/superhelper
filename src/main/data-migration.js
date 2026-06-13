"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");
const {
  userDataPath,
  agentBinDir,
  agentConfigDir,
  sessionsIndexPath,
} = require("./config");
const { LEGACY_TO_LILY } = require("./agent-env");

const LEGACY_BIN_DIR = "claude-bin";
const LEGACY_CONFIG_DIR = "claude-config";
const LEGACY_SKILL_ID = "claude-vision";
const CURRENT_SKILL_ID = "lily-vision";

function migrateLegacyCliBinaries() {
  const {
    agentBinDir,
    bundledCliBasename,
    installedCliBasename,
    legacyInstalledCliBasenames,
  } = require("./config");

  const targetName = installedCliBasename();
  const primaryTarget = path.join(agentBinDir(), targetName);
  const binDirs = [agentBinDir(), userDataPath(LEGACY_BIN_DIR)];

  for (const dir of binDirs) {
    if (!fs.existsSync(dir)) continue;

    for (const legacyName of legacyInstalledCliBasenames()) {
      const legacyPath = path.join(dir, legacyName);
      if (!fs.existsSync(legacyPath)) continue;
      if (path.normalize(legacyPath) === path.normalize(primaryTarget)) continue;

      if (!fs.existsSync(primaryTarget)) {
        fs.mkdirSync(path.dirname(primaryTarget), { recursive: true });
        try {
          fs.renameSync(legacyPath, primaryTarget);
          console.info(`[data-migration] renamed ${legacyPath} -> ${primaryTarget}`);
        } catch (err) {
          console.warn(
            `[data-migration] rename legacy cli failed ${legacyPath}:`,
            err?.message || err,
          );
        }
        continue;
      }

      try {
        fs.unlinkSync(legacyPath);
        console.info(`[data-migration] removed legacy cli ${legacyPath}`);
      } catch (err) {
        console.warn(
          `[data-migration] remove legacy cli failed ${legacyPath}:`,
          err?.message || err,
        );
      }
    }

    const strayUpstream = path.join(dir, bundledCliBasename());
    if (
      fs.existsSync(strayUpstream) &&
      path.normalize(strayUpstream) !== path.normalize(primaryTarget)
    ) {
      try {
        fs.unlinkSync(strayUpstream);
        console.info(`[data-migration] removed stray bundle copy ${strayUpstream}`);
      } catch {
        // ignore — may be in use
      }
    }
  }
}

/** Previous Electron userData folder names (package / product renames). */
const LEGACY_USER_DATA_DIR_NAMES = [
  "terminal-chat-claude",
];

const APP_DATA_FILES = [
  "projects.json",
  "sessions.json",
  "sessions-index.json",
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
  "session-guides",
  "session-messages",
  "session-summaries",
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

function writeJsonSafe(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

/** Union workspaces by folder path; current entry wins when paths match. */
function mergeProjectsJson(destData, srcData) {
  const srcProjects = Array.isArray(srcData?.projects) ? srcData.projects : [];
  if (!destData || !Array.isArray(destData.projects)) {
    return {
      merged: {
        activeProjectId:
          srcData?.activeProjectId ?? srcProjects[0]?.id ?? null,
        projects: srcProjects.map((p) => ({ ...p })),
      },
      added: srcProjects.length,
    };
  }

  const byPath = new Map();
  for (const project of destData.projects) {
    if (project?.path) byPath.set(project.path, { ...project });
  }

  let added = 0;
  for (const project of srcProjects) {
    if (!project?.path || byPath.has(project.path)) continue;
    byPath.set(project.path, { ...project });
    added += 1;
  }

  const projects = [...byPath.values()];
  let activeProjectId = destData.activeProjectId ?? null;
  if (activeProjectId && !projects.some((p) => p.id === activeProjectId)) {
    activeProjectId = projects[0]?.id ?? null;
  }

  return { merged: { activeProjectId, projects }, added };
}

function normalizeSessionsStore(raw) {
  if (!raw?.sessions || typeof raw.sessions !== "object") {
    return { activeSessionId: raw?.activeSessionId ?? null, sessions: {} };
  }
  if (Array.isArray(raw.sessions)) {
    return { activeSessionId: raw.activeSessionId ?? null, sessions: {} };
  }
  return {
    activeSessionId: raw.activeSessionId ?? null,
    sessions: { ...raw.sessions },
  };
}

/** Copy legacy sessions for newly merged workspaces; keep current sessions when paths overlap. */
function mergeSessionsJson(destData, srcData, destProjectsBefore, srcProjects) {
  const dest = normalizeSessionsStore(destData);
  const src = normalizeSessionsStore(srcData);
  const currentPathToId = new Map();
  for (const project of destProjectsBefore || []) {
    if (project?.path) currentPathToId.set(project.path, project.id);
  }

  let added = 0;
  for (const project of srcProjects || []) {
    const legacyId = project?.id;
    const legacyList = src.sessions[legacyId];
    if (!legacyId || !Array.isArray(legacyList) || legacyList.length === 0) continue;

    const targetId = currentPathToId.get(project.path) || legacyId;
    if (dest.sessions[targetId]?.length) continue;

    dest.sessions[targetId] = legacyList.map((session) => ({
      ...session,
      projectId: targetId,
    }));
    added += legacyList.length;
  }

  return { merged: dest, added };
}

function mergeSkillsStateJson(destData, srcData) {
  const dest = destData && typeof destData === "object" ? { ...destData } : { skills: {} };
  const src = srcData && typeof srcData === "object" ? srcData : null;
  if (!src?.skills || typeof src.skills !== "object") {
    return { merged: dest, changed: false };
  }

  dest.skills = dest.skills && typeof dest.skills === "object" ? { ...dest.skills } : {};
  let changed = false;
  for (const [id, entry] of Object.entries(src.skills)) {
    if (dest.skills[id]) continue;
    dest.skills[id] = entry;
    changed = true;
  }
  return { merged: dest, changed };
}

function shouldPreferLegacyJson(fileName, destPath, srcPath) {
  if (!fs.existsSync(srcPath)) return false;
  if (!fs.existsSync(destPath)) return true;

  const dest = readJsonSafe(destPath);
  const src = readJsonSafe(srcPath);
  if (!src) return false;
  if (!dest) return true;

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
  const { isShipIgnoredEntry } = require("./ship-ignore");
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (isShipIgnoredEntry(entry.name, entry.isDirectory())) continue;
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      mergeDirectory(src, dest);
    } else if (!fs.existsSync(dest)) {
      fs.copyFileSync(src, dest);
    }
  }
}

function migrateLegacyProjectsAndSessions(legacyRoot, currentRoot) {
  const srcProjectsPath = path.join(legacyRoot, "projects.json");
  const srcProjects = readJsonSafe(srcProjectsPath);
  if (!srcProjects) return false;

  const destProjectsPath = path.join(currentRoot, "projects.json");
  const destProjects = readJsonSafe(destProjectsPath);
  const destProjectsBefore = Array.isArray(destProjects?.projects)
    ? destProjects.projects
    : [];

  const { merged: mergedProjects, added: projectsAdded } = mergeProjectsJson(
    destProjects,
    srcProjects,
  );
  writeJsonSafe(destProjectsPath, mergedProjects);

  const srcSessions = readJsonSafe(path.join(legacyRoot, "sessions.json"));
  const destSessions = readJsonSafe(path.join(currentRoot, "sessions.json"));
  const { merged: mergedSessions, added: sessionsAdded } = mergeSessionsJson(
    destSessions,
    srcSessions,
    destProjectsBefore,
    srcProjects.projects || [],
  );
  writeJsonSafe(path.join(currentRoot, "sessions.json"), mergedSessions);

  return projectsAdded > 0 || sessionsAdded > 0 || !destProjects || !destSessions;
}

function migrateLegacyConfigFiles(legacyRoot, currentRoot) {
  let changed = false;
  for (const file of APP_DATA_FILES) {
    if (file === "projects.json" || file === "sessions.json" || file === "workspaces.json") {
      continue;
    }

    const src = path.join(legacyRoot, file);
    const dest = path.join(currentRoot, file);
    if (file === "skills-state.json" && fs.existsSync(src)) {
      const { merged, changed: skillsChanged } = mergeSkillsStateJson(
        readJsonSafe(dest),
        readJsonSafe(src),
      );
      if (skillsChanged || !fs.existsSync(dest)) {
        writeJsonSafe(dest, merged);
        changed = true;
      }
      continue;
    }

    if (copyFileIfNeeded(src, dest, file)) {
      changed = true;
    }
  }
  return changed;
}

function removeLegacyUserDataRoot(legacyRoot) {
  try {
    fs.rmSync(legacyRoot, { recursive: true, force: true });
    console.info(`[data-migration] removed legacy userData ${legacyRoot}`);
    return true;
  } catch (err) {
    console.warn(
      `[data-migration] failed to remove legacy userData ${legacyRoot}:`,
      err?.message || err,
    );
    return false;
  }
}

/**
 * Merge projects/sessions/config from pre-rename userData roots, then delete the legacy folder.
 */
function migrateLegacyUserDataRoot() {
  const currentRoot = app.getPath("userData");
  for (const legacyRoot of legacyUserDataRoots()) {
    let changed = migrateLegacyProjectsAndSessions(legacyRoot, currentRoot);
    changed = migrateLegacyConfigFiles(legacyRoot, currentRoot) || changed;

    for (const dir of APP_DATA_DIRS) {
      const before = fs.existsSync(path.join(currentRoot, dir));
      mergeDirectory(path.join(legacyRoot, dir), path.join(currentRoot, dir));
      if (!before && fs.existsSync(path.join(currentRoot, dir))) changed = true;
    }

    if (changed) {
      console.info(`[data-migration] migrated user data from ${legacyRoot}`);
    }

    removeLegacyUserDataRoot(legacyRoot);
  }
}

function renameDirIfNeeded(fromName, toName) {
  const from = userDataPath(fromName);
  const to = userDataPath(toName);
  if (from === to) return;
  if (!fs.existsSync(from)) return;
  if (fs.existsSync(to)) {
    const { isShipIgnoredEntry } = require("./ship-ignore");
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (isShipIgnoredEntry(entry.name, entry.isDirectory())) continue;
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

function forEachPersistedSession(raw, fn) {
  const store = raw?.sessions;
  if (!store || typeof store !== "object" || Array.isArray(store)) return;
  for (const list of Object.values(store)) {
    if (!Array.isArray(list)) continue;
    for (const session of list) {
      if (session && typeof session === "object") fn(session);
    }
  }
}

function migrateSessionsResumeId() {
  const sessionsPath = fs.existsSync(sessionsIndexPath())
    ? sessionsIndexPath()
    : userDataPath("sessions.json");
  if (!fs.existsSync(sessionsPath)) return;

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));
  } catch {
    return;
  }

  let changed = false;
  forEachPersistedSession(raw, (session) => {
    if (session.claudeSessionId && !session.agentResumeId) {
      session.agentResumeId = session.claudeSessionId;
      delete session.claudeSessionId;
      changed = true;
    }
  });
  if (!changed) return;
  fs.writeFileSync(sessionsPath, JSON.stringify(raw, null, 2), "utf8");
}

const ENGINE_IDENTITY_FILE = "engine-identity.json";

function bundledEngineFingerprint() {
  try {
    const { findBundledCliSource } = require("./bundle-locator");
    const source = findBundledCliSource();
    if (!source) return null;
    const st = fs.statSync(source);
    return {
      size: st.size,
      mtimeMs: Math.floor(st.mtimeMs),
      appVersion: app.getVersion(),
    };
  } catch {
    return null;
  }
}

/** Drop resume linkage when bundled engine binary or app version changes. */
function migrateEngineSessionCompatibility() {
  const fp = bundledEngineFingerprint();
  if (!fp) return;

  const identityPath = userDataPath(ENGINE_IDENTITY_FILE);
  const prev = fs.existsSync(identityPath) ? readJsonSafe(identityPath) : null;
  const same =
    prev &&
    prev.size === fp.size &&
    prev.mtimeMs === fp.mtimeMs &&
    prev.appVersion === fp.appVersion;
  if (same) return;

  clearAllSessionResumeIds();
  writeJsonSafe(identityPath, fp);
  if (prev) {
    console.info(
      "[data-migration] engine bundle identity changed — cleared session resume state",
    );
  }
}

function clearAllSessionResumeIds() {
  const sessionsPath = fs.existsSync(sessionsIndexPath())
    ? sessionsIndexPath()
    : userDataPath("sessions.json");
  if (!fs.existsSync(sessionsPath)) return 0;

  const raw = readJsonSafe(sessionsPath);
  if (!raw) return 0;

  const { resetSessionEngineCache } = require("./session-engine-recovery");
  let cleared = 0;
  forEachPersistedSession(raw, (session) => {
    if (!session.id) return;
    if (session.agentResumeId || session.claudeSessionId) {
      delete session.agentResumeId;
      delete session.claudeSessionId;
      cleared += 1;
    }
    resetSessionEngineCache(session.id);
  });

  if (cleared > 0) {
    writeJsonSafe(sessionsPath, raw);
    console.info(
      `[data-migration] cleared resume ids for ${cleared} session(s)`,
    );
  }
  return cleared;
}

function migrateLegacyGuideFile() {
  const configDir = agentConfigDir();
  const legacyGuide = path.join(configDir, "CLAUDE.md");
  const agentGuide = path.join(configDir, "AGENT.md");
  if (!fs.existsSync(legacyGuide)) return;
  if (!fs.existsSync(agentGuide)) {
    fs.renameSync(legacyGuide, agentGuide);
  }
  // Both exist: CLAUDE.md is the engine mirror — repaired by repairAllEngineGuideMirrors().
}

/**
 * One-time migrations for renamed dirs, skills, and persisted fields.
 * Safe to call on every startup.
 */
function runDataMigrations() {
  migrateLegacyUserDataRoot();
  renameDirIfNeeded(LEGACY_BIN_DIR, path.basename(agentBinDir()));
  renameDirIfNeeded(LEGACY_CONFIG_DIR, path.basename(agentConfigDir()));
  migrateLegacyCliBinaries();
  migrateEngineSessionCompatibility();
  migrateInstalledSkillDir();
  migrateSkillsState();
  migrateSessionsResumeId();
  migrateSettingsEnvKeys();
  migrateLegacyGuideFile();
  const { repairAllEngineGuideMirrors } = require("./agent-guide-mirror");
  repairAllEngineGuideMirrors();
}

module.exports = {
  runDataMigrations,
  migrateLegacyCliBinaries,
  migrateEngineSessionCompatibility,
  clearAllSessionResumeIds,
  migrateSettingsEnvKeys,
  migrateLegacyGuideFile,
  shouldPreferLegacyJson,
  mergeProjectsJson,
  mergeSessionsJson,
  forEachPersistedSession,
};
