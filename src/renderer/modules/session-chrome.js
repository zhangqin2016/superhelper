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
  isConversationRenderCurrent,
  resumeLiveSessionUi,
  syncComposerForActiveSession,
} from "./message.js";
import {
  hydrateRuntimeFromState,
  canSend,
  canInterrupt,
  getRuntimeSession,
  syncCommittedMessages,
  clearSessionAttention,
} from "./session-runtime-store.js";
import { refreshSessionSkillsUi } from "./session-skills.js";
import { hydrateBlobRefs } from "./blob-refs.js";
import {
  mergeLatestConversationPage,
  mergeOlderConversationPage,
  shouldContinueLoadingOlder,
} from "./conversation-pagination.js";

const CONVERSATION_PAGE_SIZE = 50;
const conversationPages = new Map();
let sessionSwitchSeq = 0;

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

function patchSessionMessagesInStore(sessionId, messages, total) {
  if (!sessionId) return;
  const projects = store.get("projects") || [];
  let changed = false;
  for (const project of projects) {
    for (const session of project.sessions || []) {
      if (session.id === sessionId) {
        session.messages = messages || [];
        // Keep the TRUE total (the conversation is paginated — only the latest
        // page is loaded here, so messages.length is just the page size). Using
        // the page size would make the sidebar count drop, e.g. 325 → 50.
        session.messageCount = Number.isInteger(total) ? total : session.messages.length;
        changed = true;
      }
    }
  }
  if (changed) store.set("projects", projects);
}

async function loadSessionConversation(sessionId, opts = {}) {
  if (!sessionId) return [];
  let result;
  try {
    result = await window.assistantClient.getSessionConversation(sessionId, {
      limit: CONVERSATION_PAGE_SIZE,
      preferLocal: true,
    });
  } catch (err) {
    console.warn("[session] failed to load conversation:", err);
    return getRuntimeSession(sessionId).committedMessages;
  }
  if (!result?.ok) {
    console.warn("[session] failed to load conversation:", result?.error || result);
    return getRuntimeSession(sessionId).committedMessages;
  }
  const officialMessages = (result.conversation || []).map(hydrateBlobRefs);
  const localMessages = getRuntimeSession(sessionId).committedMessages || [];
  const messages = mergeLatestConversationPage(localMessages, officialMessages);
  conversationPages.set(sessionId, {
    hasMore: Boolean(result?.hasMore),
    nextBefore: Number.isInteger(result?.nextBefore) ? result.nextBefore : 0,
    total: Number.isInteger(result?.total) ? result.total : messages.length,
    loading: false,
  });
  if (typeof opts.isCurrent === "function" && !opts.isCurrent()) {
    return messages;
  }
  store.set("conversation", messages);
  patchSessionMessagesInStore(sessionId, messages, result.total);
  syncCommittedMessages(sessionId, messages);
  if (result?.officialRefreshRecommended) {
    refreshOfficialConversation(sessionId, opts).catch((err) => {
      console.warn("[session] failed to refresh official conversation:", err);
    });
  }
  return messages;
}

async function refreshOfficialConversation(sessionId, opts = {}) {
  if (!sessionId) return false;
  const result = await window.assistantClient.getSessionConversation(sessionId, {
    limit: CONVERSATION_PAGE_SIZE,
    // Reconciling official history on switch must not boot the engine (the
    // few-second stall). If the runner is already warm we get official history
    // for free; if it's cold we keep the local store and let the next send
    // resume the engine and reconcile.
    allowEngineSpawn: false,
  });
  if (!result?.ok || result.source === "lily-local-first") return false;
  if (typeof opts.isCurrent === "function" && !opts.isCurrent()) return false;
  const officialMessages = (result.conversation || []).map(hydrateBlobRefs);
  const localMessages = getRuntimeSession(sessionId).committedMessages || [];
  const messages = mergeLatestConversationPage(localMessages, officialMessages);
  const previousPage = conversationPages.get(sessionId);
  const nextBefore = Number.isInteger(result?.nextBefore)
    ? result.nextBefore
    : Number.isInteger(previousPage?.nextBefore)
      ? previousPage.nextBefore
      : 0;
  const total = Math.max(
    Number.isInteger(result?.total) ? result.total : 0,
    Number.isInteger(previousPage?.total) ? previousPage.total : 0,
    messages.length,
  );
  conversationPages.set(sessionId, {
    hasMore: Boolean(result?.hasMore || previousPage?.hasMore),
    nextBefore,
    total,
    loading: false,
  });
  store.set("conversation", messages);
  patchSessionMessagesInStore(sessionId, messages, total);
  syncCommittedMessages(sessionId, messages);
  const { renderConversation, isSessionViewAtBottom } = await import("./message.js");
  // Stick to the latest if the user is still at the bottom (the first-open case:
  // we just scrolled there). Blind preserveScroll drifts a few messages up here
  // because the refreshed history has a different height than the local-first
  // render. Only preserve position when the user has scrolled up to read.
  const atBottom = isSessionViewAtBottom(sessionId);
  renderConversation(sessionId, { force: true, forceScrollBottom: atBottom, preserveScroll: !atBottom });
  resumeLiveSessionUi(sessionId, { forceScrollBottom: atBottom });
  return true;
}

