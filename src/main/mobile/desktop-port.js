"use strict";

/**
 * The ONE adapter between Mobile Command and the rest of the desktop.
 *
 * Everything the phone layers need from Lily — sessions, workspaces, the
 * orchestrator's sanctioned seams, the conversation as the chat view shows it,
 * attachment storage — goes through this port. The controllers and the mirror
 * depend on this shape, not on `ctx`, so they are tested against a fake port
 * and a change inside Lily touches this file only.
 */

const { DEFAULT_LIMIT } = require("./conversation-view");

function createDesktopPort(ctx, { tmpDir, log = { warn() {} } } = {}) {
  const sessions = () => ctx.sessionManager;
  const projects = () => ctx.projectManager;

  function safe(fn, fallback) {
    try { return fn(); } catch { return fallback; }
  }

  return {
    activeProjectId: () => safe(() => projects()?.getActive?.()?.id || "", ""),
    activeSessionId: () => safe(() => sessions()?.getActive?.()?.id || "", ""),
    findProject: (id) => safe(() => (id ? projects()?.find?.(id) || null : null), null),
    findSession: (id) => safe(() => (id ? sessions()?.findById?.(id) || null : null), null),

    listProjects() {
      const state = safe(() => projects()?.getAppState?.() || null, null) || { projects: [] };
      return (state.projects || [])
        .map((p) => ({ id: String(p.id || ""), name: String(p.name || p.title || p.path || "") }))
        .filter((p) => p.id);
    },

    listSessions(projectId) {
      const list = safe(() => (projectId ? sessions()?.listForProject?.(projectId) || [] : []), []);
      return list
        .map((s) => ({
          id: String(s.id || ""),
          title: String(s.title || ""),
          updatedAt: s.updatedAt || "",
          messageCount: Number.isInteger(s.messageCount) ? s.messageCount : 0,
        }))
        .filter((s) => s.id);
    },

    /** The orchestrator's live view of a session: phase, running turn, queue. */
    turnState(sessionId) {
      const snap = safe(() => ctx.turnOrchestrator?.snapshot?.(sessionId) || {}, {});
      const running = Boolean(snap.phase && snap.phase !== "idle");
      return {
        phase: String(snap.phase || ""),
        runningTurnId: running ? String(snap.turnId || "") : "",
        canInterrupt: Boolean(snap.canInterrupt),
        queueLength: Number(snap.queueLength || 0),
      };
    },

    /**
     * The phone command a turn was admitted from ("" for a desktop-typed turn),
     * read from the turn's own admission record.
     */
    turnCommandId(sessionId, turnId) {
      return safe(() => String(sessions()?.getTurnInputByTurnId?.(sessionId, turnId)?.externalCommandId || ""), "");
    },

    /**
     * The conversation exactly as the desktop's chat view reads it — local
     * first, never booting the engine for a phone's read.
     */
    async readConversation(sessionId, { limit = DEFAULT_LIMIT } = {}) {
      const { getConversationPageFromSource } = require("../opencode-conversation-source");
      const page = await getConversationPageFromSource(ctx, sessionId, {
        limit: Math.max(limit * 2, 60),
        preferLocal: true,
        allowEngineSpawn: false,
      });
      return Array.isArray(page?.conversation) ? page.conversation : [];
    },

    /** The only way a phone's task enters a session (never sendUserMessage). */
    admit(envelope) {
      return ctx.turnOrchestrator.admitExternalCommand(envelope);
    },

    /** Stop the running turn; the queue is kept. */
    interrupt(sessionId) {
      return ctx.turnOrchestrator.interrupt(sessionId, { clearQueue: false });
    },

    /** Write phone-sent images to disk so the turn gets real file paths. */
    materializeAttachments(attachments) {
      try {
        const { materializeMobileAttachments } = require("./attachments");
        return materializeMobileAttachments(attachments, { tmpDir, stamp: String(Date.now()) });
      } catch (err) {
        log.warn("mobile attachment materialize failed: %s", err?.message || err);
        return [];
      }
    },

    /** Observe runtime events of every session (passive; errors isolated by the bus). */
    observeRuntime(listener) {
      return ctx.eventBus?.addObserver?.(listener) || (() => {});
    },
  };
}

module.exports = { createDesktopPort };
