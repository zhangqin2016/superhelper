import { t } from "../i18n/index.js";
import { renderCollaborationInbox } from "./collaboration-inbox.js";
import { renderCollaborationTimeline } from "./collaboration-timeline.js";
import { initCollaborationComposer } from "./collaboration-composer.js";
import { applyCollaborationHistoryPage } from "./collaboration-history-view.js";
import { refreshVisibleHistory } from "./collaboration-visible-history.js";

function byId(id) { return document.getElementById(id); }

/**
 * A deliberately thin shell: normal workbench DOM remains mounted and is only
 * visually switched, so turning the feature off restores the current chat
 * without destroying a running turn or composer state.
 */
export function initCollaborationCenter({ getPolicy = () => window.assistantClient?.getAppPolicy?.() } = {}) {
  const nav = byId("collaborationNavButton");
  const back = byId("workbenchNavButton");
  const shell = byId("centerPanel");
  const panel = byId("collaborationCenter");
  if (!nav || !back || !shell || !panel) return { refresh: async () => false };
  const status = byId("collaborationStatus");
  const live = byId("collaborationLive");
  const scopeBadge = byId("collaborationScopeBadge");
  const timeline = byId("collaborationTimeline");
  const empty = byId("collaborationConversationEmpty");
  const olderButton = byId("collaborationLoadOlder");
  let historyMessages = [];
  let nextBeforeSeq = null;
  let hasMore = false;
  let loadingOlder = false;
  let historyOffline = false;
  const acceptPage = (page, { latest = false, reset = false } = {}) => {
    const previous = reset ? {} : { messages: historyMessages, nextBeforeSeq, hasMore, offline: historyOffline };
    const next = applyCollaborationHistoryPage(previous, page, { latest });
    historyMessages = next.messages; nextBeforeSeq = next.nextBeforeSeq; hasMore = next.hasMore; historyOffline = next.offline;
  };
  const updateOlderButton = () => { if (olderButton) { olderButton.hidden = !hasMore || nextBeforeSeq == null; olderButton.disabled = loadingOlder || opening; } };
  let activeConversationId = "";
  let bootstrapAttempted = false;
  let viewGeneration = 0;
  let openGeneration = 0;
  let opening = false;
  const composer = initCollaborationComposer({
    textarea: byId("collaborationComposer"), sendButton: byId("collaborationSendButton"),
    getConversationId: () => activeConversationId,
    onSent: (_result, origin) => { if (!opening && activeConversationId && origin?.conversationId === activeConversationId) void openConversation(activeConversationId); },
    onError: () => { if (live) live.textContent = t("collaboration.sendFailed"); },
  });

  const openConversation = async (conversationId) => {
    const generation = ++openGeneration;
    const view = viewGeneration;
    opening = true;
    loadingOlder = false;
    updateOlderButton();
    const opened = await window.assistantClient?.collaboration?.open?.(conversationId).catch(() => null);
    let refreshFailed = false;
    if (opened?.ok && activeConversationId === conversationId && generation === openGeneration && view === viewGeneration) {
      try {
        const refreshed = await refreshVisibleHistory({ conversationId, existing: historyMessages, latest: opened.messages || [],
          readMessages: window.assistantClient?.collaboration?.readMessages, isCurrent: () => generation === openGeneration && view === viewGeneration });
        if (refreshed) historyMessages = refreshed;
      } catch { refreshFailed = true; }
    }
    if (generation === openGeneration) { opening = false; updateOlderButton(); }
    if (!opened?.ok || generation !== openGeneration || view !== viewGeneration) return;
    const sameConversation = activeConversationId === conversationId;
    activeConversationId = conversationId;
    acceptPage(opened, { latest: true, reset: !sameConversation });
    loadingOlder = false;
    updateOlderButton();
    composer.setConversation(conversationId);
    const scope = String(opened.conversation?.scopeId || "");
    if (scopeBadge) scopeBadge.textContent = t(scope.startsWith("team:") ? "collaboration.scopeTeam" : "collaboration.scopePersonal");
    renderCollaborationTimeline(timeline, historyMessages);
    if (empty) empty.hidden = historyMessages.length > 0;
    if (live) live.textContent = refreshFailed ? t("collaboration.historyLoadFailed") : String(opened.conversation?.title || t("collaboration.conversation"));
    if (status) status.textContent = t(opened.offline ? "collaboration.offlineCache" : "collaboration.statusAvailable");
  };

  const loadOlder = async () => {
    if (loadingOlder || opening || !activeConversationId || !hasMore || nextBeforeSeq == null) return;
    const conversationId = activeConversationId, view = viewGeneration, generation = openGeneration, cursor = nextBeforeSeq;
    loadingOlder = true; updateOlderButton();
    const page = await window.assistantClient?.collaboration?.open?.(conversationId, cursor).catch(() => null);
    if (view !== viewGeneration || generation !== openGeneration || conversationId !== activeConversationId) return;
    loadingOlder = false;
    if (!page?.ok || (page.hasMore && !(page.nextBeforeSeq > 0 && page.nextBeforeSeq < cursor))) {
      if (live) live.textContent = t("collaboration.historyLoadFailed");
    } else {
      acceptPage(page);
      renderCollaborationTimeline(timeline, historyMessages);
      if (status) status.textContent = t(page.offline ? "collaboration.offlineCache" : "collaboration.statusAvailable");
    }
    updateOlderButton();
  };
  olderButton?.addEventListener("click", loadOlder);

  const setActive = (active) => {
    shell.classList.toggle("collaboration-active", active);
    panel.hidden = !active;
    nav.setAttribute("aria-current", active ? "page" : "false");
    if (active) byId("collaborationInboxColumn")?.focus?.();
  };
  const load = async () => {
    const view = viewGeneration;
    let result = await window.assistantClient?.collaboration?.list?.().catch(() => null);
    if (view !== viewGeneration) return;
    if (!bootstrapAttempted && result?.ok === true && Array.isArray(result.conversations) && result.conversations.length === 0) {
      bootstrapAttempted = true;
      await window.assistantClient?.collaboration?.bootstrap?.().catch(() => null);
      result = await window.assistantClient?.collaboration?.list?.().catch(() => result);
    }
    if (view !== viewGeneration) return;
    renderCollaborationInbox(byId("collaborationInbox"), result?.conversations || result?.rows || [], { onOpen: openConversation });
    const available = result?.ok === true;
    if (status) { status.textContent = t(available ? (historyOffline ? "collaboration.offlineCache" : "collaboration.statusAvailable") : "collaboration.statusUnavailable"); status.classList.toggle("is-available", available); }
  };
  nav.addEventListener("click", () => { setActive(true); void load(); });
  back.addEventListener("click", () => setActive(false));

  async function refresh() {
    const policy = await Promise.resolve(getPolicy()).catch(() => null);
    const enabled = policy?.collaboration?.enabled === true;
    nav.hidden = !enabled;
    if (!enabled) { setActive(false); if (status) status.textContent = t("collaboration.statusUnavailable"); }
    return enabled;
  }
  const unsubscribe = window.assistantClient?.collaboration?.onStateChange?.((payload) => {
    if (payload?.type === "availability" || payload?.state?.ok !== true) {
      viewGeneration += 1;
      openGeneration += 1;
      opening = false;
      activeConversationId = "";
      historyMessages = []; nextBeforeSeq = null; hasMore = false; loadingOlder = false; historyOffline = false; updateOlderButton();
      bootstrapAttempted = false;
      composer.reset?.();
      timeline?.replaceChildren();
      byId("collaborationInbox")?.replaceChildren();
      if (empty) empty.hidden = false;
      if (scopeBadge) scopeBadge.textContent = "";
    }
    const view = viewGeneration;
    void refresh().then((enabled) => {
      if (view !== viewGeneration) return;
      const available = payload?.state?.ok === true;
      if (status) { status.textContent = t(available ? (historyOffline ? "collaboration.offlineCache" : "collaboration.statusAvailable") : "collaboration.statusUnavailable"); status.classList.toggle("is-available", available); }
      nav.hidden = !enabled || !available;
      if (!enabled || !available) setActive(false);
      else if (!panel.hidden) void load().then(() => { if (!opening && activeConversationId && view === viewGeneration) void openConversation(activeConversationId); });
      if (live) live.textContent = t(available ? "collaboration.statusAvailable" : "collaboration.statusUnavailable");
    });
  });
  void refresh();
  return { refresh, open: openConversation, loadOlder, show: () => { setActive(true); void load(); }, hide: () => setActive(false), destroy: () => { viewGeneration += 1; openGeneration += 1; olderButton?.removeEventListener("click", loadOlder); unsubscribe?.(); composer.destroy(); } };
}
