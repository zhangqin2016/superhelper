"use strict";

/**
 * Workspace-scoped memory IPC: confirmed long-term preferences, memory
 * proposals and per-category switches. Memory is kept per workspace; requests
 * address a workspace directly (`projectId`) or through a session.
 */
const { ipcMain } = require("electron");

function resolveTargetSession(sessionManager, requestedId) {
  if (!requestedId) return null;
  return sessionManager.findById(requestedId);
}

function registerMemoryHandlers({ sessionManager, projectManager }, { refreshSessionGuide }) {
  // Memory is kept per workspace. A request names the workspace directly
  // (`projectId`, from the memory page's workspace picker or a workspace's
  // context menu) or indirectly through a session; the session, when there is
  // one for that workspace, is what gets its guide refreshed afterwards.
  function resolveMemoryTarget(payload) {
    const requestedProject = String(payload?.projectId || "").trim();
    const session = resolveTargetSession(sessionManager, payload?.sessionId || null);
    if (requestedProject) {
      if (!projectManager?.find?.(requestedProject)) return null;
      let bound = session && session.projectId === requestedProject ? session : null;
      if (!bound && typeof sessionManager.listForProject === "function") {
        const first = sessionManager.listForProject(requestedProject)[0];
        bound = first ? sessionManager.findById(first.id) : null;
      }
      return { projectId: requestedProject, session: bound };
    }
    if (!session) return null;
    return { projectId: session.projectId || null, session };
  }

  ipcMain.handle("assistant:memory:list", (_event, payload) => {
    const target = resolveMemoryTarget(payload);
    const session = target?.session || null;
    const projectId = target?.projectId || null;
    if (!projectId) return { ok: false, error: "NO_SESSION" };
    const { listLearnedConventions } = require("./learned-context");
    const { listMemoryProposals } = require("./auto-memory-proposals");
    const { MEMORY_CATEGORIES, readMemoryPreferences } = require("./memory-preferences");
    return {
      ok: true,
      sessionId: session?.id || null,
      projectId: projectId,
      learned: listLearnedConventions(projectId),
      proposals: listMemoryProposals(projectId, {
        includeDismissed: Boolean(payload?.includeDismissed),
      }),
      preferences: readMemoryPreferences(projectId),
      categories: MEMORY_CATEGORIES,
    };
  });

  ipcMain.handle("assistant:memory:set-category-enabled", (_event, payload) => {
    const target = resolveMemoryTarget(payload);
    const session = target?.session || null;
    const projectId = target?.projectId || null;
    const kind = String(payload?.kind || "");
    if (!projectId) return { ok: false, error: "NO_SESSION" };
    if (!kind) return { ok: false, error: "INVALID_PAYLOAD" };
    const { setMemoryCategoryEnabled } = require("./memory-preferences");
    const preferences = setMemoryCategoryEnabled(projectId, kind, Boolean(payload?.enabled));
    if (!preferences) return { ok: false, error: "INVALID_KIND" };
    if (session) refreshSessionGuide(projectManager, session);
    return {
      ok: true,
      sessionId: session?.id || null,
      projectId: projectId,
      preferences,
    };
  });

  ipcMain.handle("assistant:memory:export", (_event, payload) => {
    const target = resolveMemoryTarget(payload);
    const session = target?.session || null;
    const projectId = target?.projectId || null;
    if (!projectId) return { ok: false, error: "NO_SESSION" };
    const { listLearnedConventions } = require("./learned-context");
    const { listMemoryProposals } = require("./auto-memory-proposals");
    const { readSessionSummary } = require("./session-memory");
    return {
      ok: true,
      exportedAt: new Date().toISOString(),
      sessionId: session?.id || null,
      projectId: projectId,
      memory: {
        learned: listLearnedConventions(projectId),
        proposals: listMemoryProposals(projectId, { includeDismissed: true }),
        sessionSummary: session ? readSessionSummary(session.id) || null : null,
      },
    };
  });

  ipcMain.handle("assistant:memory:remove-learned", (_event, payload) => {
    const target = resolveMemoryTarget(payload);
    const session = target?.session || null;
    const projectId = target?.projectId || null;
    const key = String(payload?.key || "");
    if (!projectId) return { ok: false, error: "NO_SESSION" };
    if (!key) return { ok: false, error: "INVALID_PAYLOAD" };
    const { removeLearnedConvention } = require("./learned-context");
    const removed = removeLearnedConvention(projectId, key);
    if (!removed) return { ok: false, error: "NOT_FOUND" };
    if (session) refreshSessionGuide(projectManager, session);
    return {
      ok: true,
      sessionId: session?.id || null,
      projectId: projectId,
      removed,
    };
  });

  ipcMain.handle("assistant:memory:clear-learned", (_event, payload) => {
    const target = resolveMemoryTarget(payload);
    const session = target?.session || null;
    const projectId = target?.projectId || null;
    if (!projectId) return { ok: false, error: "NO_SESSION" };
    const { clearLearnedConventions } = require("./learned-context");
    clearLearnedConventions(projectId);
    if (session) refreshSessionGuide(projectManager, session);
    return {
      ok: true,
      sessionId: session?.id || null,
      projectId: projectId,
    };
  });

  ipcMain.handle("assistant:memory-proposals:list", (_event, payload) => {
    const target = resolveMemoryTarget(payload);
    const session = target?.session || null;
    const projectId = target?.projectId || null;
    if (!projectId) return { ok: false, error: "NO_SESSION" };
    const { listMemoryProposals } = require("./auto-memory-proposals");
    return {
      ok: true,
      sessionId: session?.id || null,
      projectId: projectId,
      proposals: listMemoryProposals(projectId, {
        includeDismissed: Boolean(payload?.includeDismissed),
      }),
    };
  });

  ipcMain.handle("assistant:memory-proposals:approve", (_event, payload) => {
    const target = resolveMemoryTarget(payload);
    const session = target?.session || null;
    const projectId = target?.projectId || null;
    const key = String(payload?.key || "");
    if (!projectId) return { ok: false, error: "NO_SESSION" };
    if (!key) return { ok: false, error: "INVALID_PAYLOAD" };
    const { approveMemoryProposal } = require("./auto-memory-proposals");
    const proposal = approveMemoryProposal(projectId, key, { approvedBy: "user" });
    if (!proposal) return { ok: false, error: "NOT_FOUND" };
    if (session) refreshSessionGuide(projectManager, session);
    return {
      ok: true,
      sessionId: session?.id || null,
      projectId: projectId,
      proposal,
    };
  });

  ipcMain.handle("assistant:memory-proposals:dismiss", (_event, payload) => {
    const target = resolveMemoryTarget(payload);
    const session = target?.session || null;
    const projectId = target?.projectId || null;
    const key = String(payload?.key || "");
    if (!projectId) return { ok: false, error: "NO_SESSION" };
    if (!key) return { ok: false, error: "INVALID_PAYLOAD" };
    const { dismissMemoryProposal } = require("./auto-memory-proposals");
    const proposal = dismissMemoryProposal(projectId, key, { dismissedBy: "user" });
    if (!proposal) return { ok: false, error: "NOT_FOUND" };
    return {
      ok: true,
      sessionId: session?.id || null,
      projectId: projectId,
      proposal,
    };
  });

}

module.exports = { registerMemoryHandlers };
