import { t } from "../i18n/index.js";
import { renderCollaborationInbox } from "./collaboration-inbox.js";
import { renderCollaborationTimeline } from "./collaboration-timeline.js";
import { initCollaborationComposer } from "./collaboration-composer.js";
import { applyCollaborationHistoryPage } from "./collaboration-history-view.js";
import { refreshVisibleHistory } from "./collaboration-visible-history.js";
import { initCollaborationFriends } from "./collaboration-friends.js";
import { initCollaborationTeams } from "./collaboration-teams.js";
import { initCollaborationAttachments } from "./collaboration-attachments.js";

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
  let transferPolicy = {};
  const attachments = initCollaborationAttachments({ root: byId("collaborationTransfers"), attachButton: byId("collaborationAttachButton") });
  const renderTimeline = () => renderCollaborationTimeline(timeline, historyMessages, {
    onDownload: (input, purpose) => attachments.download(input, purpose),
    canDownload: (purpose) => purpose === "workspace" ? transferPolicy.workspaceShares === true : transferPolicy.attachments === true,
  });
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
  let directory = null, loadGeneration = 0, activeSection = "inbox", navigationGeneration = 0;
  const sectionNodes = { inbox: byId("collaborationInbox"), people: byId("collaborationFriends"), teams: byId("collaborationTeams") };
  const sectionButtons = { inbox: byId("collaborationInboxTab"), people: byId("collaborationPeopleTab"), teams: byId("collaborationTeamsTab") };
  function showSection(section) {
    navigationGeneration += 1;
    activeSection = section;
    for (const [name, node] of Object.entries(sectionNodes)) if (node) node.hidden = name !== section;
    for (const [name, button] of Object.entries(sectionButtons)) button?.setAttribute("aria-pressed", String(name === section));
    const title = byId("collaborationListTitle"); if (title) title.textContent = t(`collaboration.${section}`);
  }
  const friends = initCollaborationFriends(sectionNodes.people, { onChanged: () => load({ checkAccess: true }), onOpen: (id) => openConversation(id), getNavigationGeneration: () => navigationGeneration });
  const teams = initCollaborationTeams(sectionNodes.teams, { onChanged: () => load({ checkAccess: true }), onOpen: (id) => openConversation(id), getNavigationGeneration: () => navigationGeneration });
  const sectionHandlers = Object.entries(sectionButtons).map(([section, button]) => {
    const handler = () => { showSection(section); void load(); }; button?.addEventListener("click", handler); return [button, handler];
  });
  showSection("inbox");
  const composer = initCollaborationComposer({
    textarea: byId("collaborationComposer"), sendButton: byId("collaborationSendButton"),
    getConversationId: () => activeConversationId,
    onSent: (_result, origin) => { if (!opening && activeConversationId && origin?.conversationId === activeConversationId) void openConversation(activeConversationId, { userNavigation: false }); },
    onError: () => { if (live) live.textContent = t("collaboration.sendFailed"); },
  });

  const clearRevokedSelection = (result, conversationId) => {
    if (activeConversationId !== conversationId || !["COLLAB_ACCESS_REVOKED", "COLLABORATION_NOT_FOUND"].includes(result?.code)) return false;
    activeConversationId = "";
    historyMessages = []; nextBeforeSeq = null; hasMore = false; historyOffline = false;
    composer.reset?.(); attachments.reset(); timeline?.replaceChildren(); updateOlderButton();
    if (empty) empty.hidden = false;
    if (scopeBadge) scopeBadge.textContent = "";
    if (live) live.textContent = t("collaboration.statusUnavailable");
    return true;
  };
  const openConversation = async (conversationId, { userNavigation = true } = {}) => {
    if (userNavigation) navigationGeneration += 1;
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
    if (generation !== openGeneration || view !== viewGeneration) return;
    if (!opened?.ok) { clearRevokedSelection(opened, conversationId); return; }
    const sameConversation = activeConversationId === conversationId;
    activeConversationId = conversationId;
    acceptPage(opened, { latest: true, reset: !sameConversation });
    loadingOlder = false;
    updateOlderButton();
    composer.setConversation(conversationId);
    attachments.setConversation(opened.conversation, transferPolicy);
    const scope = String(opened.conversation?.scopeId || "");
    if (scopeBadge) scopeBadge.textContent = scope.startsWith("team:")
      ? `${directory?.teams?.find((team) => team.scopeId === scope)?.name || t("collaboration.scopeTeam")} · ${scope}` : t("collaboration.scopePersonal");
    renderTimeline();
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
    if (clearRevokedSelection(page, conversationId)) return;
    if (!page?.ok || (page.hasMore && !(page.nextBeforeSeq > 0 && page.nextBeforeSeq < cursor))) {
      if (live) live.textContent = t("collaboration.historyLoadFailed");
    } else {
      acceptPage(page);
      renderTimeline();
      if (status) status.textContent = t(page.offline ? "collaboration.offlineCache" : "collaboration.statusAvailable");
    }
    updateOlderButton();
  };
  olderButton?.addEventListener("click", loadOlder);

  const setActive = (active) => {
    if (!active) { navigationGeneration += 1; attachments.dismiss(); }
    shell.classList.toggle("collaboration-active", active);
    panel.hidden = !active;
    nav.setAttribute("aria-current", active ? "page" : "false");
    if (active) byId("collaborationInboxColumn")?.focus?.();
  };
  const load = async ({ checkAccess = false } = {}) => {
    const view = viewGeneration;
    const generation = ++loadGeneration;
    const displayedConversationId = activeConversationId;
    let result = await window.assistantClient?.collaboration?.list?.().catch(() => null);
    if (view !== viewGeneration || generation !== loadGeneration) return;
    if (!bootstrapAttempted && result?.ok === true && Array.isArray(result.conversations) && result.conversations.length === 0) {
      bootstrapAttempted = true;
      await window.assistantClient?.collaboration?.bootstrap?.().catch(() => null);
      result = await window.assistantClient?.collaboration?.list?.().catch(() => result);
    }
    if (view !== viewGeneration || generation !== loadGeneration) return;
    const api = window.assistantClient?.collaboration;
    const [socialDirectory, socialCommands] = await Promise.all([
      Promise.resolve(api?.getDirectory?.()).catch(() => null), Promise.resolve(api?.getSocialCommands?.()).catch(() => null),
    ]);
    if (view !== viewGeneration || generation !== loadGeneration) return;
    if (socialDirectory?.ok) {
      directory = socialDirectory;
      const social = { directory, commands: socialCommands?.commands || [], conversations: result?.conversations || [] };
      friends.update(social); teams.update(social);
    }
    if (checkAccess && displayedConversationId && activeConversationId === displayedConversationId && result?.ok && Array.isArray(result.conversations) && !result.conversations.some((row) => row.id === displayedConversationId)) clearRevokedSelection({ code: "COLLAB_ACCESS_REVOKED" }, displayedConversationId);
    renderCollaborationInbox(byId("collaborationInbox"), result?.conversations || result?.rows || [], { onOpen: openConversation, teams: directory?.teams || [] });
    const available = result?.ok === true;
    if (status) { status.textContent = t(available ? (historyOffline ? "collaboration.offlineCache" : "collaboration.statusAvailable") : "collaboration.statusUnavailable"); status.classList.toggle("is-available", available); }
  };
  nav.addEventListener("click", () => { setActive(true); void load(); });
  back.addEventListener("click", () => setActive(false));

  async function refresh() {
    const policy = await Promise.resolve(getPolicy()).catch(() => null);
    const enabled = policy?.collaboration?.enabled === true;
    transferPolicy = enabled ? policy.collaboration : {};
    attachments.setPolicy(transferPolicy);
    renderTimeline();
    nav.hidden = !enabled;
    if (!enabled) { attachments.reset(); setActive(false); if (status) status.textContent = t("collaboration.statusUnavailable"); }
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
      loadGeneration += 1; directory = null; friends.reset(); teams.reset();
      composer.reset?.();
      attachments.reset();
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
      else if (!panel.hidden || payload?.type === "access-revoked") void load({ checkAccess: true }).then(() => { if (!panel.hidden && !opening && activeConversationId && view === viewGeneration) void openConversation(activeConversationId, { userNavigation: false }); });
      if (live) live.textContent = t(available ? "collaboration.statusAvailable" : "collaboration.statusUnavailable");
    });
  });
  void refresh();
  return { refresh, open: openConversation, loadOlder, show: () => { setActive(true); showSection(activeSection); void load(); }, hide: () => setActive(false), destroy: () => { viewGeneration += 1; openGeneration += 1; loadGeneration += 1; friends.reset(); teams.reset(); attachments.destroy(); for (const [button, handler] of sectionHandlers) button?.removeEventListener("click", handler); olderButton?.removeEventListener("click", loadOlder); unsubscribe?.(); composer.destroy(); } };
}
