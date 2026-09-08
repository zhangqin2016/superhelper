import { t, onLocaleChange } from "../i18n/index.js";
import { identityName, resolvePerson } from "./collaboration-social-ui.js";
import { paintConversationTitle } from "./collaboration-thread-header.js";
import { createLatestOpenQueue } from "./collaboration-open-queue.js";
import { renderCollaborationInbox, setActiveConversation } from "./collaboration-inbox.js";
import { createConversationPrefs } from "./collaboration-conversation-prefs.js";
import { createForwardAction, createBatchForwardAction } from "./collaboration-forward.js";
import { createMessageMultiSelect, createLocalDeleteAction } from "./collaboration-multiselect.js";
import { createUnreadBadge } from "./collaboration-unread-badge.js";
import { createCenterTimeline } from "./collaboration-center-timeline.js";
import { initCollaborationComposer } from "./collaboration-composer.js";
import { applyCollaborationHistoryPage } from "./collaboration-history-view.js";
import { refreshVisibleHistory } from "./collaboration-visible-history.js";
import { initCollaborationFriends } from "./collaboration-friends.js";
import { initCollaborationTeams } from "./collaboration-teams.js";
import { createDetailSurface, createDetachControl, createDrawerSurface, wireConversationHeader } from "./collaboration-panel-surfaces.js";
import { initCollaborationAttachments } from "./collaboration-attachments.js";
import { createReplySourceMaskView } from "./collaboration-reply-view.js";
import { initCollaborationPanelShell } from "./collaboration-panel-shell.js";
import { renderCollaborationTypingHint } from "./collaboration-typing-view.js";
import { initCenterRemoteTasks } from "./collaboration-workspace-integration.js";
import { createOnlinePresenceView } from "./collaboration-online-presence.js";

function byId(id) { return document.getElementById(id); }

