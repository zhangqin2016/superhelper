/**
 * Topbar / session switch chrome.
 */

import store from "./state.js";
import { $ } from "./dom.js";
import { t } from "../i18n/index.js";
import {
  showSessionMessages,
  hideAllSessionMessages,
  removeSessionMessages,
  renderConversation,
  shouldPreserveSessionView,
  resumeLiveSessionUi,
  syncComposerForActiveSession,
} from "./message.js";
import { syncRunningFromState } from "./session-busy.js";
import { refreshSessionSkillsUi } from "./session-skills.js";

export function activeProject() {
  const id = store.get("activeProjectId");
  if (!id) return null;
  return (store.get("projects") || []).find((p) => p.id === id) || null;
}

export function activeSession() {
  const sessionId = store.get("activeSessionId");
  if (!sessionId) return null;
  for (const project of store.get("projects") || []) {
    const session = (project.sessions || []).find((s) => s.id === sessionId);
    if (session) return session;
  }
  return null;
}

export function updateTopbarTitles() {
  const project = activeProject();
  const session = activeSession();
  const titleEl = $("projectTitle");
  const metaEl = $("sessionMeta");

  if (titleEl) {
    titleEl.textContent = session?.title || project?.name || t("app.brand");
  }
  if (metaEl && !store.get("isBusy")) {
    const projects = store.get("projects") || [];
    metaEl.textContent = project?.path
      ? project.path
      : project?.name
        ? t("app.folderLabel", { name: project.name })
        : projects.length === 0
          ? t("app.addWorkspace")
          : t("app.ready");
  }
}

function applyStatePayload(state) {
  if (!state) return;
  store.set("projects", state.projects || []);
  store.set("activeProjectId", state.activeProjectId);
  store.set("activeSessionId", state.activeSessionId);
  if (state.conversation) store.set("conversation", state.conversation);
  syncRunningFromState(state);

  const allSessions = [];
  for (const p of state.projects || []) {
    for (const s of p.sessions || []) {
      allSessions.push(s);
    }
  }
  store.set("sessions", allSessions);
}

export async function applySessionSwitch(switchResult, nextSessionId, nextProjectId) {
  if (!switchResult?.ok || !nextSessionId) return;

  if (nextProjectId) store.set("activeProjectId", nextProjectId);
  store.set("activeSessionId", nextSessionId);

  if (switchResult.conversation) {
    store.set("conversation", switchResult.conversation);
  }

  showSessionMessages(nextSessionId);

  if (shouldPreserveSessionView(nextSessionId)) {
    resumeLiveSessionUi(nextSessionId);
  } else {
    renderConversation(nextSessionId);
    resumeLiveSessionUi(nextSessionId);
  }

  syncComposerForActiveSession();
  updateTopbarTitles();
  await refreshSessionSkillsUi();

  const { updateProjectTreeChrome } = await import("./project-tree.js");
  updateProjectTreeChrome();
}

/** Refresh store from main; optionally rebuild active session chat from disk. */
export async function refreshStateLight({ reRenderActive = false } = {}) {
  try {
    const state = await window.assistantClient.getFullState();
    applyStatePayload(state);

    const sid = state?.activeSessionId;
    if (sid) {
      showSessionMessages(sid);
      if (reRenderActive && !shouldPreserveSessionView(sid)) {
        renderConversation(sid);
      }
      syncComposerForActiveSession();
    } else {
      hideAllSessionMessages();
      syncComposerForActiveSession();
    }

    updateTopbarTitles();
    const { updateProjectTreeChrome } = await import("./project-tree.js");
    updateProjectTreeChrome();
    await refreshSessionSkillsUi();
  } catch {
    // ignore
  }
}

export async function refreshState() {
  await refreshStateLight({ reRenderActive: true });
}
