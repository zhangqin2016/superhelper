"use strict";

/**
 * Manages conversation sessions within projects.
 * Each session has its own isolated conversation history and CLI context.
 * Persisted as a lightweight index plus per-session message files.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  legacySessionsBackupPath,
  sessionsConfigPath,
  sessionsIndexPath,
  deletedSessionsPath,
  messageDbPath,
  blobStoreDir,
} = require("./config");
const { normalizeSessionPermissionMode } = require("./permission-settings");
const { getLocale } = require("./locale-settings");
const {
  ARTIFACT_SCHEMA_VERSION,
  RESULT_BLOCK_SCHEMA_VERSION,
  backfillMessageArtifacts,
} = require("./session-artifact-backfill");
const { MessageStore } = require("./store/message-store");
const legacyImport = require("./store/legacy-import");

const DEFAULT_SESSION_TITLES = {
  "zh-CN": "新对话",
  en: "Chat",
  ar: "محادثة جديدة",
};

function defaultSessionTitle() {
  return DEFAULT_SESSION_TITLES[getLocale()] || DEFAULT_SESSION_TITLES.en;
}

function messageMergeKey(message) {
  if (message?.id) return `id:${message.id}`;
  const hash = crypto.createHash("sha256");
  hash.update(JSON.stringify({
    role: message?.role || "assistant",
    content: message?.content || "",
    files: message?.files || null,
    turnId: message?.turnId || message?.record?.turnId || null,
    timestamp: message?.timestamp || null,
    failed: Boolean(message?.failed),
  }));
  return `fp:${hash.digest("hex")}`;
}

function mergeInlineMessages(currentMessages, legacyMessages) {
  const current = Array.isArray(currentMessages) ? currentMessages : [];
  const legacy = Array.isArray(legacyMessages) ? legacyMessages : [];
  if (legacy.length === 0) return current;

  const counts = new Map();
  for (const message of current) {
    const key = messageMergeKey(message);
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const merged = current.slice();
  const seenLegacy = new Map();
  for (const message of legacy) {
    const key = messageMergeKey(message);
    const seen = (seenLegacy.get(key) || 0) + 1;
    seenLegacy.set(key, seen);
    if ((counts.get(key) || 0) >= seen) continue;
    merged.push(message);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return merged;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(filePath, value) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
  } catch (err) {
    console.warn("[sessions] failed to write", filePath, err?.message || err);
  }
}

function markDeletedSession(session) {
  if (!session?.id) return;
  const filePath = deletedSessionsPath();
  const existing = readJson(filePath);
  const sessions = existing?.sessions && typeof existing.sessions === "object" && !Array.isArray(existing.sessions)
    ? existing.sessions
    : {};
  sessions[session.id] = {
    id: session.id,
    projectId: session.projectId || null,
    title: session.title || null,
    deletedAt: new Date().toISOString(),
  };
  writeJson(filePath, {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    sessions,
  });
}

class SessionManager {
  /**
   * @param {import('./project-manager')} projectManager
   */
  constructor(projectManager) {
    this.pm = projectManager;
    this.sessions = {};
    this.activeSessionId = null;
    this._saveTimer = null;
    this._savePending = false;
    this._legacyMigrationPending = false;
    this._messageStore = null;
    this._progressNotifier = null;
    this._timers = new Set();
    this._closed = false;
  }

  _setTimer(fn, delay) {
    const timer = setTimeout(() => {
      this._timers.delete(timer);
      if (!this._closed) fn();
    }, delay);
    this._timers.add(timer);
    return timer;
  }

  close() {
    this._closed = true;
    for (const timer of this._timers) clearTimeout(timer);
    this._timers.clear();
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    this._messageStore?.close?.();
    this._messageStore = null;
  }

  /** Host hook (set by main) to surface migration progress to the UI. */
  setProgressNotifier(fn) {
    this._progressNotifier = typeof fn === "function" ? fn : null;
  }

  /** Lazily-opened SQLite-backed message store for Lily metadata + legacy/fallback transcript. */
  _store() {
    if (!this._messageStore) {
      this._messageStore = new MessageStore(messageDbPath(), blobStoreDir());
    }
    return this._messageStore;
  }

  /**
   * Ensure a session's history lives in the message store. Idempotent and
   * cheap after the first call (gated by a schema_meta flag). Migrates both a
   * legacy per-session JSON file and any inline messages from the old
   * sessions.json format, then drops the in-memory array.
   *
   * Records are stored verbatim — artifact backfill (buildTurnArtifacts) is
   * deliberately NOT run here: it does per-path fs.statSync and costs ~200ms
   * per record, which would re-freeze the app during migration. Backfill for
   * legacy records is the artifact feature's concern, not the storage layer's.
   */
  _ensureImported(session) {
    if (!session) return;
    const store = this._store();
    legacyImport.importSession(store, session.id);
    if (Array.isArray(session.messages)) {
      if (session.messages.length) {
        const inserted = typeof store.bulkInsertMissing === "function"
          ? store.bulkInsertMissing(session.id, session.messages)
          : store.bulkInsert(session.id, session.messages);
        store.setMeta(`imported:${session.id}`, `inline:${inserted}/${session.messages.length}`);
      }
      delete session.messages;
    }
    session.messageCount = store.count(session.id);
  }

  load() {
    this._loadPersistedStore();

    // If the index existed but could not be read (corrupt) and no backup recovered it,
    // do NOT auto-create a session or save — that would overwrite the recoverable file
    // with an empty one (the exact footgun that wiped a user's history). Bail early and
    // leave everything on disk untouched for recovery.
    if (this._loadFailed) {
      console.error("[sessions] load failed (unreadable index, no backup) — skipping auto-create/save to protect on-disk data");
      this._startRuntimeEventMaintenance();
      return;
    }

    // Only ensure the active project has a session — avoids flooding
    // every project with a default when persisted data is missing/corrupt.
    const activeProject = this.pm.getActive();
    if (activeProject) {
      const activeSessions = this._getProjectSessions(activeProject.id);
      if (activeSessions.length === 0) {
        this.create(activeProject.id, defaultSessionTitle());
      }
    }

    this._reconcileWithProjects();
    if (this.pm.projects.length === 0) {
      this.activeSessionId = null;
    } else {
      const active = this.getActive();
      if (!active) {
        const first = this.pm.getActive();
        if (first) {
          const list = this._getProjectSessions(first.id);
          if (list.length > 0) {
            this.activeSessionId = list[0].id;
          }
        }
      }
    }
    this._resetStaleRunningStatus();
    this.repairDuplicateAgentResumeIds();
    this._migrateInlineMessages();
    this.saveImmediate();
    this._startBackgroundImport();
    this._startRuntimeEventMaintenance();
  }

  /** Move any in-memory (legacy sessions.json) messages into the store at startup. */
  _migrateInlineMessages() {
    for (const session of this.iterateSessions()) {
      if (Array.isArray(session.messages)) this._ensureImported(session);
    }
  }

  /** Drain remaining legacy per-session files without blocking startup. */
  _startBackgroundImport() {
    // Defer so first paint + the active session's load finish before the sweep
    // starts importing (and re-parsing) large legacy files in the background.
    // Only surface a progress UI when there's a real backlog; small migrations
    // stay silent (they finish in well under a second, lazily on open).
    const PROGRESS_MIN = 8;
    this._setTimer(() => {
      try {
        legacyImport.sweepInBackground(this._store(), {
          onProgress: ({ done, total }) => {
            if (total < PROGRESS_MIN) return;
            this._progressNotifier?.({ phase: done >= total ? "done" : "migrating", done, total });
          },
          onDone: ({ sessions, total }) => {
            if (sessions > 0) console.info(`[sessions] migrated ${sessions} legacy file(s) to sqlite`);
            if (total >= PROGRESS_MIN) this._progressNotifier?.({ phase: "done", done: total, total });
            this._startBackgroundEnrichment();
          },
        });
      } catch (err) {
        console.warn("[sessions] background import failed:", err?.message || err);
      }
    }, 5000);
  }

  /**
   * After migration, re-derive artifacts for legacy records that predate the
   * artifact feature — off the hot path, one session per tick. Idempotent
   * (per-session flag) and cheap now that derivation is bounded. This is the
   * proper home for backfill: never on the read path, never blocking.
   */
  _startBackgroundEnrichment() {
    let pending;
    try {
      pending = this.iterateSessions().filter((s) => !this._store().meta(this._enrichmentFlag(s.id)));
    } catch {
      return;
    }
    const step = () => {
      const session = pending.shift();
      if (!session) return;
      try {
        this._enrichSession(session);
      } catch (err) {
        console.warn("[sessions] enrichment failed for", session.id, err?.message || err);
      }
      this._setTimer(step, 0);
    };
    if (pending.length) this._setTimer(step, 0);
  }

  _startRuntimeEventMaintenance() {
    const BATCH_SIZE = 200;
    const MIN_BYTES = 20_000;
    const MAX_ROUNDS = 50;
    let rounds = 0;
    const step = () => {
      rounds += 1;
      try {
        const result = this._store().compactRuntimeEventPayloads({
          limit: BATCH_SIZE,
          minBytes: MIN_BYTES,
        });
        if (result?.compacted > 0) {
          const saved = Math.max(0, Number(result.beforeBytes || 0) - Number(result.afterBytes || 0));
          console.info(`[sessions] compacted ${result.compacted} runtime event payload(s), saved ${saved} byte(s)`);
        }
        if (result?.compacted > 0 && rounds < MAX_ROUNDS) {
          this._setTimer(step, 1000);
        }
      } catch (err) {
        console.warn("[sessions] runtime event maintenance failed:", err?.message || err);
      }
    };
    this._setTimer(step, 12000);
  }

  _enrichmentFlag(sessionId) {
    return `enriched:${sessionId}:a${ARTIFACT_SCHEMA_VERSION}:b${RESULT_BLOCK_SCHEMA_VERSION}`;
  }

  _enrichSession(session) {
    const store = this._store();
    const flag = this._enrichmentFlag(session.id);
    if (store.meta(flag)) return;
    const workspacePath = this.pm?.find?.(session.projectId)?.path || "";
    if (!workspacePath) return; // retry next launch once a workspace is known
    let enriched = 0;
    for (const message of store.getAll(session.id)) {
      if (!message?.record || !message.id) continue;
      if (backfillMessageArtifacts(message, workspacePath)) {
        store.updateById(message.id, () => message);
        enriched += 1;
      }
    }
    store.setMeta(flag, `1:${enriched}`);
    if (enriched > 0) console.info(`[sessions] enriched ${enriched} record(s) for ${session.id}`);
  }

  _loadPersistedStore() {
    const indexPath = sessionsIndexPath();
    const legacyPath = sessionsConfigPath();
    let parsed = null;

    if (fs.existsSync(indexPath)) {
      parsed = this._readJson(indexPath);
      if (!parsed) {
        // Index exists but is unreadable/corrupt. Treating it as "empty" here would let
        // the next save wipe every session (the footgun that lost a user's history).
        // Quarantine the bad file and recover from the rolling .bak; if no usable backup
        // exists, flag the load as failed so load() bails without auto-create/save.
        this._quarantineCorruptIndex(indexPath);
        parsed = this._recoverIndexFromBackup(indexPath);
        if (!parsed) this._loadFailed = true;
      }
      this._legacyMigrationPending = false;
      this.sessions = this._normalizeSessionsStore(parsed?.sessions || {});
      this.activeSessionId = parsed?.activeSessionId || null;
      if (!this._loadFailed && fs.existsSync(legacyPath)) {
        const legacy = this._readJson(legacyPath);
        if (legacy) {
          this._mergeLegacySessions(legacy);
          this._legacyMigrationPending = true;
        }
      }
      return;
    } else if (fs.existsSync(legacyPath)) {
      parsed = this._readJson(legacyPath);
      this._legacyMigrationPending = Boolean(parsed);
    }

    this.sessions = this._normalizeSessionsStore(parsed?.sessions || {});
    this.activeSessionId = parsed?.activeSessionId || null;
  }

  _quarantineCorruptIndex(indexPath) {
    try {
      fs.copyFileSync(indexPath, `${indexPath}.corrupt-${Date.now()}.json`);
      console.error(`[sessions] ${indexPath} is unreadable/corrupt — quarantined a copy; attempting backup recovery`);
    } catch { /* best effort */ }
  }

  _recoverIndexFromBackup(indexPath) {
    const bak = `${indexPath}.bak`;
    if (fs.existsSync(bak)) {
      const backup = this._readJson(bak);
      if (backup && this._countSessions(backup) > 0) {
        console.error("[sessions] recovered session index from .bak");
        return backup;
      }
    }
    return null;
  }

  _mergeLegacySessions(legacyStore) {
    const legacySessions = this._normalizeSessionsStore(legacyStore?.sessions || {});
    let added = 0;
    let merged = 0;
    for (const [projectId, list] of Object.entries(legacySessions)) {
      if (!this.sessions[projectId]) this.sessions[projectId] = [];
      const existingById = new Map(this.sessions[projectId].map((session) => [session.id, session]));
      for (const session of list) {
        const existing = existingById.get(session.id);
        if (existing) {
          const before = Array.isArray(existing.messages) ? existing.messages.length : 0;
          existing.messages = mergeInlineMessages(existing.messages, session.messages);
          if ((!existing.title || existing.title === defaultSessionTitle()) && session.title) {
            existing.title = session.title;
          }
          if (!existing.createdAt && session.createdAt) existing.createdAt = session.createdAt;
          if (session.updatedAt && (!existing.updatedAt || Date.parse(session.updatedAt) > Date.parse(existing.updatedAt))) {
            existing.updatedAt = session.updatedAt;
          }
          existing.messageCount = Math.max(
            Number.isInteger(existing.messageCount) ? existing.messageCount : 0,
            existing.messages.length,
            Number.isInteger(session.messageCount) ? session.messageCount : 0,
          );
          if (existing.messages.length !== before) merged += 1;
          continue;
        }
        this.sessions[projectId].push(session);
        existingById.set(session.id, session);
        added += 1;
      }
    }
    if (!this.activeSessionId && legacyStore?.activeSessionId) {
      this.activeSessionId = legacyStore.activeSessionId;
    }
    if (added > 0) {
      console.info(`[sessions] merged ${added} legacy session(s) into split store`);
    }
    if (merged > 0) {
      console.info(`[sessions] repaired ${merged} legacy session(s) with missing inline messages`);
    }
  }

  _normalizeSessionsStore(store) {
    const normalized = {};
    if (!store || typeof store !== "object" || Array.isArray(store)) return normalized;
    for (const [projectId, list] of Object.entries(store)) {
      if (!Array.isArray(list)) continue;
      normalized[projectId] = list.map((session) => this._normalizeSession(projectId, session));
    }
    return normalized;
  }

  _normalizeSession(projectId, session) {
    const messages = Array.isArray(session?.messages) ? session.messages : undefined;
    const normalized = {
      ...session,
      id: session?.id || crypto.randomUUID(),
      projectId: session?.projectId || projectId,
      title: session?.title || defaultSessionTitle(),
      createdAt: session?.createdAt || new Date().toISOString(),
      updatedAt: session?.updatedAt || new Date().toISOString(),
      status: session?.status || "idle",
      messageCount: Number.isInteger(session?.messageCount)
        ? session.messageCount
        : messages?.length || 0,
    };
    delete normalized.messages;
    if (messages) {
      // Legacy inline messages (old sessions.json). Kept on the in-memory
      // session only until _ensureImported migrates them into the store.
      normalized.messages = messages;
      normalized.messageCount = messages.length;
    }
    return normalized;
  }

  _readJson(filePath) {
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      return null;
    }
  }

  /** All messages for a session (chronological), migrating legacy data on first touch. */
  _messages(session) {
    if (!session) return [];
    this._ensureImported(session);
    return this._store().getAll(session.id);
  }

  /** Append one message through the store; keeps the cached count in sync. */
  _appendToStore(session, message) {
    this._ensureImported(session);
    const stored = this._store().append(session.id, message);
    session.messageCount = this._store().count(session.id);
    session.updatedAt = new Date().toISOString();
    this.save();
    return stored;
  }

  /** Drop a session's history (rows + blobs) and any not-yet-imported legacy file. */
  _deleteMessageFile(sessionId) {
    try {
      this._store().clear(sessionId);
      this._store().setMeta(`imported:${sessionId}`, "deleted");
    } catch (err) {
      console.warn("[sessions] failed to clear messages for", sessionId, err?.message || err);
    }
    try {
      fs.rmSync(legacyImport.legacyFilePath(sessionId), { force: true });
    } catch {
      // ignore
    }
  }

  _deleteSummaryFile(sessionId) {
    try {
      require("./session-memory").clearSessionSummary(sessionId);
    } catch {
      // ignore
    }
  }

  /** Remove the old per-session OpenCode cache directory from pre-shared-server builds.
   *  Current OpenCode-backed conversations use the shared OpenCode DB for canonical
   *  transcript and messages.db only for Lily metadata / legacy fallback. */
  _deleteOpencodeSession(sessionId) {
    try {
      fs.rmSync(require("./config").opencodeSessionDir(sessionId), { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  /** Remove OpenCode engine caches whose session no longer exists — cleans up
   *  orphans from crashes or pre-cleanup builds. Safe to run after load(): every
   *  live/archived session is in this.sessions, so only true orphans are removed. */
  gcOrphanEngineSessions() {
    try {
      const { opencodeSessionsDir } = require("./config");
      const root = opencodeSessionsDir();
      if (!fs.existsSync(root)) return 0;
      const live = new Set();
      for (const list of Object.values(this.sessions)) {
        for (const s of list || []) live.add(s.id);
      }
      let removed = 0;
      for (const entry of fs.readdirSync(root)) {
        if (live.has(entry)) continue;
        try {
          fs.rmSync(path.join(root, entry), { recursive: true, force: true });
          removed += 1;
        } catch {
          // ignore
        }
      }
      return removed;
    } catch {
      return 0;
    }
  }

  /** Remove sessions for a deleted project (do not merge into other projects). */
  purgeProject(projectId) {
    const list = this.sessions[projectId];
    if (!list?.length) {
      delete this.sessions[projectId];
      return [];
    }
    const ids = list.map((s) => s.id);
    if (ids.includes(this.activeSessionId)) {
      this.activeSessionId = null;
    }
    delete this.sessions[projectId];
    for (const id of ids) this._deleteMessageFile(id);
    for (const id of ids) this._deleteSummaryFile(id);
    for (const id of ids) this._deleteOpencodeSession(id);
    this.saveImmediate();
    return ids;
  }

  /** Ensure a project has at least one session without switching away from current. */
  ensureDefaultForProject(projectId) {
    if (this._getProjectSessions(projectId).length > 0) return null;
    const session = {
      id: crypto.randomUUID(),
      projectId,
      title: defaultSessionTitle(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "idle",
      messages: [],
      messageCount: 0,
    };
    if (!this.sessions[projectId]) this.sessions[projectId] = [];
    this.sessions[projectId].push(session);
    if (!this.activeSessionId) this.activeSessionId = session.id;
    this.saveImmediate();
    return session;
  }

  /** Drop sessions whose project no longer exists (never migrate to another project). */
  _reconcileWithProjects() {
    const validProjectIds = new Set(this.pm.projects.map((p) => p.id));
    // If projects failed to load (none present), do NOT prune — pruning against an empty
    // project set would delete every session. Better to keep them than to wipe them.
    if (validProjectIds.size === 0) return;
    const activeProject = this.pm.getActive();

    if (!activeProject) {
      for (const projectId of Object.keys(this.sessions)) {
        if (!validProjectIds.has(projectId)) {
          delete this.sessions[projectId];
        }
      }
      if (this.activeSessionId && !this._find(this.activeSessionId)) {
        this.activeSessionId = null;
      }
      return;
    }

    for (const projectId of Object.keys(this.sessions)) {
      if (validProjectIds.has(projectId)) continue;
      const orphaned = this.sessions[projectId] || [];
      delete this.sessions[projectId];
      if (orphaned.some((s) => s.id === this.activeSessionId)) {
        this.activeSessionId = null;
      }
    }

    if (this.activeSessionId && !this._find(this.activeSessionId)) {
      const list = this._getProjectSessions(activeProject.id);
      this.activeSessionId = list[0]?.id || null;
    }

  }

  _resetStaleRunningStatus() {
    for (const list of Object.values(this.sessions)) {
      for (const session of list) {
        if (session.status === "running") session.status = "idle";
      }
    }
  }

  _normalizeAgentResumeId(agentResumeId) {
    const normalized = String(agentResumeId || "").trim();
    return normalized || null;
  }

  _sessionSortTime(session, key) {
    const ts = Date.parse(session?.[key] || "");
    return Number.isFinite(ts) ? ts : 0;
  }

  _preferAgentResumeOwner(candidate, current) {
    if (!current) return true;
    const candidateUpdated = this._sessionSortTime(candidate, "updatedAt");
    const currentUpdated = this._sessionSortTime(current, "updatedAt");
    if (candidateUpdated !== currentUpdated) return candidateUpdated > currentUpdated;

    const candidateCreated = this._sessionSortTime(candidate, "createdAt");
    const currentCreated = this._sessionSortTime(current, "createdAt");
    if (candidateCreated !== currentCreated) return candidateCreated > currentCreated;

    return String(candidate?.id || "") > String(current?.id || "");
  }

  _clearResumeLink(session) {
    if (!session) return false;
    let changed = false;
    if (session.agentResumeId) {
      delete session.agentResumeId;
      changed = true;
    }
    if (session.agentResumeBinding) {
      delete session.agentResumeBinding;
      changed = true;
    }
    if (session.claudeSessionId) {
      delete session.claudeSessionId;
      changed = true;
    }
    if (session.legacyContextHydratedAgentResumeId) {
      delete session.legacyContextHydratedAgentResumeId;
      changed = true;
    }
    if (session.legacyContextHydratedAt) {
      delete session.legacyContextHydratedAt;
      changed = true;
    }
    return changed;
  }

  /** Enforce the core invariant: one Lily session owns one engine resume id.
   *  Shared OpenCode event streams route by engine session id; if two Lily
   *  sessions persist the same id, both can receive the same tool/output
   *  events. Repair persisted duplicates deterministically at startup and
   *  after legacy merges before any runner can subscribe. */
  repairDuplicateAgentResumeIds() {
    const owners = new Map();
    let changed = false;

    for (const session of this.iterateSessions()) {
      const normalized = this._normalizeAgentResumeId(session.agentResumeId || session.claudeSessionId);
      if (!normalized) continue;
      if (session.agentResumeId !== normalized || session.claudeSessionId) {
        session.agentResumeId = normalized;
        delete session.claudeSessionId;
        changed = true;
      }
      const current = owners.get(normalized);
      if (this._preferAgentResumeOwner(session, current)) {
        owners.set(normalized, session);
      }
    }

    for (const session of this.iterateSessions()) {
      const resumeId = this._normalizeAgentResumeId(session.agentResumeId);
      if (!resumeId) continue;
      const owner = owners.get(resumeId);
      if (owner?.id === session.id) continue;
      if (this._clearResumeLink(session)) changed = true;
      try {
        require("./session-engine-recovery").resetSessionEngineCache(session.id);
      } catch {
        // best effort; clearing the persisted resume link is the important bit
      }
    }

    if (changed) {
      this.saveImmediate();
      console.info("[sessions] repaired duplicate agent resume ownership");
    }
    return changed;
  }

  findAgentResumeOwner(agentResumeId, excludeSessionId = null) {
    const resumeId = this._normalizeAgentResumeId(agentResumeId);
    if (!resumeId) return null;
    let owner = null;
    for (const session of this.iterateSessions()) {
      if (excludeSessionId && session.id === excludeSessionId) continue;
      if (this._normalizeAgentResumeId(session.agentResumeId) !== resumeId) continue;
      if (this._preferAgentResumeOwner(session, owner)) owner = session;
    }
    return owner;
  }

  _scheduleSave() {
    if (this._saveTimer) {
      this._savePending = true;
      return;
    }
    this._doSave();
    this._saveTimer = this._setTimer(() => {
      this._saveTimer = null;
      if (this._savePending) {
        this._savePending = false;
        this._doSave();
      }
    }, 500);
  }

  _doSave() {
    const indexPath = sessionsIndexPath();
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    const next = { activeSessionId: this.activeSessionId, sessions: this._buildSessionIndex() };
    // Anti-data-loss guard: never let a catastrophically-collapsed in-memory store
    // (the classic "failed load -> saveImmediate empties the file" footgun that wiped
    // a user's session list) overwrite a healthy on-disk index. CAPABILITY-GATE Rule
    // 13 — worst case = this run's edits don't persist; the data on disk stays intact.
    if (!this._guardSessionCollapse(next)) return;
    // Roll a backup of the last KNOWN-GOOD file, then write ATOMICALLY (tmp -> rename)
    // so an interrupted/crashed write can never leave a half-written corrupt index —
    // the root cause that made the next load read "empty".
    try {
      if (fs.existsSync(indexPath)) {
        const current = this._readJson(indexPath);
        if (current && this._countSessions(current) > 0) fs.copyFileSync(indexPath, `${indexPath}.bak`);
      }
    } catch { /* best effort */ }
    const tmp = `${indexPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, indexPath);
    this._backupLegacySessionsFileIfNeeded();
  }

  _countSessions(store) {
    let n = 0;
    for (const list of Object.values(store?.sessions || {})) n += Array.isArray(list) ? list.length : 0;
    return n;
  }

  /** @returns {boolean} true to allow the write; false to refuse (collapse detected). */
  _guardSessionCollapse(next) {
    if (process.env.LILY_DISABLE_SESSION_SAVE_GUARD === "1") return true;
    const indexPath = sessionsIndexPath();
    let existing = null;
    let existedButUnreadable = false;
    try {
      if (fs.existsSync(indexPath)) existing = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    } catch {
      existedButUnreadable = true; // present but corrupt
    }
    if (existedButUnreadable) {
      // Don't let an empty/collapsed store overwrite a corrupt-but-present file (it may
      // still be recoverable). A real write WITH data is allowed to replace it.
      if (this._countSessions(next) <= 1) {
        console.error("[sessions] BLOCKED overwrite of an unreadable index with a near-empty store");
        return false;
      }
      return true;
    }
    if (!existing) return true; // first-ever save / no prior file
    const existingCount = this._countSessions(existing);
    const nextCount = this._countSessions(next);
    // Collapse signature: a substantial store about to drop to ~nothing. A normal edit
    // or delete never matches (nextCount stays > 1); only a failed-load wipe does.
    const GUARD_MIN = 3;
    if (existingCount >= GUARD_MIN && nextCount <= 1 && nextCount < existingCount) {
      const backup = `${indexPath}.guard-backup-${Date.now()}.json`;
      try { fs.copyFileSync(indexPath, backup); } catch { /* best effort */ }
      console.error(
        `[sessions] BLOCKED session-index overwrite: on-disk has ${existingCount} sessions, ` +
        `in-memory has ${nextCount} — likely a failed load. Preserved ${indexPath} ` +
        `(backup: ${backup}). Override with LILY_DISABLE_SESSION_SAVE_GUARD=1.`,
      );
      return false;
    }
    return true;
  }

  _buildSessionIndex() {
    const index = {};
    for (const [projectId, list] of Object.entries(this.sessions)) {
      index[projectId] = (list || []).map((session) => {
        const { messages, ...meta } = session;
        return {
          ...meta,
          messageCount: Number.isInteger(session.messageCount)
            ? session.messageCount
            : Array.isArray(messages)
              ? messages.length
              : 0,
        };
      });
    }
    return index;
  }

  _backupLegacySessionsFileIfNeeded() {
    const legacyPath = sessionsConfigPath();
    if (!fs.existsSync(legacyPath)) return;
    const backupPath = legacySessionsBackupPath();
    try {
      if (this._legacyMigrationPending && !fs.existsSync(backupPath)) {
        fs.renameSync(legacyPath, backupPath);
        console.info(`[sessions] migrated ${legacyPath} -> ${backupPath}`);
      } else {
        fs.rmSync(legacyPath, { force: true });
      }
      this._legacyMigrationPending = false;
    } catch (err) {
      console.warn("[sessions] failed to remove legacy sessions.json:", err?.message || err);
    }
  }

  save() {
    this._scheduleSave();
  }

  saveImmediate() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
      this._savePending = false;
    }
    this._doSave();
  }

  getActive() {
    if (this.activeSessionId) {
      const byId = this._find(this.activeSessionId);
      if (byId) return byId;
    }
    const project = this.pm.getActive();
    if (!project) return null;
    const list = this._getProjectSessions(project.id);
    const session = list.find((s) => s.id === this.activeSessionId) || list[0] || null;
    return session;
  }

  listForProject(projectId) {
    return this._getProjectSessions(projectId).map((s) => ({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      messageCount: Number.isInteger(s.messageCount) ? s.messageCount : 0,
      status: s.status,
      skillCustomized: s.enabledSkillIds != null && Array.isArray(s.enabledSkillIds),
      permissionModeId: normalizeSessionPermissionMode(s.permissionModeId) || null,
      permissionCustomized: Boolean(normalizeSessionPermissionMode(s.permissionModeId)),
    }));
  }

  iterateSessions() {
    const all = [];
    for (const list of Object.values(this.sessions)) {
      for (const session of list) {
        all.push(session);
      }
    }
    return all;
  }

  setEnabledSkillIds(sessionId, enabledSkillIds) {
    const session = this._find(sessionId);
    if (!session) return false;
    if (enabledSkillIds == null) {
      delete session.enabledSkillIds;
    } else {
      session.enabledSkillIds = [...new Set(enabledSkillIds)];
    }
    session.updatedAt = new Date().toISOString();
    this.save();
    return true;
  }

  setPermissionMode(sessionId, modeId) {
    const session = this._find(sessionId);
    if (!session) return false;
    const normalized = normalizeSessionPermissionMode(modeId);
    if (normalized === undefined) return false;
    if (normalized == null) {
      delete session.permissionModeId;
    } else {
      session.permissionModeId = normalized;
    }
    session.updatedAt = new Date().toISOString();
    this.save();
    return true;
  }

  create(projectId, title) {
    const session = {
      id: crypto.randomUUID(),
      projectId,
      title: (title || defaultSessionTitle()).slice(0, 80),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "idle",
      messages: [],
      messageCount: 0,
    };
    if (!this.sessions[projectId]) {
      this.sessions[projectId] = [];
    }
    this.sessions[projectId].push(session);
    this.activeSessionId = session.id;
    this.saveImmediate();
    return session;
  }

  switchTo(sessionId) {
    this.activeSessionId = sessionId;
    this.saveImmediate();
  }

  rename(sessionId, title) {
    const session = this._find(sessionId);
    if (!session) return false;
    session.title = (title || "Unnamed").slice(0, 80);
    this.save();
    return true;
  }

  delete(sessionId) {
    return this.deleteById(sessionId);
  }

  /** Delete by session id across all projects (not limited to active project). */
  deleteById(sessionId) {
    const session = this._find(sessionId, { loadMessages: false });
    if (!session) return "NOT_FOUND";
    const projectId = session.projectId;
    const list = this.sessions[projectId];
    if (!list || list.length <= 1) return "LAST_SESSION";
    const idx = list.findIndex((s) => s.id === sessionId);
    if (idx === -1) return "NOT_FOUND";
    list.splice(idx, 1);
    if (this.activeSessionId === sessionId) {
      this.activeSessionId = list[Math.max(0, idx - 1)].id;
    }
    markDeletedSession(session);
    this._deleteMessageFile(sessionId);
    this._deleteSummaryFile(sessionId);
    this._deleteOpencodeSession(sessionId);
    this.saveImmediate();
    return "OK";
  }

  archive(sessionId) {
    const session = this._find(sessionId);
    if (!session) return false;
    session.status = "archived";
    this.save();
    return true;
  }

  setStatus(sessionId, status) {
    const session = this._find(sessionId);
    if (!session) return;
    session.status = status;
    this.save();
  }

  claimAgentResumeId(sessionId, agentResumeId, binding = null) {
    const session = this._find(sessionId);
    const normalized = this._normalizeAgentResumeId(agentResumeId);
    if (!session || !normalized) return { ok: false, evictedSessionIds: [] };
    let changed = false;
    const evictedSessionIds = [];
    for (const other of this.iterateSessions()) {
      if (other.id === session.id) continue;
      if (this._normalizeAgentResumeId(other.agentResumeId) !== normalized) continue;
      if (this._clearResumeLink(other)) changed = true;
      evictedSessionIds.push(other.id);
      try {
        require("./session-engine-recovery").resetSessionEngineCache(other.id);
      } catch {
        // ignore
      }
    }
    if (session.agentResumeId !== normalized) {
      session.agentResumeId = normalized;
      changed = true;
    }
    const nextBinding = binding && typeof binding === "object"
      ? { ...binding, resumeId: normalized }
      : null;
    if (nextBinding) {
      const current = JSON.stringify(session.agentResumeBinding || null);
      const next = JSON.stringify(nextBinding);
      if (current !== next) {
        session.agentResumeBinding = nextBinding;
        changed = true;
      }
    }
    if (changed) this.save();
    return { ok: true, evictedSessionIds };
  }

  setAgentResumeId(sessionId, agentResumeId, binding = null) {
    return this.claimAgentResumeId(sessionId, agentResumeId, binding).ok;
  }

  clearAgentResumeId(sessionId) {
    const session = this._find(sessionId);
    if (!session) return false;
    if (!this._clearResumeLink(session)) return false;
    this.save();
    return true;
  }

  markLegacyContextHydrated(sessionId, agentResumeId) {
    const session = this._find(sessionId);
    if (!session) return false;
    session.legacyContextHydratedAgentResumeId = String(agentResumeId || "fresh-opencode-session");
    session.legacyContextHydratedAt = new Date().toISOString();
    this.save();
    return true;
  }

  pushMessage(role, content, files = null) {
    const session = this.getActive();
    if (!session) return;
    this._appendMessage(session, role, content, files);
  }

  pushMessageTo(sessionId, role, content, files = null, extra = null) {
    const session = this._find(sessionId);
    if (!session) return;
    this._appendMessage(session, role, content, files, extra);
  }

  findMessage(sessionId, messageId) {
    const session = this._find(sessionId);
    if (!session || !messageId) return null;
    this._ensureImported(session);
    return this._store().getById(messageId);
  }

  /** Rewind support: drop the given turn and every message after it, and keep the
   *  session's messageCount in sync. Returns how many messages were removed. */
  deleteMessagesFromTurn(sessionId, turnId) {
    const session = this._find(sessionId);
    if (!session || !turnId) return 0;
    this._ensureImported(session);
    const removed = this._store().deleteFromTurn(session.id, turnId);
    if (removed > 0) {
      session.messageCount = this._store().count(session.id);
      session.updatedAt = new Date().toISOString();
      this.save();
    }
    return removed;
  }

  updateMessageMeta(sessionId, messageId, updater) {
    const session = this._find(sessionId);
    if (!session || !messageId) return null;
    this._ensureImported(session);
    const updated = this._store().updateById(messageId, (message) => {
      const current = message.meta && typeof message.meta === "object" ? message.meta : {};
      const next = typeof updater === "function" ? updater(current, message) : updater;
      if (!next || typeof next !== "object") return null;
      message.meta = next;
      return message;
    });
    if (!updated) return null;
    session.updatedAt = new Date().toISOString();
    this.save();
    return updated;
  }

  admitTurnInput(sessionId, input = {}) {
    const session = this._find(sessionId);
    if (!session) return null;
    this._ensureImported(session);
    return this._store().admitTurnInput(session.id, input);
  }

  markTurnInputPromoted(turnId, patch = {}) {
    if (!turnId) return null;
    return this._store().markTurnInputPromoted(turnId, patch);
  }

  markTurnInputTerminal(turnId, terminalType, patch = {}) {
    if (!turnId) return null;
    return this._store().markTurnInputTerminal(turnId, terminalType, patch);
  }

  pendingTurnInputs(sessionId) {
    const session = this._find(sessionId);
    if (!session) return [];
    this._ensureImported(session);
    return this._store().pendingTurnInputs(session.id);
  }

  appendRuntimeEvents(sessionId, events) {
    const session = this._find(sessionId);
    if (!session) return [];
    this._ensureImported(session);
    return this._store().appendRuntimeEvents(session.id, events);
  }

  getRuntimeEvents(sessionId, opts = {}) {
    const session = this._find(sessionId);
    if (!session) return [];
    this._ensureImported(session);
    return this._store().getRuntimeEvents(session.id, opts);
  }

  getTurnProjection(sessionId, turnId) {
    const session = this._find(sessionId);
    if (!session) return null;
    this._ensureImported(session);
    return this._store().getTurnProjection(session.id, turnId);
  }

  getTurnProjections(sessionId, opts = {}) {
    const session = this._find(sessionId);
    if (!session) return [];
    this._ensureImported(session);
    return this._store().getTurnProjections(session.id, opts);
  }

  getProjectedConversation(sessionId, opts = {}) {
    const session = this._find(sessionId);
    if (!session) return [];
    this._ensureImported(session);
    return this._store().getProjectedConversation(session.id, opts);
  }

  /** Most recent message in this session, or null. */
  getLastMessage(sessionId) {
    const session = this._find(sessionId);
    if (!session) return null;
    this._ensureImported(session);
    const page = this._store().getPage(session.id, { limit: 1 });
    return page.conversation[page.conversation.length - 1] || null;
  }

  /** Last user message in this session (for retry). */
  getLastUserMessage(sessionId) {
    const session = this._find(sessionId);
    if (!session) return null;
    this._ensureImported(session);
    return this._store().lastOfRole(session.id, "user");
  }

  /** Remove trailing assistant message (failed turn before retry). */
  popLastAssistantMessage(sessionId) {
    const session = this._find(sessionId);
    if (!session) return false;
    this._ensureImported(session);
    if (!this._store().removeLast(session.id, "assistant")) return false;
    session.messageCount = this._store().count(session.id);
    session.updatedAt = new Date().toISOString();
    this.save();
    return true;
  }

  /** Remove the last message if it is from the user (e.g. send to CLI failed). */
  popLastUserMessage(sessionId) {
    const session = this._find(sessionId);
    if (!session) return false;
    this._ensureImported(session);
    if (!this._store().removeLast(session.id, "user")) return false;
    session.messageCount = this._store().count(session.id);
    session.updatedAt = new Date().toISOString();
    this.save();
    return true;
  }

  _appendMessage(session, role, content, files = null, extra = null) {
    const entry = {
      id: extra?.id || `msg_${crypto.randomUUID()}`,
      role,
      content,
      files: files && files.length > 0 ? files : undefined,
      turnId: extra?.turnId,
      timestamp: new Date().toISOString(),
    };
    if (extra?.failed) entry.failed = true;
    if (extra?.meta && typeof extra.meta === "object") entry.meta = extra.meta;
    if (extra?.record && typeof extra.record === "object") entry.record = extra.record;
    this._appendToStore(session, entry);
  }

  getConversation(sessionId) {
    const session = sessionId ? this._find(sessionId) : this.getActive();
    return session ? this._messages(session) : [];
  }

  getConversationPage(sessionId, opts = {}) {
    const session = sessionId ? this._find(sessionId) : this.getActive();
    if (!session) {
      return {
        ok: false,
        error: "NOT_FOUND",
        sessionId: sessionId || null,
        conversation: [],
        hasMore: false,
        before: 0,
        nextBefore: 0,
        total: 0,
      };
    }
    this._ensureImported(session);
    const page = this._store().getPage(session.id, {
      before: Number.isInteger(opts.before) ? opts.before : undefined,
      limit: opts.limit,
    });
    // Keep the cached count fresh for listForProject without a separate query.
    session.messageCount = page.total;
    return {
      ok: true,
      sessionId: session.id,
      projectId: session.projectId,
      ...page,
    };
  }

  findById(sessionId) {
    return this._find(sessionId);
  }

  clearConversation(sessionId) {
    const session = this._find(sessionId) || this.getActive();
    if (!session) return;
    this._store().clear(session.id);
    this._store().setMeta(`imported:${session.id}`, "cleared");
    try {
      fs.rmSync(legacyImport.legacyFilePath(session.id), { force: true });
    } catch {
      // ignore
    }
    session.messageCount = 0;
    delete session.agentResumeId;
    delete session.agentResumeBinding;
    this._deleteSummaryFile(session.id);
    this.save();
  }

  _find(sessionId) {
    for (const list of Object.values(this.sessions)) {
      const found = list.find((s) => s.id === sessionId);
      if (found) return found;
    }
    return null;
  }

  _getProjectSessions(projectId) {
    if (!this.sessions[projectId]) this.sessions[projectId] = [];
    return this.sessions[projectId].filter((s) => s.status !== "archived");
  }
}

module.exports = SessionManager;
module.exports.defaultSessionTitle = defaultSessionTitle;
