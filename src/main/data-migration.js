"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  userDataPath,
  appVersion,
  agentBinDir,
  agentConfigDir,
  opencodeDbPath,
  sessionsIndexPath,
} = require("./config");
const { LEGACY_TO_LILY } = require("./agent-env");

const LEGACY_BIN_DIR = "claude-bin";
const LEGACY_CONFIG_DIR = "claude-config";
const LEGACY_SKILL_ID = "claude-vision";
const CURRENT_SKILL_ID = "lily-vision";
const RECOVERED_LEGACY_TITLE = "恢复的历史会话";
const ORPHAN_RECOVERY_AUTO_LIMIT = 3;

function migrateLegacyCliBinaries() {
  const {
    agentBinDir,
    installedCliBasename,
    legacyInstalledCliBasenames,
  } = require("./config");
  // Stray un-renamed copies of the old bundled engine binary to delete.
  const strayBundleName = process.platform === "win32" ? "engine-upstream.exe" : "engine-upstream";

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

    const strayUpstream = path.join(dir, strayBundleName);
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
  "Lily Workbench",
  "智能工作台",
  "ai-super-terminal",
  "terminal-chat-claude",
];

const APP_DATA_FILES = [
  "projects.json",
  "sessions.json",
  "sessions-index.json",
  "messages.db",
  "messages.db-wal",
  "messages.db-shm",
  "workspaces.json",
  "mcp-active.json",
  "model-settings.json",
  "skills-state.json",
  "permission-settings.json",
  "deleted-sessions.json",
];

const APP_DATA_DIRS = [
  "claude-bin",
  "lily-bin",
  "claude-config",
  "lily-config",
  "file-staging",
  "opencode-sessions",
  "opencode-shared",
  "runtime-bin",
  "skills-cache",
  "skills-backup",
  "session-guides",
  "session-messages",
  "session-messages.imported",
  "blobs",
  "session-summaries",
];

// A distinctive Lily userData signature: one of our store/config files AND one
// of our private subdirs. The combination is extremely unlikely in a non-Lily
// folder, so a signature scan can find installs under ANY past/unknown product
// name (and in LocalAppData) without a hardcoded name list — and without the
// false-positive risk of matching an unrelated app's folder.
const LEGACY_MARKER_FILES = ["sessions-index.json", "messages.db", "model-settings.json", "projects.json"];
const LEGACY_MARKER_DIRS = ["opencode-sessions", "opencode-shared", "lily-config", "claude-config", "skills-cache"];

function looksLikeLilyUserDataRoot(root) {
  try {
    const hasFile = LEGACY_MARKER_FILES.some((f) => fs.existsSync(path.join(root, f)));
    const hasDir = LEGACY_MARKER_DIRS.some((d) => fs.existsSync(path.join(root, d)));
    return hasFile && hasDir;
  } catch {
    return false;
  }
}

// Parent dirs that can hold an Electron userData root: the current root's parent
// (Roaming %APPDATA% on Windows / Application Support on macOS) plus %APPDATA%
// and %LOCALAPPDATA% when present. Older builds and Squirrel copies land in
// different ones, so we scan them all — but only these known roots, never a
// full-disk crawl (slow + false positives).
function legacyParentDirs() {
  const parents = new Set([path.dirname(path.resolve(userDataPath()))]);
  for (const env of [process.env.APPDATA, process.env.LOCALAPPDATA]) {
    if (env) parents.add(path.resolve(env));
  }
  return [...parents].filter((p) => {
    try { return fs.existsSync(p) && fs.statSync(p).isDirectory(); } catch { return false; }
  });
}

function legacyUserDataRoots() {
  const currentRoot = path.resolve(userDataPath());
  const found = new Map();
  const record = (root) => {
    const key = path.resolve(root);
    if (key === currentRoot || found.has(key)) return;
    if (!fs.existsSync(root)) return;
    found.set(key, root);
  };
  // 1) Known rename names in the current parent — guaranteed ours, fast path.
  const parent = path.dirname(currentRoot);
  for (const name of LEGACY_USER_DATA_DIR_NAMES) record(path.join(parent, name));
  // 2) Name-agnostic signature scan across Roaming + Local parents.
  for (const dir of legacyParentDirs()) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const root = path.join(dir, entry.name);
      if (path.resolve(root) === currentRoot || found.has(path.resolve(root))) continue;
      if (looksLikeLilyUserDataRoot(root)) record(root);
    }
  }
  return [...found.values()];
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

