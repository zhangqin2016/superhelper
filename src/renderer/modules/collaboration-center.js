import { t, onLocaleChange } from "../i18n/index.js";
import { renderCollaborationInbox } from "./collaboration-inbox.js";
import { renderCollaborationTimeline } from "./collaboration-timeline.js";
import { initCollaborationComposer } from "./collaboration-composer.js";
import { applyCollaborationHistoryPage } from "./collaboration-history-view.js";
import { refreshVisibleHistory } from "./collaboration-visible-history.js";
import { initCollaborationFriends } from "./collaboration-friends.js";
import { initCollaborationTeams } from "./collaboration-teams.js";
import { initCollaborationAttachments } from "./collaboration-attachments.js";
import { createReplySourceMaskView } from "./collaboration-reply-view.js";
import { initCollaborationPanelShell } from "./collaboration-panel-shell.js";

function byId(id) { return document.getElementById(id); }

/**
 * A deliberately thin shell: normal workbench DOM remains mounted and is only
 * visually switched, so turning the feature off restores the current chat
 * without destroying a running turn or composer state.
 */
export function initCollaborationCenter({ getPolicy = () => window.assistantClient?.getAppPolicy?.() } = {}) {
  const nav = byId("collaborationPanelToggle") || byId("collaborationNavButton");
  const back = byId("collaborationConversationBack") || byId("workbenchNavButton");
  const shell = byId("appShell") || byId("centerPanel");
  const panel = byId("collaborationCenter");
  if (!nav || !shell || !panel) return { refresh: async () => false };
  const panelShell = byId("collaborationPanelToggle") ? initCollaborationPanelShell({ shell, panel, toggle: nav, backButton: back }) : null;
  const status = byId("collaborationStatus");
  const live = byId("collaborationLive");
  const scopeBadge = byId("collaborationScopeBadge");
  const timeline = byId("collaborationTimeline");
  const empty = byId("collaborationConversationEmpty");
  const olderButton = byId("collaborationLoadOlder");
  let transferPolicy = {};
  let disposed = false, policyEnabled = false;
  const replySourceMasks = createReplySourceMaskView();
  const attachments = initCollaborationAttachments({ root: byId("collaborationTransfers"), attachButton: byId("collaborationAttachButton") });
  const renderTimeline = () => renderCollaborationTimeline(timeline, historyMessages, {
    currentUserId: directory?.profile?.userId || "",
    resolveSender: (userId) => {
      if (userId === directory?.profile?.userId) return directory?.profile?.displayName || directory?.profile?.lilyId || userId;
      const person = directory?.contacts?.find((contact) => contact.userId === userId)
        || directory?.teams?.flatMap((team) => team.members || []).find((member) => member.userId === userId);
      return person?.displayName || person?.lilyId || userId;
    },
    onDownload: (input, purpose) => attachments.download(input, purpose),
    canDownload: (purpose) => purpose === "workspace" ? transferPolicy.workspaceShares === true : transferPolicy.attachments === true,
    canReply: (message) => !disposed && policyEnabled && !panel.hidden && !navigating && Boolean(activeConversationId) && historyMessages.includes(message),
    onReply: (message) => {
      if (disposed || !policyEnabled || panel.hidden || navigating || !activeConversationId || !historyMessages.includes(message) || message.revokedAt || message.visibilityMask || !message.id || !(Number(message.seq) > 0)) return;
      composer.setReply?.({ messageId: message.id });
      byId("collaborationComposer")?.focus();
    },
  });
  let historyMessages = [];
  let nextBeforeSeq = null;
  let hasMore = false;
  let loadingOlder = false;
  let historyOffline = false;
  const acceptPage = (page, { latest = false, reset = false } = {}) => {
    replySourceMasks.observe(activeConversationId, page.messages || []);
    const previous = reset ? {} : { messages: historyMessages, nextBeforeSeq, hasMore, offline: historyOffline };
    const next = applyCollaborationHistoryPage(previous, page, { latest });
    historyMessages = replySourceMasks.apply(activeConversationId, next.messages); nextBeforeSeq = next.nextBeforeSeq; hasMore = next.hasMore; historyOffline = next.offline;
  };
  const updateOlderButton = () => { if (olderButton) { olderButton.hidden = !hasMore || nextBeforeSeq == null; olderButton.disabled = loadingOlder || opening; } };
  let activeConversationId = "";
  let bootstrapAttempted = false;
  let viewGeneration = 0;
  let openGeneration = 0;
  let opening = false;
  let navigating = false;
  let openingConversationId = "";
  const invalidateOpen = () => { openGeneration += 1; opening = false; navigating = false; openingConversationId = ""; loadingOlder = false; updateOlderButton(); };
  let directory = null, loadGeneration = 0, activeSection = "inbox", navigationGeneration = 0;
  const sectionNodes = { inbox: byId("collaborationInbox"), people: byId("collaborationFriends"), teams: byId("collaborationTeams") };
  const sectionButtons = { inbox: byId("collaborationInboxTab"), people: byId("collaborationPeopleTab"), teams: byId("collaborationTeamsTab") };
  function showSection(section) {
    navigationGeneration += 1;
    activeSection = section;
    for (const [name, node] of Object.entries(sectionNodes)) if (node) node.hidden = name !== section;
    for (const [name, button] of Object.entries(sectionButtons)) button?.setAttribute("aria-pressed", String(name === section));
    const title = byId("collaborationListTitle"); if (title) title.textContent = t(`collaboration.${section}`);
    panelShell?.setConversationOpen(false);
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
    getReplySourceStatus: replySourceMasks.get,
    onSent: (_result, origin) => { if (!disposed && policyEnabled && !panel.hidden && !opening && activeConversationId && origin?.conversationId === activeConversationId) void openConversation(activeConversationId, { userNavigation: false }); },
    onError: () => { if (live) live.textContent = t("collaboration.sendFailed"); },
  });
  composer.setActive?.(!panel.hidden && policyEnabled);
  const unsubscribeLocale = onLocaleChange(renderTimeline);

  const clearRevokedSelection = (result, conversationId) => {
    if (!["COLLAB_ACCESS_REVOKED", "COLLABORATION_NOT_FOUND"].includes(result?.code)) return false;
    replySourceMasks.forget(conversationId);
    composer.forgetConversation?.(conversationId);
    if (activeConversationId !== conversationId) return false;
    if (!opening || openingConversationId === conversationId) invalidateOpen();
    activeConversationId = "";
    historyMessages = []; nextBeforeSeq = null; hasMore = false; historyOffline = false;
    attachments.reset(); timeline?.replaceChildren(); updateOlderButton();
    if (empty) empty.hidden = false;
    if (scopeBadge) scopeBadge.textContent = "";
    if (live) live.textContent = t("collaboration.statusUnavailable");
    return true;
  };
  const openConversation = async (conversationId, { userNavigation = true } = {}) => {
    if (disposed) return;
    if (userNavigation) navigationGeneration += 1;
    const generation = ++openGeneration;
    const view = viewGeneration;
    opening = true;
    openingConversationId = conversationId;
    navigating = userNavigation || activeConversationId !== conversationId;
    if (navigating) composer.setActive?.(false);
    renderTimeline();
    loadingOlder = false;
    updateOlderButton();
    const opened = await window.assistantClient?.collaboration?.open?.(conversationId).catch(() => null);
    let refreshFailed = false;
    if (opened?.ok && activeConversationId === conversationId && generation === openGeneration && view === viewGeneration) {
      // Apply already-authoritative newest masks now. Fetching older loaded
      // rows must not keep a known revoked body/quote visible in the meantime.
      acceptPage(opened, { latest: true });
      composer.refreshReply?.(historyMessages);
      renderTimeline();
      try {
        const refreshed = await refreshVisibleHistory({ conversationId, existing: historyMessages, latest: opened.messages || [],
          readMessages: window.assistantClient?.collaboration?.readMessages ? async (request) => {
            const result = await window.assistantClient.collaboration.readMessages(request);
            if (result?.ok && !disposed && conversationId === activeConversationId && generation === openGeneration && view === viewGeneration) {
              replySourceMasks.observe(conversationId, result.messages || []);
              // Each successful batch is visibility evidence already. A later
              // batch may stall/fail; it must not delay these source masks.
              historyMessages = replySourceMasks.apply(conversationId, historyMessages);
              composer.refreshReply?.(historyMessages);
              renderTimeline();
            }
            return result;
          } : undefined, isCurrent: () => generation === openGeneration && view === viewGeneration });
        if (refreshed) historyMessages = replySourceMasks.apply(conversationId, refreshed);
      } catch { refreshFailed = true; }
    }
    if (generation === openGeneration) { opening = false; navigating = false; openingConversationId = ""; updateOlderButton(); }
    if (disposed || generation !== openGeneration || view !== viewGeneration) return;
    if (!opened?.ok) { clearRevokedSelection(opened, conversationId); composer.setActive?.(!panel.hidden && policyEnabled); renderTimeline(); return; }
    const sameConversation = activeConversationId === conversationId;
    activeConversationId = conversationId;
    acceptPage(opened, { latest: true, reset: !sameConversation });
    loadingOlder = false;
    updateOlderButton();
    composer.setConversation(conversationId);
    panelShell?.setConversationOpen(true);
    composer.setActive?.(!panel.hidden && policyEnabled);
    composer.refreshReply?.(historyMessages);
    attachments.setConversation(opened.conversation, transferPolicy);
    composer.refreshMentionCandidates?.();
    const scope = String(opened.conversation?.scopeId || "");
    const conversationTitle = byId("collaborationConversationTitle");
    if (conversationTitle) conversationTitle.textContent = String(opened.conversation?.title || t("collaboration.conversation"));
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
      composer.refreshReply?.(historyMessages);
      renderTimeline();
      if (status) status.textContent = t(page.offline ? "collaboration.offlineCache" : "collaboration.statusAvailable");
    }
    updateOlderButton();
  };
  olderButton?.addEventListener("click", loadOlder);

  const setActive = (active) => {
    if (disposed) return;
    if (!active) { navigationGeneration += 1; invalidateOpen(); attachments.dismiss(); }
    if (panelShell) active ? panelShell.openPanel() : panelShell.closePanel();
    else { shell.classList.toggle("collaboration-active", active); panel.hidden = !active; }
    nav.setAttribute("aria-current", active ? "page" : "false");
    composer.setActive?.(active && policyEnabled && !navigating);
    renderTimeline();
    if (active) byId("collaborationInboxColumn")?.focus?.();
  };
  const load = async ({ checkAccess = false } = {}) => {
    if (disposed) return;
    const view = viewGeneration;
    const generation = ++loadGeneration;
    const accessGeneration = openGeneration;
    const displayedConversationId = activeConversationId;
    let result = await window.assistantClient?.collaboration?.list?.().catch(() => null);
    if (view !== viewGeneration || generation !== loadGeneration) return;
    if (!bootstrapAttempted && result?.ok === true && Array.isArray(result.conversations) && result.conversations.length === 0) {
      bootstrapAttempted = true;
      await window.assistantClient?.collaboration?.bootstrap?.().catch(() => null);
      result = await window.assistantClient?.collaboration?.list?.().catch(() => result);
    }
    if (view !== viewGeneration || generation !== loadGeneration) return;
    // Apply the authorized list before unrelated directory waits. An open
    // started since this request owns newer selection/authorization evidence.
    if (checkAccess && accessGeneration === openGeneration && result?.ok && Array.isArray(result.conversations)) {
      const allowed = result.conversations.map((row) => row.id);
      composer.retainConversations?.(allowed);
      replySourceMasks.retainConversations(allowed);
      if (opening && !allowed.includes(openingConversationId)) { invalidateOpen(); composer.setActive?.(!panel.hidden && policyEnabled); renderTimeline(); }
      if (displayedConversationId && activeConversationId === displayedConversationId && !allowed.includes(displayedConversationId)) clearRevokedSelection({ code: "COLLAB_ACCESS_REVOKED" }, displayedConversationId);
    }
    const api = window.assistantClient?.collaboration;
    const [socialDirectory, socialCommands] = await Promise.all([
      Promise.resolve(api?.getDirectory?.()).catch(() => null), Promise.resolve(api?.getSocialCommands?.()).catch(() => null),
    ]);
    if (view !== viewGeneration || generation !== loadGeneration) return;
    if (socialDirectory?.ok) {
      directory = socialDirectory;
      const social = { directory, commands: socialCommands?.commands || [], conversations: result?.conversations || [] };
      friends.update(social); teams.update(social);
      renderTimeline();
    }
    renderCollaborationInbox(byId("collaborationInbox"), result?.conversations || result?.rows || [], { onOpen: openConversation, teams: directory?.teams || [] });
    const available = result?.ok === true;
    if (status) { status.textContent = t(available ? (historyOffline ? "collaboration.offlineCache" : "collaboration.statusAvailable") : "collaboration.statusUnavailable"); status.classList.toggle("is-available", available); }
  };
  const navClick = () => {
    if (!panelShell) setActive(true);
    queueMicrotask(() => { composer.setActive?.(!panel.hidden && policyEnabled && !navigating); if (!panel.hidden) void load(); });
  };
  const backClick = () => panelShell ? panelShell.setConversationOpen(false) : setActive(false);
  nav.addEventListener("click", navClick);
  back?.addEventListener("click", backClick);

  async function refresh() {
    const view = viewGeneration;
    const policy = await Promise.resolve(getPolicy()).catch(() => null);
    if (disposed || view !== viewGeneration) return false;
    const enabled = policy?.collaboration?.enabled === true;
    policyEnabled = enabled;
    transferPolicy = enabled ? policy.collaboration : {};
    attachments.setPolicy(transferPolicy);
    composer.setActive?.(enabled && !panel.hidden && !navigating);
    renderTimeline();
    nav.hidden = !enabled;
    if (!enabled) { attachments.reset(); setActive(false); if (status) status.textContent = t("collaboration.statusUnavailable"); }
    return enabled;
  }
  const unsubscribe = window.assistantClient?.collaboration?.onStateChange?.((payload) => {
    if (payload?.state?.ok === true && ["sync", "access-revoked", "bootstrap", "relationship"].includes(payload.type)) composer.refreshMentionCandidates?.();
    if (payload?.type === "availability" || payload?.state?.ok !== true) {
      viewGeneration += 1;
      openGeneration += 1;
      opening = false;
      navigating = false;
      openingConversationId = "";
      activeConversationId = "";
      historyMessages = []; nextBeforeSeq = null; hasMore = false; loadingOlder = false; historyOffline = false; updateOlderButton();
      bootstrapAttempted = false;
      loadGeneration += 1; directory = null; friends.reset(); teams.reset();
      composer.reset?.();
      replySourceMasks.clear();
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
  return { refresh, open: openConversation, loadOlder, show: () => { if (disposed) return; setActive(true); showSection(activeSection); void load(); }, hide: () => setActive(false), destroy: () => { disposed = true; viewGeneration += 1; openGeneration += 1; loadGeneration += 1; friends.reset(); teams.reset(); attachments.destroy(); panelShell?.destroy(); for (const [button, handler] of sectionHandlers) button?.removeEventListener("click", handler); nav.removeEventListener("click", navClick); back?.removeEventListener("click", backClick); olderButton?.removeEventListener("click", loadOlder); unsubscribe?.(); unsubscribeLocale(); composer.destroy(); replySourceMasks.clear(); renderTimeline(); } };
}
