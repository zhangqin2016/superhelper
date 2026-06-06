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
  sessionMessagesDir,
  sessionsConfigPath,
  sessionsIndexPath,
} = require("./config");
const { normalizeSessionPermissionMode } = require("./permission-settings");

const DEFAULT_CONVERSATION_LIMIT = 50;

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
    this._dirtyMessageSessionIds = new Set();
    this._legacyMigrationPending = false;
  }

  load() {
    this._loadPersistedStore();

    // Ensure each project has at least one session
    for (const project of this.pm.projects) {
      const projectSessions = this._getProjectSessions(project.id);
      if (projectSessions.length === 0) {
        this.create(project.id, "默认对话");
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
    this.saveImmediate();
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
      title: session?.title || "默认对话",
      createdAt: session?.createdAt || new Date().toISOString(),
      updatedAt: session?.updatedAt || new Date().toISOString(),
      status: session?.status || "idle",
      messageCount: Number.isInteger(session?.messageCount)
        ? session.messageCount
        : messages?.length || 0,
    };
    delete normalized.messages;
    if (messages) {
      normalized.messages = messages;
      normalized.messageCount = messages.length;
      this._dirtyMessageSessionIds.add(normalized.id);
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

  _safeMessageFileName(sessionId) {
    return `${String(sessionId || "").replace(/[^a-zA-Z0-9._-]/g, "_")}.json`;
  }

  _messageFilePath(sessionId) {
    return path.join(sessionMessagesDir(), this._safeMessageFileName(sessionId));
  }

  _loadMessages(session) {
    if (!session) return [];
    if (Array.isArray(session.messages)) return session.messages;
    const filePath = this._messageFilePath(session.id);
    const parsed = this._readJson(filePath);
    const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
    session.messages = messages;
    session.messageCount = messages.length;
    return session.messages;
  }

  _markMessagesDirty(session) {
    if (session?.id) this._dirtyMessageSessionIds.add(session.id);
  }

  _deleteMessageFile(sessionId) {
    try {
      fs.rmSync(this._messageFilePath(sessionId), { force: true });
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
      title: "默认对话",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "idle",
      messages: [],
      messageCount: 0,
    };
    if (!this.sessions[projectId]) this.sessions[projectId] = [];
    this.sessions[projectId].push(session);
    if (!this.activeSessionId) this.activeSessionId = session.id;
    this._markMessagesDirty(session);
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

    for (const project of this.pm.projects) {
      this.ensureDefaultForProject(project.id);
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
    this._writeDirtyMessageFiles();
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

  _writeDirtyMessageFiles() {
    if (this._dirtyMessageSessionIds.size === 0) return;
    fs.mkdirSync(sessionMessagesDir(), { recursive: true });
    for (const sessionId of [...this._dirtyMessageSessionIds]) {
      const session = this._find(sessionId, { loadMessages: false });
      if (!session) {
        this._deleteMessageFile(sessionId);
        this._dirtyMessageSessionIds.delete(sessionId);
        continue;
      }
      const messages = Array.isArray(session.messages)
        ? session.messages
        : this._loadMessages(session);
      session.messages = messages;
      session.messageCount = messages.length;
      fs.writeFileSync(
        this._messageFilePath(session.id),
        JSON.stringify({ sessionId: session.id, messages }, null, 2),
        "utf8",
      );
      this._dirtyMessageSessionIds.delete(sessionId);
    }
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
    if (session) this._loadMessages(session);
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
      title: (title || "新对话").slice(0, 80),
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
    this._markMessagesDirty(session);
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
    session.title = (title || "未命名").slice(0, 80);
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

  /** Last user message in this session (for retry). */
  getLastUserMessage(sessionId) {
    const session = this._find(sessionId);
    if (!session) return null;
    const messages = this._loadMessages(session);
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      if (msg.role === "user") return msg;
    }
    return null;
  }

  /** Remove trailing assistant message (failed turn before retry). */
  popLastAssistantMessage(sessionId) {
    const session = this._find(sessionId);
    const messages = this._loadMessages(session);
    if (!session || messages.length === 0) return false;
    const last = messages[messages.length - 1];
    if (last.role !== "assistant") return false;
    messages.pop();
    session.messageCount = messages.length;
    session.updatedAt = new Date().toISOString();
    this._markMessagesDirty(session);
    this.save();
    return true;
  }

  /** Remove the last message if it is from the user (e.g. send to CLI failed). */
  popLastUserMessage(sessionId) {
    const session = this._find(sessionId);
    const messages = this._loadMessages(session);
    if (!session || messages.length === 0) return false;
    const last = messages[messages.length - 1];
    if (last.role !== "user") return false;
    messages.pop();
    session.messageCount = messages.length;
    session.updatedAt = new Date().toISOString();
    this._markMessagesDirty(session);
    this.save();
    return true;
  }

  _appendMessage(session, role, content, files = null, extra = null) {
    const entry = {
      id: extra?.id,
      role,
      content,
      files: files && files.length > 0 ? files : undefined,
      turnId: extra?.turnId,
      timestamp: new Date().toISOString(),
    };
    if (extra?.failed) entry.failed = true;
    if (extra?.meta && typeof extra.meta === "object") entry.meta = extra.meta;
    if (extra?.record && typeof extra.record === "object") entry.record = extra.record;
    const messages = this._loadMessages(session);
    messages.push(entry);
    session.updatedAt = new Date().toISOString();
    session.messages = messages;
    session.messageCount = session.messages.length;
    this._markMessagesDirty(session);
    this.save();
  }

  getConversation(sessionId) {
    const session = sessionId ? this._find(sessionId) : this.getActive();
    return session ? this._loadMessages(session) : [];
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
    const messages = this._loadMessages(session);
    const total = messages.length;
    const limit = Math.max(1, Math.min(Number(opts.limit) || DEFAULT_CONVERSATION_LIMIT, 200));
    const beforeRaw = Number.isInteger(opts.before) ? opts.before : total;
    const before = Math.max(0, Math.min(beforeRaw, total));
    const start = Math.max(0, before - limit);
    return {
      ok: true,
      sessionId: session.id,
      projectId: session.projectId,
      conversation: messages.slice(start, before),
      hasMore: start > 0,
      before,
      nextBefore: start,
      total,
    };
  }

  findById(sessionId) {
    return this._find(sessionId);
  }

  clearConversation(sessionId) {
    const session = this._find(sessionId) || this.getActive();
    if (!session) return;
    session.messages = [];
    session.messageCount = 0;
    delete session.agentResumeId;
    this._deleteSummaryFile(session.id);
    this._markMessagesDirty(session);
    this.save();
  }

  _find(sessionId, opts = {}) {
    const loadMessages = opts.loadMessages !== false;
    for (const list of Object.values(this.sessions)) {
      const found = list.find((s) => s.id === sessionId);
      if (found) {
        if (loadMessages) this._loadMessages(found);
        return found;
      }
    }
    return null;
  }

  _getProjectSessions(projectId) {
    if (!this.sessions[projectId]) this.sessions[projectId] = [];
    return this.sessions[projectId].filter((s) => s.status !== "archived");
  }
}

module.exports = SessionManager;