function collabCommandId() { return globalThis.crypto?.randomUUID?.() || `collab-${Date.now()}-${Math.random().toString(16).slice(2)}`; }

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
  const unreadBadge = byId("collaborationUnreadBadge");
  const railUnread = byId("collaborationRailUnread");
  // Where the panel is showing, as opposed to what: a detail screen beside the
  // list, and detaching into a window of its own. Both extracted together,
  // since both answer that question and this file was at its line ceiling.
  const detail = createDetailSurface({
    listColumn: byId("collaborationInboxColumn"),
    view: byId("collaborationDetail"),
    title: byId("collaborationDetailTitle"),
    body: byId("collaborationDetailBody"),
    back: byId("collaborationDetailBack"),
    onClose: () => { navigationGeneration += 1; },
  });
  const openDetail = detail.open;
  const closeDetail = detail.close;
  const inboxSearch = byId("collaborationInboxSearch");
  const conversationSearch = byId("collaborationConversationSearch");
  const timeline = byId("collaborationTimeline");
  const empty = byId("collaborationConversationEmpty");
  const olderButton = byId("collaborationLoadOlder");
  let transferPolicy = {};
  let activeConversationKind = "";
  let activePeerReadSeq = 0;
  // Captured when the conversation OPENS, so the divider does not jump away the
  // moment the read checkpoint advances past it.
  let activeUnreadFromSeq = 0;
  let disposed = false, policyEnabled = false;
  let searchQuery = "";
  const replySourceMasks = createReplySourceMaskView();
  let composer;
  const attachments = initCollaborationAttachments({ root: byId("collaborationTransfers"), attachButton: byId("collaborationAttachButton"), composerMode: true, onDraftChange: () => composer?.refreshAttachments?.() });
  // The most recent social payload, plus which hidden list still needs it.
  let lastSocial = null;
  const socialDirty = { people: true, teams: true };
  const flushSocial = (section) => {
    if (!lastSocial) return;
    if (section === "people" && socialDirty.people) { socialDirty.people = false; friends.update(lastSocial); }
    if (section === "teams" && socialDirty.teams) { socialDirty.teams = false; teams.update(lastSocial); }
  };
  let lastRenderedCount = 0;
  const renderTimeline = createCenterTimeline({
    get lastRenderedCount() { return lastRenderedCount; },
    set lastRenderedCount(value) { lastRenderedCount = value; },
    get activeConversationId() { return activeConversationId; },
    get timeline() { return timeline; },
    get historyMessages() { return historyMessages; },
    get searchQuery() { return searchQuery; },
    get inboxPrefs() { return inboxPrefs; },
    get directory() { return directory; },
    get activeConversationKind() { return activeConversationKind; },
    get activePeerReadSeq() { return activePeerReadSeq; },
    get activeUnreadFromSeq() { return activeUnreadFromSeq; },
    get attachments() { return attachments; },
    get transferPolicy() { return transferPolicy; },
    get disposed() { return disposed; },
    get readEpoch() { return viewGeneration; },
    get policyEnabled() { return policyEnabled; },
    get panel() { return panel; },
    get navigating() { return navigating; },
    get composer() { return composer; },
    get openConversation() { return openConversation; },
    get status() { return status; },
    get live() { return live; },
    get forwardMessage() { return forwardMessage; },
    get multiSelect() { return multiSelect; },
    get deleteMessageLocally() { return deleteMessageLocally; },
    get load() { return load; },
  });
  let historyMessages = [];
  let nextBeforeSeq = null;
  let hasMore = false;
  let loadingOlder = false;
  let historyOffline = false;
  let inboxFilter = "";
  let lastConversations = [];
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
  const presenceHeader = document.createElement('span');
  presenceHeader.className = 'collaboration-header-presence';
  byId('collaborationConversationTitle')?.parentElement?.append(presenceHeader);
  const onlineView = createOnlinePresenceView({root:panel, header:presenceHeader,
    getAccountId: () => directory?.profile?.userId || '',
    getPeer: () => {
      const conversation = lastConversations.find(row => row.id === activeConversationId);
      if (byId('collaborationConversation')?.hidden || conversation?.kind !== 'direct') return '';
      return conversation.memberUserIds?.find(id => id !== directory?.profile?.userId) || '';
    } });
  const remoteTasks = initCenterRemoteTasks({ root: byId("collaborationConversation"), header: byId("collaborationConversation")?.querySelector(".collaboration-conversation-header"),
    recoveryHeader: byId("collaborationInboxColumn"), recoveryRoot: panel,
    refreshContext: () => refresh(),
    getContext: () => ({ enabled: !disposed && !panel.hidden && policyEnabled && transferPolicy.tasks === true, conversationId: activeConversationId, userId: directory?.profile?.userId || "" }),
    resolveName: (id) => identityName(resolvePerson(directory, id)),
    workspace: { getPolicy, getContext: () => ({ disposed, view: viewGeneration, navigation: navigationGeneration, userId: directory?.profile?.userId || "", conversationId: activeConversationId }), activate: () => setActive(true), load: () => load(), open: id => openConversation(id) },
  });
  const sectionNodes = { inbox: byId("collaborationInbox"), people: byId("collaborationFriends"), teams: byId("collaborationTeams") };
  const sectionButtons = { inbox: byId("collaborationInboxTab"), people: byId("collaborationPeopleTab"), teams: byId("collaborationTeamsTab") };
  function showSection(section) {
    navigationGeneration += 1;
    invalidateOpen();
    activeSection = section;
    for (const [name, node] of Object.entries(sectionNodes)) if (node) node.hidden = name !== section;
    // One search box, always in the same place, retargeted at the list on
    // screen. It used to be hidden outside the inbox, which is why the contacts
    // view had grown a second search input of its own — below the list.
    if (inboxSearch) {
      inboxSearch.hidden = section === "teams";
      const placeholder = t(section === "people" ? "collaboration.social.searchContacts" : "collaboration.search.placeholder");
      inboxSearch.placeholder = placeholder;
      inboxSearch.setAttribute("aria-label", placeholder);
      if (inboxSearch.value) { inboxSearch.value = ""; inboxFilter = ""; friends?.setFilter(""); }
    }
    for (const [name, button] of Object.entries(sectionButtons)) button?.setAttribute("aria-pressed", String(name === section));
    // The rail is icon-only, so the header names where you are. This used to
    // be a second heading inside the list, competing with the panel's own.
    const panelTitle = byId("collaborationPanelTitle");
    if (panelTitle) panelTitle.textContent = t(`collaboration.${section}`);
    const title = byId("collaborationListTitle");
    if (title) { title.textContent = t(`collaboration.${section}`); title.hidden = false; }
    // Changing destination leaves any detail behind: it belonged to the list
    // you just left.
    closeDetail();
    groupDrawer.close();
    // Render the destination now if it fell behind while it was hidden.
    flushSocial(section);
    panelShell?.setConversationOpen(false);
  }
  const detailSurface = { open: openDetail, close: closeDetail };
  const groupDrawer = createDrawerSurface({ view: byId("collaborationGroupDrawer"), title: byId("collaborationGroupDrawerTitle"), body: byId("collaborationGroupDrawerBody"), close: byId("collaborationGroupDrawerClose"), onClose: () => { navigationGeneration += 1; } });
  const friends = initCollaborationFriends(sectionNodes.people, { onChanged: () => load({ checkAccess: true }), onOpen: (id) => openConversation(id), getNavigationGeneration: () => navigationGeneration, detail: detailSurface });
  const teams = initCollaborationTeams(sectionNodes.teams, { onChanged: () => load({ checkAccess: true }), onOpen: (id) => openConversation(id), getNavigationGeneration: () => navigationGeneration, detail: detailSurface, drawer: groupDrawer });
  const sectionHandlers = Object.entries(sectionButtons).map(([section, button]) => {
    const handler = () => { showSection(section); void load(); }; button?.addEventListener("click", handler); return [button, handler];
  });
  const detach = createDetachControl({
    button: byId("collaborationPanelDetach"),
    onDetached: () => { panelShell ? panelShell.closePanel() : setActive(false); },
    isDisposed: () => disposed,
  });
  showSection("inbox");
  composer = initCollaborationComposer({
    attachmentDraft: attachments,
    textarea: byId("collaborationComposer"), sendButton: byId("collaborationSendButton"),
    getConversationId: () => activeConversationId,
    getReplySourceStatus: replySourceMasks.get,
    onSent: (_result, origin) => { if (!disposed && policyEnabled && !panel.hidden && !opening && activeConversationId && origin?.conversationId === activeConversationId) void openConversation(activeConversationId, { userNavigation: false }); },
    onError: () => { if (live) live.textContent = t("collaboration.sendFailed"); },
  });
  composer.setActive?.(!panel.hidden && policyEnabled);
  const unsubscribeLocale = onLocaleChange(() => {renderTimeline();socialDirty.people=true;socialDirty.teams=true;flushSocial(activeSection);});

  const clearRevokedSelection = (result, conversationId) => {
    if (!["COLLAB_ACCESS_REVOKED", "COLLABORATION_NOT_FOUND"].includes(result?.code)) return false;
    replySourceMasks.forget(conversationId);
    composer.forgetConversation?.(conversationId);
    if (activeConversationId !== conversationId) return false;
    if (!opening || openingConversationId === conversationId) invalidateOpen();
    activeConversationId = "";
    remoteTasks.update();
    activeConversationKind = "";
    historyMessages = []; nextBeforeSeq = null; hasMore = false; historyOffline = false;
    attachments.reset(); timeline?.replaceChildren(); updateOlderButton();
    if (empty) empty.hidden = false;
    if (scopeBadge) scopeBadge.textContent = "";
    if (live) live.textContent = t("collaboration.statusUnavailable");
    return true;
  };
  const queueOpen = createLatestOpenQueue();
  const openConversation = async (conversationId, { userNavigation = true } = {}) => {
    if (disposed) return;
    if (userNavigation) remoteTasks.invalidate();
    if (userNavigation) navigationGeneration += 1;
    const generation = ++openGeneration;
    const view = viewGeneration;
    opening = true;
    openingConversationId = conversationId;
    navigating = userNavigation || activeConversationId !== conversationId;
    if (navigating) composer.setActive?.(false);
    const isCurrent = () => !disposed && generation === openGeneration && view === viewGeneration;
    if (userNavigation && activeConversationId !== conversationId) {
      activeConversationId = conversationId;
      historyMessages = []; nextBeforeSeq = null; hasMore = false;
      lastRenderedCount = 0; activePeerReadSeq = 0; activeUnreadFromSeq = 0;
      searchQuery = ""; groupDrawer.close(); attachments.reset();
      conversationHeaderControl.reset();
      composer.setConversation(conversationId);
      setActiveConversation(byId("collaborationInbox"), conversationId);
      paintConversationTitle(byId("collaborationConversationTitle"), lastConversations.find((row) => row.id === conversationId), directory);
      if (scopeBadge) scopeBadge.textContent = "";
      if (empty) empty.hidden = true;
      panelShell?.setConversationOpen(true);
    }
    renderTimeline();
    loadingOlder = false;
    updateOlderButton();
    if (userNavigation) {
      const cached = await window.assistantClient?.collaboration?.open?.(conversationId, undefined, { cached: true }).catch(() => null);
      if (!isCurrent()) return;
      if (cached?.ok) {
        acceptPage(cached, { latest: true, reset: true });
        activeConversationKind = String(cached.conversation?.kind || "");
        conversationHeaderControl.setKind(activeConversationKind);
        composer.refreshReply?.(historyMessages);
        composer.setActive?.(!panel.hidden && policyEnabled);
        renderTimeline();
      }
    }
    const opened = await queueOpen(() => window.assistantClient?.collaboration?.open?.(conversationId), isCurrent).catch(() => null);
    let refreshFailed = false;
    if (!userNavigation && opened?.ok && activeConversationId === conversationId && generation === openGeneration && view === viewGeneration) {
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
    setActiveConversation(byId("collaborationInbox"), conversationId);
    activeConversationKind = String(opened.conversation?.kind || "");
    conversationHeaderControl.setKind(activeConversationKind);
    activePeerReadSeq = Number(opened.conversation?.peerReadSeq) || 0;
    if (userNavigation !== false) {
      const lastRead = Number(opened.conversation?.lastReadSeq) || 0;
      const projection = Number(opened.conversation?.projectionSeq) || 0;
      activeUnreadFromSeq = opened.conversation?.activityKnown === true && projection > lastRead ? lastRead : 0;
    }
    acceptPage(opened, { latest: true, reset: !sameConversation });
    loadingOlder = false;
    updateOlderButton();
    composer.setConversation(conversationId);
    remoteTasks.update();
    // Refreshing history has no navigation authority, including after Back.
    if (userNavigation) panelShell?.setConversationOpen(true);
    // The search bar stays hidden until the header's search icon asks for it.
    composer.setActive?.(!panel.hidden && policyEnabled);
    composer.refreshReply?.(historyMessages);
    attachments.setConversation(opened.conversation, transferPolicy);
    composer.refreshMentionCandidates?.();
    const scope = String(opened.conversation?.scopeId || "");
    const listedConversation = lastConversations.find((row) => row.id === conversationId);
    paintConversationTitle(byId("collaborationConversationTitle"), { ...listedConversation, ...opened.conversation,
      memberUserIds: opened.conversation?.memberUserIds?.length ? opened.conversation.memberUserIds : listedConversation?.memberUserIds,
    }, directory);
    if (scopeBadge) scopeBadge.textContent = scope.startsWith("team:")
      ? (directory?.teams?.find((team) => team.scopeId === scope)?.name || t("collaboration.scopeTeam")) : "";
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
    if (!active) remoteTasks.invalidate();
    if (panelShell) active ? panelShell.openPanel() : panelShell.closePanel();
    else { shell.classList.toggle("collaboration-active", active); panel.hidden = !active; }
    nav.setAttribute("aria-current", active ? "page" : "false");
    composer.setActive?.(active && policyEnabled && !navigating);
    renderTimeline();
    if (active) byId("collaborationInboxColumn")?.focus?.();
  };
  const updateUnreadBadge = createUnreadBadge({ railUnread, unreadBadge, isMuted: (id) => inboxPrefs().isMuted(id) });
  let convPrefs = null, convPrefsAccount = null;
  const inboxPrefs = () => { const acct = directory?.profile?.userId || ""; if (!convPrefs || convPrefsAccount !== acct) { convPrefs = createConversationPrefs(acct); convPrefsAccount = acct; } return convPrefs; };
  const forwardMessage = createForwardAction({ getConversations: () => inboxPrefs().apply(lastConversations), getActiveConversationId: () => activeConversationId, getCurrentUserId: () => directory?.profile?.userId || "", resolveSender: (userId) => identityName(resolvePerson(directory, userId)), isEnabled: () => !disposed && policyEnabled && !panel.hidden && Boolean(activeConversationId), send: ({ conversationId, bodyText }) => window.assistantClient?.collaboration?.send?.({ conversationId, clientCommandId: collabCommandId(), bodyText }) });
  let multiSelect; const deleteMessageLocally = createLocalDeleteAction({ hideMessages: (ids) => inboxPrefs().hideMessages(ids), onDone: () => renderTimeline() }); const batchForward = createBatchForwardAction({ getConversations: () => inboxPrefs().apply(lastConversations), getActiveConversationId: () => activeConversationId, getCurrentUserId: () => directory?.profile?.userId || "", resolveSender: (userId) => identityName(resolvePerson(directory, userId)), getMessages: () => historyMessages, onDone: () => multiSelect?.exit(), send: ({ conversationId, bodyText }) => window.assistantClient?.collaboration?.send?.({ conversationId, clientCommandId: collabCommandId(), bodyText }) });
  multiSelect = createMessageMultiSelect({ container: byId("collaborationConversation"), onChange: () => renderTimeline(), onForward: batchForward, onDelete: (ids) => { inboxPrefs().hideMessages(ids); multiSelect.exit(); } });
  const paintInbox = (conversations) => renderCollaborationInbox(byId("collaborationInbox"), conversations || [], {
    onOpen: openConversation, teams: directory?.teams || [], activeConversationId, filterText: inboxFilter,
    resolveSender: (userId) => identityName(resolvePerson(directory, userId)), currentUserId: directory?.profile?.userId || "",
    prefs: inboxPrefs(), onPrefsChange: ({ action, conversationId }) => { if (action === "delete" && conversationId === activeConversationId) backClick(); } });
  const load = async ({ checkAccess = false } = {}) => {
    if (disposed) return;
    const view = viewGeneration;
    const generation = ++loadGeneration;
    const accessGeneration = openGeneration;
    const displayedConversationId = activeConversationId;
    const client = window.assistantClient?.collaboration;
    // `list`, `getDirectory` and `getSocialCommands` are independent reads.
    // They used to cost two serial round trips: list, and only then the pair.
    const directoryPromise = Promise.resolve(client?.getDirectory?.()).catch(() => null);
    const commandsPromise = Promise.resolve(client?.getSocialCommands?.()).catch(() => null);
    let result = await Promise.resolve(client?.list?.()).catch(() => null);
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
    const [socialDirectory, socialCommands] = await Promise.all([directoryPromise, commandsPromise]);
    if (view !== viewGeneration || generation !== loadGeneration) return;
    if (socialDirectory?.ok) {
      directory = socialDirectory;
      remoteTasks.update();
      lastSocial = { directory, commands: socialCommands?.commands || [], conversations: result?.conversations || [] };
      // The hidden lists keep their last render and are marked stale; showing
      // one flushes it. Rebuilding all of them on every load is most of what
      // made switching views feel slow.
      socialDirty.people = true;
      socialDirty.teams = true;
      flushSocial(activeSection);
      // The timeline is only worth rebuilding when a conversation is actually
      // on screen; it is the most expensive surface here.
      if (activeConversationId) renderTimeline();
    }
    lastConversations = result?.conversations || result?.rows || [];
    paintInbox(lastConversations);
    updateUnreadBadge(result?.conversations);
    const available = result?.ok === true;
    if (status) { status.textContent = t(available ? (historyOffline ? "collaboration.offlineCache" : "collaboration.statusAvailable") : "collaboration.statusUnavailable"); status.classList.toggle("is-available", available); }
  };
  const navClick = () => {
    if (!panelShell) setActive(true);
    queueMicrotask(() => { composer.setActive?.(!panel.hidden && policyEnabled && !navigating); if (!panel.hidden) void load(); });
  };
  const backClick = () => { navigationGeneration += 1; invalidateOpen(); conversationHeaderControl?.reset(); groupDrawer.close(); searchQuery = ""; panelShell ? panelShell.setConversationOpen(false) : setActive(false); };
  nav.addEventListener("click", navClick);
  back?.addEventListener("click", backClick);
  const searchInput = () => {
    const value = inboxSearch?.value || "";
    // The same box filters whichever list is on screen.
    if (activeSection === "people") { friends.setFilter(value); return; }
    inboxFilter = value;
    paintInbox(lastConversations);
  };
  inboxSearch?.addEventListener("input", searchInput);
  // Header-icon controls: search (toggle, not a persistent bar) and group info.
  const conversationHeaderControl = wireConversationHeader({ input: conversationSearch, toggle: byId("collaborationConversationSearchToggle"), infoButton: byId("collaborationConversationInfo"),
    onChange: (value) => { searchQuery = value; renderTimeline(); },
    onInfo: () => { if (!activeConversationId) return; if (lastSocial) teams.update(lastSocial); void teams.showConversation(activeConversationId, { surface: "drawer" }); } });

  async function refresh() {
    const view = viewGeneration;
    const policy = await Promise.resolve(getPolicy()).catch(() => null);
    if (disposed || view !== viewGeneration) return false;
    const enabled = policy?.collaboration?.enabled === true;
    policyEnabled = enabled;
    transferPolicy = enabled ? policy.collaboration : {};
    remoteTasks.update();
    attachments.setPolicy(transferPolicy);
    composer.setActive?.(enabled && !panel.hidden && !navigating);
    renderTimeline();
    nav.hidden = !enabled;
    if (!enabled) { attachments.reset(); setActive(false); if (status) status.textContent = t("collaboration.statusUnavailable"); }
    return enabled;
  }
  const unsubscribe = window.assistantClient?.collaboration?.onStateChange?.((payload) => {
    if (["online-presence", "typing"].includes(payload?.type) && payload?.state?.ok === true) {
      renderCollaborationTypingHint({node:byId("collaborationTyping"),state:payload.state,conversationId:activeConversationId,currentUserId:directory?.profile?.userId || "",directory});
      onlineView.changed(payload.state.onlinePresence); return;
    }
    if (payload?.type === "task" && payload?.state?.ok === true) remoteTasks.onChange();
    if (["availability", "access-revoked"].includes(payload?.type) || payload?.state?.ok !== true) remoteTasks.invalidateService();
    if (payload?.state?.ok === true) renderCollaborationTypingHint({
      node: byId("collaborationTyping"), state: payload.state, conversationId: activeConversationId,
      currentUserId: directory?.profile?.userId || "", directory,
    });
    if (payload?.state?.ok === true && ["sync", "access-revoked", "bootstrap", "relationship"].includes(payload.type)) composer.refreshMentionCandidates?.();
    if (payload?.type === "availability" || payload?.state?.ok !== true) {
      viewGeneration += 1;
      openGeneration += 1;
      opening = false;
      navigating = false;
      openingConversationId = "";
      activeConversationId = "";
      activeConversationKind = "";
      historyMessages = []; nextBeforeSeq = null; hasMore = false; loadingOlder = false; historyOffline = false; updateOlderButton();
      bootstrapAttempted = false;
      loadGeneration += 1; directory = null; friends.reset(); teams.reset(); lastSocial = null; socialDirty.people = true; socialDirty.teams = true;
      onlineView.reset();
      composer.reset?.();
      replySourceMasks.clear();
      attachments.reset();
      timeline?.replaceChildren();
      byId("collaborationInbox")?.replaceChildren();
      updateUnreadBadge([]);
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
  const directoryTimer = setInterval(() => { if (!disposed && !panel.hidden && policyEnabled) void load(); }, 15000);
  return { refresh, open: openConversation, loadOlder, show: () => { if (disposed) return; setActive(true); showSection(activeSection); void load(); }, hide: () => setActive(false), destroy: () => { onlineView.destroy(); presenceHeader.remove(); clearInterval(directoryTimer); disposed = true; viewGeneration += 1; openGeneration += 1; loadGeneration += 1; friends.reset(); teams.reset(); lastSocial = null; socialDirty.people = true; socialDirty.teams = true; attachments.destroy(); panelShell?.destroy(); for (const [button, handler] of sectionHandlers) button?.removeEventListener("click", handler); nav.removeEventListener("click", navClick); back?.removeEventListener("click", backClick); remoteTasks.destroy(); detach.destroy(); detail.destroy(); olderButton?.removeEventListener("click", loadOlder); unsubscribe?.(); unsubscribeLocale(); composer.destroy(); replySourceMasks.clear(); renderTimeline(); } };
}
