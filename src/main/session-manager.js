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
  messageDbPath,
  blobStoreDir,
} = require("./config");
const { normalizeSessionPermissionMode } = require("./permission-settings");
const { getLocale } = require("./locale-settings");
const { backfillMessageArtifacts } = require("./session-artifact-backfill");
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
  }

  /** Host hook (set by main) to surface migration progress to the UI. */
  setProgressNotifier(fn) {
    this._progressNotifier = typeof fn === "function" ? fn : null;
  }

  /** Lazily-opened SQLite-backed message store (single source of truth for messages). */
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
      if (session.messages.length && store.count(session.id) === 0) {
        store.bulkInsert(session.id, session.messages);
        store.setMeta(`imported:${session.id}`, `inline:${session.messages.length}`);
      }
      delete session.messages;
    }
  }

  load() {
    this._loadPersistedStore();

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
    this._migrateInlineMessages();
    this.saveImmediate();
    this._startBackgroundImport();
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
    setTimeout(() => {
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
      pending = this.iterateSessions().filter((s) => !this._store().meta(`enriched:${s.id}`));
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
      setTimeout(step, 0);
    };
    if (pending.length) setTimeout(step, 0);
  }

  _enrichSession(session) {
    const store = this._store();
    const flag = `enriched:${session.id}`;
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
      this._legacyMigrationPending = false;
      this.sessions = this._normalizeSessionsStore(parsed?.sessions || {});
      this.activeSessionId = parsed?.activeSessionId || null;
      if (fs.existsSync(legacyPath)) {
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

  _mergeLegacySessions(legacyStore) {
    const legacySessions = this._normalizeSessionsStore(legacyStore?.sessions || {});
    let added = 0;
    for (const [projectId, list] of Object.entries(legacySessions)) {
      if (!this.sessions[projectId]) this.sessions[projectId] = [];
      const existingIds = new Set(this.sessions[projectId].map((session) => session.id));
      for (const session of list) {
        if (existingIds.has(session.id)) continue;
        this.sessions[projectId].push(session);
        existingIds.add(session.id);
        added += 1;
      }
    }
    if (!this.activeSessionId && legacyStore?.activeSessionId) {
      this.activeSessionId = legacyStore.activeSessionId;
    }
    if (added > 0) {
      console.info(`[sessions] merged ${added} legacy session(s) into split store`);
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

  _scheduleSave() {
    if (this._saveTimer) {
      this._savePending = true;
      return;
    }
    this._doSave();
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      if (this._savePending) {
        this._savePending = false;
        this._doSave();
      }
    }, 500);
  }

  _doSave() {
    const dir = path.dirname(sessionsIndexPath());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      sessionsIndexPath(),
      JSON.stringify(
        { activeSessionId: this.activeSessionId, sessions: this._buildSessionIndex() },
        null,
        2,
      ),
    );
    this._backupLegacySessionsFileIfNeeded();
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
    this._deleteMessageFile(sessionId);
    this._deleteSummaryFile(sessionId);
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

  setAgentResumeId(sessionId, agentResumeId) {
    const session = this._find(sessionId);
    if (!session || !agentResumeId) return false;
    if (session.agentResumeId === agentResumeId) return true;
    session.agentResumeId = agentResumeId;
    this.save();
    return true;
  }

  clearAgentResumeId(sessionId) {
    const session = this._find(sessionId);
    if (!session || !session.agentResumeId) return false;
    delete session.agentResumeId;
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
