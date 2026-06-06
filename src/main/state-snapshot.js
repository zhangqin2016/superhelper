"use strict";

function buildFullStateSnapshot({
  projectState,
  sessionManager,
  runnerPool,
  getRuntimeSnapshot,
  agent,
  cliPath,
  cliReady,
  models,
  permissions,
}) {
  const projectsWithSessions = (projectState.projects || []).map((project) => ({
    ...project,
    sessions: sessionManager.listForProject(project.id).map(({ messages, ...summary }) => summary),
  }));

  return {
    activeProjectId: projectState.activeProjectId,
    activeSessionId: sessionManager.activeSessionId,
    projects: projectsWithSessions,
    conversation: [],
    runtime: {
      sessions: Object.fromEntries(
        runnerPool.getSessionIds().map((sessionId) => [
          sessionId,
          getRuntimeSnapshot(sessionId),
        ]),
      ),
    },
    runnerSessionIds: runnerPool.getSessionIds(),
    agent: {
      ...(agent || { ok: false }),
      ok: Boolean(cliReady),
      cliPath: cliPath || agent?.cliPath || null,
      ready: Boolean(cliReady),
    },
    models,
    permissions,
  };
}

module.exports = {
  buildFullStateSnapshot,
};
