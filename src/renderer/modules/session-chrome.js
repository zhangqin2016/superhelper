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
import {
  hydrateRuntimeFromState,
  canSend,
  canInterrupt,
  getRuntimeSession,
} from "./session-runtime-store.js";
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

function resolveSessionStatus(sessionId) {
  if (!sessionId) {
    return { state: "idle", label: t("topbar.statusIdle") };
  }
  const runtime = getRuntimeSession(sessionId);
  const questionCount = runtime.liveTurn?.questions?.size || 0;
  if (questionCount > 0) {
    return { state: "waiting", label: t("topbar.statusWaiting") };
  }
  if (!canSend(sessionId)) {
    return {
      state: "running",
      label: canInterrupt(sessionId) ? t("topbar.statusRunning") : t("topbar.statusWaiting"),
    };
  }
  return { state: "idle", label: t("topbar.statusIdle") };
}

function formatSessionMeta(project) {
  const projects = store.get("projects") || [];
  if (project?.path) {
    const parts = String(project.path).split(/[/\\]/);
    const leaf = parts[parts.length - 1] || project.path;
    return t("topbar.workspacePath", { path: leaf });
  }
  if (project?.name) {
    return t("app.folderLabel", { name: project.name });
  }
  if (projects.length === 0) {
    return t("app.addWorkspace");
  }
  return t("topbar.statusHint");
}

export function updateTopbarTitles() {
  const project = activeProject();
  const session = activeSession();
  const sessionId = store.get("activeSessionId");
  const titleEl = $("projectTitle");
  const metaEl = $("sessionMeta");
  const statusEl = $("sessionStatus");

  if (titleEl) {
    titleEl.textContent = session?.title || project?.name || t("app.brand");
  }

  const status = resolveSessionStatus(sessionId);
  if (statusEl) {
    statusEl.hidden = !sessionId;
    statusEl.textContent = status.label;
    statusEl.className = `session-status-pill is-${status.state}`;
    statusEl.dataset.state = status.state;
  }

  if (metaEl) {
    metaEl.textContent = formatSessionMeta(project);
  }
}

function applyStatePayload(state) {
  if (!state) return;
  store.set("projects", state.projects || []);
  store.set("activeProjectId", state.activeProjectId);
  store.set("activeSessionId", state.activeSessionId);
  if (state.conversation) store.set("conversation", state.conversation);
  hydrateRuntimeFromState(state);

  const allSessions = [];
  for (const p of state.projects || []) {
    for (const s of p.sessions || []) {
      allSessions.push(s);
    }
  }
  store.set("sessions", allSessions);
}

function getVisibleSessionId() {
  const active = document.querySelector(".session-messages.is-active");
  return active?.dataset?.sessionId || null;
}

function patchSessionMessagesInStore(sessionId, messages) {
  if (!sessionId) return;
  const projects = store.get("projects") || [];
  let changed = false;
  for (const project of projects) {
    for (const session of project.sessions || []) {
      if (session.id === sessionId) {
        session.messages = messages || [];
        session.messageCount = session.messages.length;
        changed = true;
      }
    }
  }
  if (changed) store.set("projects", projects);
}

export async function applySessionSwitch(switchResult, nextSessionId, nextProjectId) {
  if (!switchResult?.ok || !nextSessionId) {
    const { showToast } = await import("./toast.js");
    showToast(switchResult?.detail || t("toast.switchSessionFailed"), "error");
    return;
  }

  if (nextProjectId) store.set("activeProjectId", nextProjectId);
  store.set("activeSessionId", nextSessionId);

  const messages = switchResult.conversation || [];
  store.set("conversation", messages);
  patchSessionMessagesInStore(nextSessionId, messages);

  showSessionMessages(nextSessionId);

  if (shouldPreserveSessionView(nextSessionId)) {
    resumeLiveSessionUi(nextSessionId);
  } else {
    renderConversation(nextSessionId, { force: true });
    resumeLiveSessionUi(nextSessionId);
  }

  syncComposerForActiveSession();
  updateTopbarTitles();
  const { clearPromptSuggestions } = await import("./composer.js");
  clearPromptSuggestions();
  await refreshSessionSkillsUi();

  const { updateProjectTreeChrome } = await import("./project-tree.js");
  updateProjectTreeChrome();
  const { refreshSessionPermissionSelect } = await import("./permission-settings.js");
  await refreshSessionPermissionSelect();
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
    const { refreshSessionPermissionSelect } = await import("./permission-settings.js");
    await refreshSessionPermissionSelect();
  } catch {
    // ignore
  }
}

export async function refreshState() {
  await refreshStateLight({ reRenderActive: true });
}
