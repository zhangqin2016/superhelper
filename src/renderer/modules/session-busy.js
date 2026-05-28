/**
 * Per-session busy state — each conversation can run its own Claude runner.
 */

import store from "./state.js";

function findSession(sessionId) {
  if (!sessionId) return null;
  for (const project of store.get("projects") || []) {
    const session = (project.sessions || []).find((s) => s.id === sessionId);
    if (session) return session;
  }
  return (store.get("sessions") || []).find((s) => s.id === sessionId) || null;
}

export function isSessionRunning(sessionId) {
  if (!sessionId) return false;
  const ids = store.get("runningSessionIds") || [];
  if (ids.includes(sessionId)) return true;
  return findSession(sessionId)?.status === "running";
}

export function setSessionRunning(sessionId, running) {
  if (!sessionId) return;
  const next = new Set(store.get("runningSessionIds") || []);
  if (running) next.add(sessionId);
  else next.delete(sessionId);
  store.set("runningSessionIds", [...next]);

  const session = findSession(sessionId);
  if (session) session.status = running ? "running" : "idle";
}

export function syncRunningFromState(state) {
  const ids = new Set(state?.runningSessionIds || []);
  for (const project of state?.projects || []) {
    for (const session of project.sessions || []) {
      if (session.status === "running") ids.add(session.id);
    }
  }
  store.set("runningSessionIds", [...ids]);
}

export function isActiveSessionBusy() {
  const sid = store.get("activeSessionId");
  return isSessionRunning(sid);
}