function sessionMessageMergeKey(message) {
  if (message?.id) return `id:${message.id}`;
  return `fp:${JSON.stringify({
    role: message?.role || "assistant",
    content: message?.content || "",
    files: message?.files || null,
    turnId: message?.turnId || message?.record?.turnId || null,
    timestamp: message?.timestamp || null,
    failed: Boolean(message?.failed),
  })}`;
}

function mergeSessionMessages(existingMessages, incomingMessages) {
  const existing = Array.isArray(existingMessages) ? existingMessages : [];
  const incoming = Array.isArray(incomingMessages) ? incomingMessages : [];
  if (incoming.length === 0) return existing;

  const existingCounts = new Map();
  for (const message of existing) {
    const key = sessionMessageMergeKey(message);
    existingCounts.set(key, (existingCounts.get(key) || 0) + 1);
  }
  const incomingCounts = new Map();
  const merged = existing.slice();
  for (const message of incoming) {
    const key = sessionMessageMergeKey(message);
    const seen = (incomingCounts.get(key) || 0) + 1;
    incomingCounts.set(key, seen);
    if ((existingCounts.get(key) || 0) >= seen) continue;
    merged.push(message);
    existingCounts.set(key, (existingCounts.get(key) || 0) + 1);
  }
  return merged;
}

