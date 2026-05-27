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

    const active = this.getActive();
    if (!active) {
      const first = this.pm.getActive();
      const list = this._getProjectSessions(first.id);
      if (list.length > 0) {
        this.activeSessionId = list[0].id;
      }
    }
    this.save();
  }

  save() {
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

  getActive() {
    const projectId = this.pm.getActive().id;
    const list = this._getProjectSessions(projectId);
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
    }));
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
    this.save();
    return session;
  }

  switchTo(sessionId) {
    this.activeSessionId = sessionId;
    this.save();
  }

  rename(sessionId, title) {
    const session = this._find(sessionId);
    if (!session) return false;
    session.title = (title || "未命名").slice(0, 80);
    this.save();
    return true;
  }

  delete(sessionId) {
    const projectId = this.pm.getActive().id;
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

  pushMessage(role, content, files = null) {
    const session = this.getActive();
    if (!session) return;
    session.messages.push({
      role,
      content,
      files: files && files.length > 0 ? files : undefined,
      timestamp: new Date().toISOString(),
    });
    session.updatedAt = new Date().toISOString();
    // Keep last 200 messages max
    if (session.messages.length > 200) {
      session.messages = session.messages.slice(-200);
    }
    this.save();
  }

  getConversation(sessionId) {
    const session = sessionId ? this._find(sessionId) : this.getActive();
    return session ? session.messages : [];
  }

  clearConversation(sessionId) {
    const session = this._find(sessionId) || this.getActive();
    if (!session) return;
    session.messages = [];
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
