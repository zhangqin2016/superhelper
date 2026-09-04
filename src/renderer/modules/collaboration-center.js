import { t, onLocaleChange } from "../i18n/index.js";
import { identityName, resolvePerson } from "./collaboration-social-ui.js";
import { renderCollaborationInbox, setActiveConversation } from "./collaboration-inbox.js";
import { renderCollaborationTimeline } from "./collaboration-timeline.js";
import { initCollaborationComposer } from "./collaboration-composer.js";
import { applyCollaborationHistoryPage } from "./collaboration-history-view.js";
import { refreshVisibleHistory } from "./collaboration-visible-history.js";
import { initCollaborationFriends } from "./collaboration-friends.js";
import { initCollaborationTeams } from "./collaboration-teams.js";
import { createDetailSurface, createDetachControl, wireConversationHeader } from "./collaboration-panel-surfaces.js";
import { initCollaborationAttachments } from "./collaboration-attachments.js";
import { createReplySourceMaskView } from "./collaboration-reply-view.js";
import { initCollaborationPanelShell } from "./collaboration-panel-shell.js";

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
  const attachments = initCollaborationAttachments({ root: byId("collaborationTransfers"), attachButton: byId("collaborationAttachButton") });
  let lastRenderedCount = 0;
  // The most recent social payload, plus which hidden list still needs it.
  let lastSocial = null;
  const socialDirty = { people: true, teams: true };
  const flushSocial = (section) => {
    if (!lastSocial) return;
    if (section === "people" && socialDirty.people) { socialDirty.people = false; friends.update(lastSocial); }
    if (section === "teams" && socialDirty.teams) { socialDirty.teams = false; teams.update(lastSocial); }
  };
  const renderTimeline = () => {
    const wasAway = Boolean(activeConversationId) && timeline && !atThreadBottom();
    const grew = historyMessages.length - lastRenderedCount;
    if (wasAway && grew > 0) unseenBelow += grew;
    lastRenderedCount = historyMessages.length;
    const needle = searchQuery.trim().toLocaleLowerCase();
    const visibleMessages = needle ? historyMessages.filter((message) => String(message.bodyText || "").toLocaleLowerCase().includes(needle)) : historyMessages;
    renderCollaborationTimeline(timeline, visibleMessages, {
    currentUserId: directory?.profile?.userId || "",
    showSenderNames: activeConversationKind === "group" || activeConversationKind === "channel",
    peerReadSeq: activePeerReadSeq,
    unreadFromSeq: activeUnreadFromSeq,
    highlight: searchQuery.trim(),
    resolveSender: (userId) => identityName(resolvePerson(directory, userId)),
    onDownload: (input, purpose) => attachments.download(input, purpose),
    // Thumbnails resolve only for attachments already downloaded; the panel
    // owns the transfer list, so it answers by objectId and caches the URL.
    resolveAttachmentPreview: (objectId) => attachments.resolvePreview(objectId),
    onPreview: (objectId) => attachments.openPreview(objectId),
    canDownload: (purpose) => purpose === "workspace" ? transferPolicy.workspaceShares === true : transferPolicy.attachments === true,
    canReply: (message) => !disposed && policyEnabled && !panel.hidden && !navigating && Boolean(activeConversationId) && historyMessages.includes(message),
    onReply: (message) => {
      if (disposed || !policyEnabled || panel.hidden || navigating || !activeConversationId || !historyMessages.includes(message) || message.revokedAt || message.visibilityMask || !message.id || !(Number(message.seq) > 0)) return;
      composer.setReply?.({ messageId: message.id });
      byId("collaborationComposer")?.focus();
    },
    // Anyone in the conversation may react to any live message — unlike edit and
    // revoke, which are author-only.
    canReact: (message) => !disposed && policyEnabled && !panel.hidden && !navigating
      && Boolean(activeConversationId) && historyMessages.includes(message)
      && !message.revokedAt && !message.visibilityMask && Boolean(message.id) && Number(message.seq) > 0,
    onReact: (message, emoji, active) => {
      if (disposed || !policyEnabled || panel.hidden || navigating || !activeConversationId) return;
      if (!message?.id || !(Number(message.seq) > 0) || message.revokedAt || message.visibilityMask) return;
      const conversationId = activeConversationId;
      const clientCommandId = `rct_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
      void Promise.resolve(window.assistantClient?.collaboration?.react?.({
        conversationId, messageId: message.id, clientCommandId, emoji, active,
      })).then((result) => {
        // The optimistic flip lives in the main-process projection, so a refresh
        // is what reveals it — and also what corrects it if the command failed.
        if (!disposed && conversationId === activeConversationId) void openConversation(conversationId, { userNavigation: false });
        return result;
      }).catch(() => undefined);
    },
    canEdit: (message) => message.isOwn === true || message.senderUserId === directory?.profile?.userId,
    onEdit: (message) => {
      if (disposed || !policyEnabled || panel.hidden || navigating || !activeConversationId || !message.id) return;
      composer.beginEdit?.({ conversationId: activeConversationId, messageId: message.id, baseRevision: Number(message.revision) || 1, bodyText: message.bodyText || "" });
      byId("collaborationComposer")?.focus();
    },
    canRevoke: (message) => message.isOwn === true || message.senderUserId === directory?.profile?.userId,
    onRevoke: async (message) => {
      if (disposed || !policyEnabled || !activeConversationId || !message.id) return;
      if (!window.confirm?.(t("collaboration.revoke.confirm"))) return;
      const result = await window.assistantClient?.collaboration?.revoke?.({ conversationId: activeConversationId, messageId: message.id, clientCommandId: collabCommandId(), expectedRevision: Number(message.revision) || 1 }).catch(() => null);
      if (result?.ok) void load();
    },
  });
    refreshScrollLatest();
  };
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
  const sectionNodes = { inbox: byId("collaborationInbox"), people: byId("collaborationFriends"), teams: byId("collaborationTeams") };
  const sectionButtons = { inbox: byId("collaborationInboxTab"), people: byId("collaborationPeopleTab"), teams: byId("collaborationTeamsTab") };
  function showSection(section) {
    navigationGeneration += 1;
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
    // Render the destination now if it fell behind while it was hidden.
    flushSocial(section);
    panelShell?.setConversationOpen(false);
  }
  const detailSurface = { open: openDetail, close: closeDetail };
  const friends = initCollaborationFriends(sectionNodes.people, { onChanged: () => load({ checkAccess: true }), onOpen: (id) => openConversation(id), getNavigationGeneration: () => navigationGeneration, detail: detailSurface });
  const teams = initCollaborationTeams(sectionNodes.teams, { onChanged: () => load({ checkAccess: true }), onOpen: (id) => openConversation(id), getNavigationGeneration: () => navigationGeneration, detail: detailSurface });
  const sectionHandlers = Object.entries(sectionButtons).map(([section, button]) => {
    const handler = () => { showSection(section); void load(); }; button?.addEventListener("click", handler); return [button, handler];
  });
  const detach = createDetachControl({
    button: byId("collaborationPanelDetach"),
    onDetached: () => { panelShell ? panelShell.closePanel() : setActive(false); },
    isDisposed: () => disposed,
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
    activeConversationKind = "";
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
    panelShell?.setConversationOpen(true);
    // The search bar stays hidden until the header's search icon asks for it.
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
  const updateUnreadBadge = (conversations = []) => {
    const total = (Array.isArray(conversations) ? conversations : []).reduce((sum, row) => sum + (Number(row.unreadCount) > 0 ? Number(row.unreadCount) : 0), 0);
    // A dot on the rail's inbox tile; the exact count stays on the panel toggle.
    if (railUnread) railUnread.hidden = total <= 0;
    if (!unreadBadge) return;
    unreadBadge.hidden = total <= 0;
    unreadBadge.textContent = total > 99 ? "99+" : String(total);
  };
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
    renderCollaborationInbox(
      byId("collaborationInbox"),
      result?.conversations || result?.rows || [],
      { onOpen: openConversation, teams: directory?.teams || [], activeConversationId, filterText: inboxFilter,
        resolveSender: (userId) => identityName(resolvePerson(directory, userId)),
        currentUserId: directory?.profile?.userId || "" },
    );
    lastConversations = result?.conversations || result?.rows || [];
    updateUnreadBadge(result?.conversations);
    const available = result?.ok === true;
    if (status) { status.textContent = t(available ? (historyOffline ? "collaboration.offlineCache" : "collaboration.statusAvailable") : "collaboration.statusUnavailable"); status.classList.toggle("is-available", available); }
  };
  const navClick = () => {
    if (!panelShell) setActive(true);
    queueMicrotask(() => { composer.setActive?.(!panel.hidden && policyEnabled && !navigating); if (!panel.hidden) void load(); });
  };
  const backClick = () => { conversationHeaderControl?.reset(); searchQuery = ""; panelShell ? panelShell.setConversationOpen(false) : setActive(false); };
  nav.addEventListener("click", navClick);
  back?.addEventListener("click", backClick);
  const searchInput = () => {
    const value = inboxSearch?.value || "";
    // The same box filters whichever list is on screen.
    if (activeSection === "people") { friends.setFilter(value); return; }
    inboxFilter = value;
    renderCollaborationInbox(byId("collaborationInbox"), lastConversations, { onOpen: openConversation, teams: directory?.teams || [], activeConversationId, filterText: inboxFilter,
      resolveSender: (userId) => identityName(resolvePerson(directory, userId)),
      currentUserId: directory?.profile?.userId || "" });
  };
  inboxSearch?.addEventListener("input", searchInput);
  // Header-icon controls: search (toggle, not a persistent bar) and group info.
  const conversationHeaderControl = wireConversationHeader({ input: conversationSearch, toggle: byId("collaborationConversationSearchToggle"), infoButton: byId("collaborationConversationInfo"),
    onChange: (value) => { searchQuery = value; renderTimeline(); },
    onInfo: () => { if (!activeConversationId) return; if (lastSocial) teams.update(lastSocial); void teams.showConversation(activeConversationId); } });

  // Scroll-to-latest: a thread scrolled away from the bottom must offer a way
  // back, and must say how many messages arrived while you were reading up.
  // Without it, "new messages arrived" is invisible unless you happen to be at
  // the bottom already, which is where the timeline auto-scrolls only when you
  // ALREADY were.
  const scrollLatest = byId("collaborationScrollLatest");
  const scrollLatestCount = byId("collaborationScrollLatestCount");
  let unseenBelow = 0;
  const atThreadBottom = () => !timeline || timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 40;
  function refreshScrollLatest() {
    if (!scrollLatest) return;
    const away = Boolean(activeConversationId) && !atThreadBottom();
    if (!away) unseenBelow = 0;
    scrollLatest.hidden = !away;
    if (scrollLatestCount) {
      scrollLatestCount.hidden = unseenBelow < 1;
      scrollLatestCount.textContent = unseenBelow > 99 ? "99+" : String(unseenBelow);
    }
  }
  timeline?.addEventListener("scroll", refreshScrollLatest, { passive: true });
  scrollLatest?.addEventListener("click", () => {
    if (!timeline) return;
    timeline.scrollTop = timeline.scrollHeight;
    unseenBelow = 0;
    refreshScrollLatest();
  });

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
  function renderTypingHint(state) {
    const node = byId("collaborationTyping");
    if (!node) return;
    const ids = (activeConversationId && state?.typing?.[activeConversationId]) || [];
    const others = ids.filter((userId) => userId && userId !== (directory?.profile?.userId || ""));
    if (!others.length) { node.hidden = true; node.textContent = ""; return; }
    const named = others.map((userId) => identityName(resolvePerson(directory, userId))).filter((name) => name && !/^usr_[a-z0-9]+$/i.test(name));
    node.textContent = others.length > 1
      ? t("collaboration.typing.many", { count: others.length })
      : (named[0] ? t("collaboration.typing.one", { name: named[0] }) : t("collaboration.typing.someone"));
    node.hidden = false;
  }
  const unsubscribe = window.assistantClient?.collaboration?.onStateChange?.((payload) => {
    if (payload?.state?.ok === true) renderTypingHint(payload.state);
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
  return { refresh, open: openConversation, loadOlder, show: () => { if (disposed) return; setActive(true); showSection(activeSection); void load(); }, hide: () => setActive(false), destroy: () => { disposed = true; viewGeneration += 1; openGeneration += 1; loadGeneration += 1; friends.reset(); teams.reset(); lastSocial = null; socialDirty.people = true; socialDirty.teams = true; attachments.destroy(); panelShell?.destroy(); for (const [button, handler] of sectionHandlers) button?.removeEventListener("click", handler); nav.removeEventListener("click", navClick); back?.removeEventListener("click", backClick); detach.destroy(); detail.destroy(); olderButton?.removeEventListener("click", loadOlder); unsubscribe?.(); unsubscribeLocale(); composer.destroy(); replySourceMasks.clear(); renderTimeline(); } };
}