/** Copy legacy sessions into matching workspaces by path, de-duping by session id. */
function mergeSessionsJson(destData, srcData, destProjectsBefore, srcProjects) {
  const dest = normalizeSessionsStore(destData);
  const src = normalizeSessionsStore(srcData);
  const currentPathToId = new Map();
  for (const project of destProjectsBefore || []) {
    if (project?.path) currentPathToId.set(project.path, project.id);
  }

  let added = 0;
  const sourceProjects = Array.isArray(srcProjects) && srcProjects.length
    ? srcProjects
    : Object.keys(src.sessions).map((id) => ({ id }));

  for (const project of sourceProjects) {
    const legacyId = project?.id;
    const legacyList = src.sessions[legacyId];
    if (!legacyId || !Array.isArray(legacyList) || legacyList.length === 0) continue;

    const targetId = currentPathToId.get(project.path) || legacyId;
    if (!dest.sessions[targetId]) dest.sessions[targetId] = [];
    const existingById = new Map(
      dest.sessions[targetId]
        .filter((session) => session?.id)
        .map((session) => [session.id, session]),
    );

    for (const session of legacyList) {
      if (session?.id && existingById.has(session.id)) {
        const existing = existingById.get(session.id);
        const mergedMessages = mergeSessionMessages(existing.messages, session.messages);
        if (mergedMessages.length > (Array.isArray(existing.messages) ? existing.messages.length : 0)) {
          existing.messages = mergedMessages;
          existing.messageCount = Math.max(
            Number.isInteger(existing.messageCount) ? existing.messageCount : 0,
            mergedMessages.length,
            Number.isInteger(session.messageCount) ? session.messageCount : 0,
          );
          added += 1;
        }
        continue;
      }
      const normalizedSession = {
        ...session,
        projectId: targetId,
      };
      dest.sessions[targetId].push(normalizedSession);
      if (session?.id) existingById.set(session.id, normalizedSession);
      added += 1;
    }
  }

  if (!dest.activeSessionId && src.activeSessionId) {
    dest.activeSessionId = src.activeSessionId;
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

function tableExists(db, tableName) {
  try {
    return Boolean(db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", tableName));
  } catch {
    return false;
  }
}

function mergeMessageDatabase(srcPath, destPath) {
  if (!fs.existsSync(srcPath)) return false;
  if (!fs.existsSync(destPath)) return copyFileIfNeeded(srcPath, destPath, "messages.db");

  let srcDb = null;
  let destDb = null;
  try {
    const { openDatabase } = require("./store/sqlite-db");
    const { MIGRATIONS } = require("./store/schema");
    srcDb = openDatabase(srcPath);
    destDb = openDatabase(destPath);
    destDb.migrate(MIGRATIONS);
    if (!tableExists(srcDb, "messages") || !tableExists(destDb, "messages")) return false;

    const rows = srcDb.all(
      `SELECT session_id, id, role, turn_id, created_at, preview, failed,
              terminal, cost_usd, duration_ms, envelope_blob
         FROM messages
        ORDER BY session_id ASC, seq ASC`,
    );
    const copiedSessions = new Set();
    let copied = 0;
    const insert = destDb.transaction(() => {
      for (const row of rows) {
        if (!row?.id || destDb.get("SELECT 1 FROM messages WHERE id = ? LIMIT 1", row.id)) continue;
        const next = destDb.get(
          "SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages WHERE session_id = ?",
          row.session_id,
        )?.seq || 1;
        destDb.run(
          `INSERT INTO messages
             (session_id, seq, id, role, turn_id, created_at, preview, failed,
              terminal, cost_usd, duration_ms, envelope_blob)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          row.session_id,
          next,
          row.id,
          row.role,
          row.turn_id,
          row.created_at,
          row.preview,
          row.failed,
          row.terminal,
          row.cost_usd,
          row.duration_ms,
          row.envelope_blob,
        );
        copiedSessions.add(row.session_id);
        copied += 1;
      }
      for (const sessionId of copiedSessions) {
        destDb.run(
          `INSERT INTO schema_meta (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          `imported:${sessionId}`,
          "done:db-merge",
        );
      }
    });
    insert();
    if (copied > 0) {
      console.info(`[data-migration] merged ${copied} legacy message row(s) from ${srcPath}`);
      return true;
    }
  } catch (err) {
    console.warn("[data-migration] failed to merge legacy messages.db:", err?.message || err);
  } finally {
    try { srcDb?.close?.(); } catch {}
    try { destDb?.close?.(); } catch {}
  }
  return false;
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

  const destProjectsPath = path.join(currentRoot, "projects.json");
  const destProjects = readJsonSafe(destProjectsPath);
  const destProjectsBefore = Array.isArray(destProjects?.projects)
    ? destProjects.projects
    : [];

  let mergedProjects = destProjects;
  let projectsAdded = 0;
  if (srcProjects) {
    const result = mergeProjectsJson(destProjects, srcProjects);
    mergedProjects = result.merged;
    projectsAdded = result.added;
    writeJsonSafe(destProjectsPath, mergedProjects);
  }

  const destSessionPath = fs.existsSync(path.join(currentRoot, "sessions-index.json"))
    ? path.join(currentRoot, "sessions-index.json")
    : path.join(currentRoot, "sessions.json");
  let destSessions = readJsonSafe(destSessionPath);
  let sessionsAdded = 0;
  for (const fileName of ["sessions-index.json", "sessions.json"]) {
    const srcSessions = readJsonSafe(path.join(legacyRoot, fileName));
    if (!srcSessions) continue;
    const { merged: nextSessions, added } = mergeSessionsJson(
      destSessions,
      srcSessions,
      Array.isArray(mergedProjects?.projects) ? mergedProjects.projects : destProjectsBefore,
      srcProjects?.projects || [],
    );
    destSessions = nextSessions;
    sessionsAdded += added;
  }
  if (destSessions) writeJsonSafe(destSessionPath, destSessions);

  return projectsAdded > 0 || sessionsAdded > 0 || (!destProjects && srcProjects);
}

function migrateLegacyConfigFiles(legacyRoot, currentRoot) {
  let changed = false;
  for (const file of APP_DATA_FILES) {
    if (
      file === "projects.json" ||
      file === "sessions.json" ||
      file === "sessions-index.json" ||
      file === "workspaces.json"
    ) {
      continue;
    }

    const src = path.join(legacyRoot, file);
    const dest = path.join(currentRoot, file);
    if (file === "messages.db") {
      if (mergeMessageDatabase(src, dest)) changed = true;
      continue;
    }
    if (file === "messages.db-wal" || file === "messages.db-shm") {
      if (!fs.existsSync(path.join(currentRoot, "messages.db")) && copyFileIfNeeded(src, dest, file)) {
        changed = true;
      }
      continue;
    }
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

function archiveLegacyUserDataRoot(legacyRoot) {
  const backupRoot = `${legacyRoot}.migrated-backup`;
  try {
    if (fs.existsSync(backupRoot)) {
      const stamped = `${backupRoot}.${Date.now()}`;
      fs.renameSync(legacyRoot, stamped);
      console.info(`[data-migration] archived legacy userData ${legacyRoot} -> ${stamped}`);
      return true;
    }
    fs.renameSync(legacyRoot, backupRoot);
    console.info(`[data-migration] archived legacy userData ${legacyRoot} -> ${backupRoot}`);
    return true;
  } catch (err) {
    console.warn(
      `[data-migration] failed to archive legacy userData ${legacyRoot}:`,
      err?.message || err,
    );
    return false;
  }
}

function existingSessionIds(sessionStore) {
  const ids = new Set();
  const sessions = sessionStore?.sessions;
  if (!sessions || typeof sessions !== "object" || Array.isArray(sessions)) return ids;
  for (const list of Object.values(sessions)) {
    if (!Array.isArray(list)) continue;
    for (const session of list) {
      if (session?.id) ids.add(session.id);
    }
  }
  return ids;
}

function deletedSessionIds(root) {
  const raw = readJsonSafe(path.join(root, "deleted-sessions.json"));
  const sessions = raw?.sessions;
  if (!sessions || typeof sessions !== "object" || Array.isArray(sessions)) return new Set();
  return new Set(Object.keys(sessions).filter(Boolean));
}

function messageFileSessionIds(dir) {
  try {
    return fs.readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => ({
        id: name.slice(0, -".json".length),
        filePath: path.join(dir, name),
      }))
      .filter((entry) => entry.id);
  } catch {
    return [];
  }
}

function legacyMessageCount(filePath) {
  const raw = readJsonSafe(filePath);
  const messages = Array.isArray(raw?.messages) ? raw.messages : Array.isArray(raw) ? raw : [];
  return messages.filter((message) => message && typeof message === "object").length;
}

function recoveryManifestPath(root) {
  return path.join(root, "legacy-message-recovery.json");
}

function writeRecoveryManifest(root, payload) {
  const existing = readJsonSafe(recoveryManifestPath(root));
  writeJsonSafe(recoveryManifestPath(root), {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    ...(existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {}),
    ...payload,
  });
}

function isSyntheticRecoveredSession(session) {
  if (!session || typeof session !== "object") return false;
  return Boolean(session.recoveredFromLegacyMessages) || session.title === RECOVERED_LEGACY_TITLE;
}

function sessionTime(session) {
  const ts = Date.parse(session?.updatedAt || session?.createdAt || "");
  return Number.isFinite(ts) ? ts : 0;
}

function pruneRecoveredLegacySessionFlood(sessionStore, currentRoot) {
  let archived = 0;
  const archivedSessions = [];
  const archivedIds = new Set();
  const sessionsByProject = sessionStore?.sessions;
  if (!sessionsByProject || typeof sessionsByProject !== "object" || Array.isArray(sessionsByProject)) {
    return { archived, archivedSessions };
  }

  for (const [projectId, list] of Object.entries(sessionsByProject)) {
    if (!Array.isArray(list)) continue;
    const visibleRecovered = list
      .filter((session) => isSyntheticRecoveredSession(session) && session.status !== "archived")
      .sort((a, b) => sessionTime(b) - sessionTime(a));
    if (visibleRecovered.length <= ORPHAN_RECOVERY_AUTO_LIMIT) continue;

    for (const session of visibleRecovered.slice(ORPHAN_RECOVERY_AUTO_LIMIT)) {
      session.status = "archived";
      session.archivedAt = session.archivedAt || new Date().toISOString();
      session.recoveryArchivedByMigration = true;
      archived += 1;
      archivedIds.add(session.id);
      archivedSessions.push({
        id: session.id,
        projectId,
        title: session.title || RECOVERED_LEGACY_TITLE,
        messageCount: Number.isInteger(session.messageCount) ? session.messageCount : 0,
        updatedAt: session.updatedAt || session.createdAt || null,
      });
    }
  }

  if (archived > 0) {
    if (archivedIds.has(sessionStore.activeSessionId)) {
      const fallback = Object.values(sessionsByProject)
        .flatMap((list) => Array.isArray(list) ? list : [])
        .filter((session) => session?.id && session.status !== "archived")
        .sort((a, b) => sessionTime(b) - sessionTime(a))[0];
      sessionStore.activeSessionId = fallback?.id || null;
    }
    writeRecoveryManifest(currentRoot, {
      archivedSyntheticSessions: archivedSessions,
    });
  }
  return { archived, archivedSessions };
}

function recoverOrphanLegacyMessageSessions() {
  const currentRoot = userDataPath();
  const projects = readJsonSafe(path.join(currentRoot, "projects.json"));
  const projectList = Array.isArray(projects?.projects) ? projects.projects : [];
  if (projectList.length === 0) return false;

  const targetProjectId =
    (projects.activeProjectId && projectList.some((project) => project.id === projects.activeProjectId))
      ? projects.activeProjectId
      : projectList[0].id;
  if (!targetProjectId) return false;

  const sessionPath = fs.existsSync(path.join(currentRoot, "sessions-index.json"))
    ? path.join(currentRoot, "sessions-index.json")
    : path.join(currentRoot, "sessions.json");
  const raw = readJsonSafe(sessionPath) || { activeSessionId: null, sessions: {} };
  raw.sessions = raw.sessions && typeof raw.sessions === "object" && !Array.isArray(raw.sessions)
    ? raw.sessions
    : {};
  if (!Array.isArray(raw.sessions[targetProjectId])) raw.sessions[targetProjectId] = [];

  const { archived } = pruneRecoveredLegacySessionFlood(raw, currentRoot);
  const existing = existingSessionIds(raw);
  const deleted = deletedSessionIds(currentRoot);
  const candidates = [
    ...messageFileSessionIds(path.join(currentRoot, "session-messages")),
  ]
    .filter((candidate) => candidate.id && !existing.has(candidate.id) && !deleted.has(candidate.id))
    .map((candidate) => ({
      ...candidate,
      messageCount: legacyMessageCount(candidate.filePath),
    }))
    .filter((candidate) => candidate.messageCount > 0);

  if (candidates.length > ORPHAN_RECOVERY_AUTO_LIMIT) {
    writeRecoveryManifest(currentRoot, {
      skippedBulkOrphanRecovery: {
        reason: "too_many_orphan_legacy_message_files",
        count: candidates.length,
        limit: ORPHAN_RECOVERY_AUTO_LIMIT,
        sessions: candidates.map((candidate) => ({
          id: candidate.id,
          file: path.basename(candidate.filePath),
          messageCount: candidate.messageCount,
        })),
      },
    });
    if (archived > 0) writeJsonSafe(sessionPath, raw);
    console.warn(
      `[data-migration] skipped ${candidates.length} orphan legacy message file(s); wrote recovery manifest instead of flooding the sidebar`,
    );
    return archived > 0;
  }

  let recovered = 0;
  for (const candidate of candidates) {
    if (!candidate.id || existing.has(candidate.id)) continue;
    let ts = Date.now();
    if (candidate.filePath) {
      try {
        ts = fs.statSync(candidate.filePath).mtimeMs || ts;
      } catch {
        // ignore
      }
    }
    raw.sessions[targetProjectId].push({
      id: candidate.id,
      projectId: targetProjectId,
      title: RECOVERED_LEGACY_TITLE,
      createdAt: new Date(ts).toISOString(),
      updatedAt: new Date(ts).toISOString(),
      status: "idle",
      messageCount: candidate.messageCount,
      recoveredFromLegacyMessages: true,
    });
    existing.add(candidate.id);
    recovered += 1;
  }

  if (recovered === 0 && archived === 0) return false;
  writeJsonSafe(sessionPath, raw);
  if (recovered > 0) {
    console.info(`[data-migration] recovered ${recovered} orphan legacy session(s) from copied messages`);
  }
  if (archived > 0) {
    console.info(`[data-migration] archived ${archived} synthetic recovered session(s) from old migrations`);
  }
  return true;
}

/**
 * Merge projects/sessions/config from pre-rename userData roots, then keep a backup.
 */
function migrateLegacyUserDataRoot() {
  const currentRoot = userDataPath();
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

    archiveLegacyUserDataRoot(legacyRoot);
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
    const { resolveOpencodeCommand } = require("./agent-command");
    const source = resolveOpencodeCommand();
    if (!source) return null;
    const st = fs.statSync(source);
    return {
      size: st.size,
      mtimeMs: Math.floor(st.mtimeMs),
      appVersion: appVersion(),
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

function clearLegacyGuideFileAttributes(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return;
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best effort: the cleanup below may still succeed.
  }
  try {
    if (process.platform === "win32") {
      const { execFileSync } = require("node:child_process");
      execFileSync("attrib", ["-H", "-R", "-S", filePath], { stdio: "ignore" });
    } else if (process.platform === "darwin") {
      const { execFileSync } = require("node:child_process");
      execFileSync("chflags", ["nohidden", filePath], { stdio: "ignore" });
    }
  } catch {
    // Attribute cleanup is intentionally non-fatal.
  }
}

function appendDistinctGuideContent(targetGuide, extraGuide) {
  let target = "";
  let extra = "";
  try {
    target = fs.readFileSync(targetGuide, "utf8");
    extra = fs.readFileSync(extraGuide, "utf8").trim();
  } catch {
    return false;
  }
  if (!extra || target.includes(extra)) return false;
  const merged = `${target.trimEnd()}\n\n## Preserved Legacy Guide Content\n\n${extra}\n`;
  fs.writeFileSync(targetGuide, merged, "utf8");
  return true;
}

function migrateLegacyGuideFile() {
  const configDir = agentConfigDir();
  const legacyGuide = path.join(configDir, "CLAUDE.md");
  const agentGuide = path.join(configDir, "AGENT.md");
  if (!fs.existsSync(legacyGuide)) return;
  if (!fs.existsSync(agentGuide)) {
    clearLegacyGuideFileAttributes(legacyGuide);
    fs.renameSync(legacyGuide, agentGuide);
    return;
  }
  try {
    appendDistinctGuideContent(agentGuide, legacyGuide);
    clearLegacyGuideFileAttributes(legacyGuide);
    fs.unlinkSync(legacyGuide);
  } catch {
    // Best-effort cleanup only; AGENT.md is now the canonical guide.
  }
}

const OPENCODE_INJECTED_GUIDANCE_MARKERS = [
  "# 智能工作台全局说明",
];

function scrubInjectedOpencodeGuidanceParts(dbPath = opencodeDbPath()) {
  if (!dbPath || !fs.existsSync(dbPath)) return 0;

  let db = null;
  try {
    const { openDatabase } = require("./store/sqlite-db");
    db = openDatabase(dbPath);
    if (!tableExists(db, "part") || !tableExists(db, "message")) return 0;

    let total = 0;
    const scrub = db.transaction(() => {
      for (const marker of OPENCODE_INJECTED_GUIDANCE_MARKERS) {
        const pattern = `%${marker}%`;
        const row = db.get("SELECT COUNT(*) AS count FROM part WHERE data LIKE ?", pattern);
        const count = Number(row?.count || 0);
        if (count <= 0) continue;
        db.run("DELETE FROM part WHERE data LIKE ?", pattern);
        total += count;
      }
      db.run(
        `DELETE FROM message
          WHERE NOT EXISTS (
            SELECT 1 FROM part WHERE part.message_id = message.id
          )`,
      );
    });
    scrub();
    if (total > 0) {
      console.info(`[data-migration] scrubbed ${total} injected OpenCode guidance part(s)`);
    }
    return total;
  } catch (err) {
    console.warn("[data-migration] failed to scrub injected OpenCode guidance:", err?.message || err);
    return 0;
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

/**
 * One-time migrations for renamed dirs, skills, and persisted fields.
 * Safe to call on every startup.
 */
function runDataMigrations() {
  migrateLegacyUserDataRoot();
  recoverOrphanLegacyMessageSessions();
  renameDirIfNeeded(LEGACY_BIN_DIR, path.basename(agentBinDir()));
  renameDirIfNeeded(LEGACY_CONFIG_DIR, path.basename(agentConfigDir()));
  migrateLegacyCliBinaries();
  migrateEngineSessionCompatibility();
  migrateInstalledSkillDir();
  migrateSkillsState();
  migrateSessionsResumeId();
  migrateSettingsEnvKeys();
  migrateLegacyGuideFile();
  scrubInjectedOpencodeGuidanceParts();
}

module.exports = {
  runDataMigrations,
  migrateLegacyUserDataRoot,
  recoverOrphanLegacyMessageSessions,
  migrateLegacyCliBinaries,
  migrateEngineSessionCompatibility,
  clearAllSessionResumeIds,
  migrateSettingsEnvKeys,
  migrateLegacyGuideFile,
  scrubInjectedOpencodeGuidanceParts,
  shouldPreferLegacyJson,
  mergeProjectsJson,
  mergeSessionsJson,
  forEachPersistedSession,
  legacyUserDataRoots,
  looksLikeLilyUserDataRoot,
};
