"use strict";

/**
 * Manages conversation sessions within projects.
 * Each session has its own isolated conversation history and CLI context.
 * Persisted to userData/sessions.json.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { sessionsConfigPath } = require("./config");

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
  }

  load() {
    try {
      const raw = fs.readFileSync(sessionsConfigPath(), "utf8");
      const parsed = JSON.parse(raw);
      this.sessions = parsed.sessions || {};
      this.activeSessionId = parsed.activeSessionId || null;
    } catch {
      this.sessions = {};
    }

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
    const dir = path.dirname(sessionsConfigPath());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      sessionsConfigPath(),
      JSON.stringify(
        { activeSessionId: this.activeSessionId, sessions: this.sessions },
        null,
        2,
      ),
    );
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
    return list.find((s) => s.id === this.activeSessionId) || list[0] || null;
  }

  listForProject(projectId) {
    return this._getProjectSessions(projectId).map((s) => ({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      messageCount: s.messages.length,
      status: s.status,
      skillCustomized: s.enabledSkillIds != null && Array.isArray(s.enabledSkillIds),
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

  create(projectId, title) {
    const session = {
      id: crypto.randomUUID(),
      projectId,
      title: (title || "新对话").slice(0, 80),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "idle",
      messages: [],
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
    session.title = (title || "未命名").slice(0, 80);
    this.save();
    return true;
  }

  delete(sessionId) {
    const project = this.pm.getActive();
    if (!project) return "NOT_FOUND";
    const projectId = project.id;
    const list = this.sessions[projectId];
    if (!list || list.length <= 1) return "LAST_SESSION";
    const idx = list.findIndex((s) => s.id === sessionId);
    if (idx === -1) return "NOT_FOUND";
    list.splice(idx, 1);
    if (this.activeSessionId === sessionId) {
      this.activeSessionId = list[Math.max(0, idx - 1)].id;
    }
    this.save();
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
    for (let i = session.messages.length - 1; i >= 0; i -= 1) {
      const msg = session.messages[i];
      if (msg.role === "user") return msg;
    }
    return null;
  }

  /** Remove trailing assistant message (failed turn before retry). */
  popLastAssistantMessage(sessionId) {
    const session = this._find(sessionId);
    if (!session || session.messages.length === 0) return false;
    const last = session.messages[session.messages.length - 1];
    if (last.role !== "assistant") return false;
    session.messages.pop();
    session.updatedAt = new Date().toISOString();
    this.save();
    return true;
  }

  /** Remove the last message if it is from the user (e.g. send to CLI failed). */
  popLastUserMessage(sessionId) {
    const session = this._find(sessionId);
    if (!session || session.messages.length === 0) return false;
    const last = session.messages[session.messages.length - 1];
    if (last.role !== "user") return false;
    session.messages.pop();
    session.updatedAt = new Date().toISOString();
    this.save();
    return true;
  }

  _appendMessage(session, role, content, files = null, extra = null) {
    const entry = {
      role,
      content,
      files: files && files.length > 0 ? files : undefined,
      timestamp: new Date().toISOString(),
    };
    if (extra?.failed) entry.failed = true;
    session.messages.push(entry);
    session.updatedAt = new Date().toISOString();
    if (session.messages.length > 200) {
      session.messages = session.messages.slice(-200);
    }
    this.save();
  }

  getConversation(sessionId) {
    const session = sessionId ? this._find(sessionId) : this.getActive();
    return session ? session.messages : [];
  }

  findById(sessionId) {
    return this._find(sessionId);
  }

  clearConversation(sessionId) {
    const session = this._find(sessionId) || this.getActive();
    if (!session) return;
    session.messages = [];
    delete session.agentResumeId;
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
