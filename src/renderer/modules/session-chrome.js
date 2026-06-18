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
  syncCommittedMessages,
} from "./session-runtime-store.js";
import { refreshSessionSkillsUi } from "./session-skills.js";
import { hydrateBlobRefs } from "./blob-refs.js";

const CONVERSATION_PAGE_SIZE = 50;
const conversationPages = new Map();

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

async function loadSessionConversation(sessionId) {
  if (!sessionId) return [];
  let result;
  try {
    result = await window.assistantClient.getSessionConversation(sessionId, {
      limit: CONVERSATION_PAGE_SIZE,
    });
  } catch (err) {
    console.warn("[session] failed to load conversation:", err);
    return getRuntimeSession(sessionId).committedMessages;
  }
  if (!result?.ok) {
    console.warn("[session] failed to load conversation:", result?.error || result);
    return getRuntimeSession(sessionId).committedMessages;
  }
  const messages = (result.conversation || []).map(hydrateBlobRefs);
  conversationPages.set(sessionId, {
    hasMore: Boolean(result?.hasMore),
    nextBefore: Number.isInteger(result?.nextBefore) ? result.nextBefore : 0,
    loading: false,
  });
  store.set("conversation", messages);
  patchSessionMessagesInStore(sessionId, messages);
  syncCommittedMessages(sessionId, messages);
  return messages;
}

export async function loadOlderConversationForSession(sessionId, panel = null) {
  if (!sessionId) return false;
  const page = conversationPages.get(sessionId);
  if (!page?.hasMore || page.loading) return false;
  page.loading = true;
  const beforeHeight = panel?.scrollHeight || 0;
  const beforeTop = panel?.scrollTop || 0;
  try {
    const result = await window.assistantClient.getSessionConversation(sessionId, {
      before: page.nextBefore,
      limit: CONVERSATION_PAGE_SIZE,
    });
    if (!result?.ok || !result.conversation?.length) {
      page.hasMore = false;
      return false;
    }
    const runtime = getRuntimeSession(sessionId);
    const merged = [...result.conversation.map(hydrateBlobRefs), ...runtime.committedMessages];
    conversationPages.set(sessionId, {
      hasMore: Boolean(result.hasMore),
      nextBefore: Number.isInteger(result.nextBefore) ? result.nextBefore : 0,
      loading: false,
    });
    store.set("conversation", merged);
    patchSessionMessagesInStore(sessionId, merged);
    syncCommittedMessages(sessionId, merged);
    const { renderConversation } = await import("./message.js");
    renderConversation(sessionId, { force: true, preserveScroll: true });
    if (panel) {
      requestAnimationFrame(() => {
        panel.scrollTop = panel.scrollHeight - beforeHeight + beforeTop;
      });
    }
    return true;
  } finally {
    const latest = conversationPages.get(sessionId);
    if (latest) latest.loading = false;
  }
}

export async function applySessionSwitch(switchResult, nextSessionId, nextProjectId) {
  if (!switchResult?.ok || !nextSessionId) {
    const { showToast } = await import("./toast.js");
    showToast(switchResult?.detail || t("toast.switchSessionFailed"), "error");
    return;
  }

  if (nextProjectId) store.set("activeProjectId", nextProjectId);
  store.set("activeSessionId", nextSessionId);

  await loadSessionConversation(nextSessionId);

  showSessionMessages(nextSessionId);
  updateTopbarTitles();
  if (shouldPreserveSessionView(nextSessionId)) {
    resumeLiveSessionUi(nextSessionId, { forceScrollBottom: true });
  } else {
    renderConversation(nextSessionId, { force: true, forceScrollBottom: true });
    resumeLiveSessionUi(nextSessionId, { forceScrollBottom: true });
  }

  syncComposerForActiveSession();
  const { clearPromptSuggestions } = await import("./composer.js");
  clearPromptSuggestions();

  const { updateProjectTreeChrome } = await import("./project-tree.js");
  updateProjectTreeChrome();
  void refreshSessionSkillsUi();
  void import("./permission-settings.js").then((m) => m.refreshSessionPermissionSelect());
}

/** Refresh store from main; optionally rebuild active session chat from disk. */
export async function refreshStateLight({ reRenderActive = false } = {}) {
  try {
    const state = await window.assistantClient.getFullState();
    applyStatePayload(state);

    const sid = state?.activeSessionId;
    if (sid) {
      await loadSessionConversation(sid);
      showSessionMessages(sid);
      if (reRenderActive) {
        if (shouldPreserveSessionView(sid)) {
          resumeLiveSessionUi(sid, { forceScrollBottom: true });
        } else {
          renderConversation(sid, { force: true, forceScrollBottom: true });
        }
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
    return state;
  } catch {
    // ignore
    return null;
  }
}

export async function refreshState() {
  return refreshStateLight({ reRenderActive: true });
}