function revealSessionView(sessionId, { forceScrollBottom = true } = {}) {
  showSessionMessages(sessionId);
  updateTopbarTitles();
  if (shouldPreserveSessionView(sessionId) || isConversationRenderCurrent(sessionId)) {
    resumeLiveSessionUi(sessionId, { forceScrollBottom });
    return;
  }
  renderConversation(sessionId, { force: true, forceScrollBottom });
  resumeLiveSessionUi(sessionId, { forceScrollBottom });
}

export async function loadOlderConversationForSession(sessionId, panel = null) {
  if (!sessionId) return false;
  const page = conversationPages.get(sessionId);
  if (!page?.hasMore || page.loading) return false;
  page.loading = true;
  const beforeHeight = panel?.scrollHeight || 0;
  const beforeTop = panel?.scrollTop || 0;
  try {
    let cursor = page.nextBefore;
    const runtime = getRuntimeSession(sessionId);
    let merged = runtime.committedMessages;
    let total = null;
    let loadedAny = false;
    let hasMore = page.hasMore;
    do {
      const previousCount = merged.length;
      const result = await window.assistantClient.getSessionConversation(sessionId, {
        before: cursor,
        limit: CONVERSATION_PAGE_SIZE,
      });
      if (!result?.ok || !result.conversation?.length) {
        hasMore = false;
        break;
      }
      const older = result.conversation.map(hydrateBlobRefs);
      merged = mergeOlderConversationPage(older, merged);
      total = Number.isInteger(result.total) ? result.total : total;
      hasMore = Boolean(result.hasMore);
      cursor = Number.isInteger(result.nextBefore) ? result.nextBefore : 0;
      loadedAny = true;
      if (!shouldContinueLoadingOlder({
        hasMore,
        pageSize: older.length,
        previousCount,
        mergedCount: merged.length,
      })) {
        break;
      }
    } while (hasMore);

    if (!loadedAny) {
      conversationPages.set(sessionId, { hasMore: false, nextBefore: 0, loading: false });
      return false;
    }
    conversationPages.set(sessionId, {
      hasMore,
      nextBefore: cursor,
      total: Number.isInteger(total) ? total : merged.length,
      loading: false,
    });
    store.set("conversation", merged);
    patchSessionMessagesInStore(sessionId, merged, total);
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
  clearSessionAttention(nextSessionId); // viewing it clears the list "finished" flag
  const switchSeq = ++sessionSwitchSeq;

  // Reveal immediately from the in-memory/runtime cache. The canonical page can
  // be slower (SQLite/OpenCode IPC/blob hydration), and should not block the
  // user's visual navigation between conversations.
  revealSessionView(nextSessionId, { forceScrollBottom: true });

  syncComposerForActiveSession();
  const { clearPromptSuggestions } = await import("./composer.js");
  clearPromptSuggestions();

  const { updateProjectTreeChrome } = await import("./project-tree.js");
  updateProjectTreeChrome();
  void refreshSessionSkillsUi();
  void import("./permission-settings.js").then((m) => m.refreshSessionPermissionSelect());

  void loadSessionConversation(nextSessionId, {
    isCurrent: () => sessionSwitchSeq === switchSeq && store.get("activeSessionId") === nextSessionId,
  }).then((messages) => {
    if (sessionSwitchSeq !== switchSeq || store.get("activeSessionId") !== nextSessionId) return;
    if (messages?.length) revealSessionView(nextSessionId, { forceScrollBottom: true });
  });
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
