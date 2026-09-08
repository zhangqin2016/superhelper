import { t } from "../i18n/index.js";
import { identityName, resolvePerson } from "./collaboration-social-ui.js";
import { renderCollaborationTimeline } from "./collaboration-timeline.js";
import { createVisibleRead } from "./collaboration-visible-read.js";

const byId = (id) => document.getElementById(id);
const collabCommandId = () => globalThis.crypto?.randomUUID?.() || `collab-${Date.now()}-${Math.random().toString(16).slice(2)}`;

// Getters retain live navigation state across asynchronous message actions.
export function createCenterTimeline(ctx) {
  const visibleRead = createVisibleRead(ctx);
  const renderTimeline = () => {
    if (ctx.disposed) visibleRead.destroy();
    const wasAway = Boolean(ctx.activeConversationId) && ctx.timeline && !atThreadBottom();
    const grew = ctx.historyMessages.length - ctx.lastRenderedCount;
    if (wasAway && grew > 0) unseenBelow += grew;
    ctx.lastRenderedCount = ctx.historyMessages.length;
    const needle = ctx.searchQuery.trim().toLocaleLowerCase();
    const kept = ctx.inboxPrefs().applyMessages(ctx.historyMessages);
    const visibleMessages = needle ? kept.filter((message) => String(message.bodyText || "").toLocaleLowerCase().includes(needle)) : kept;
    renderCollaborationTimeline(ctx.timeline, visibleMessages, {
    currentUserId: ctx.directory?.profile?.userId || "",
    showSenderNames: ctx.activeConversationKind === "group" || ctx.activeConversationKind === "channel",
    peerReadSeq: ctx.activePeerReadSeq,
    unreadFromSeq: ctx.activeUnreadFromSeq,
    highlight: ctx.searchQuery.trim(),
    resolveSender: (userId) => identityName(resolvePerson(ctx.directory, userId)),
    onDownload: (input, purpose, preview) => ctx.attachments.download(input, purpose, preview),
    // Thumbnails resolve only for attachments already downloaded; the panel
    // owns the transfer list, so it answers by objectId and caches the URL.
    resolveAttachmentPreview: (objectId) => ctx.attachments.resolvePreview(objectId),
    onPreview: (objectId) => ctx.attachments.openPreview(objectId),
    canDownload: (purpose) => purpose === "workspace" ? ctx.transferPolicy.workspaceShares === true : ctx.transferPolicy.attachments === true,
    canReply: (message) => !ctx.disposed && ctx.policyEnabled && !ctx.panel.hidden && !ctx.navigating && Boolean(ctx.activeConversationId) && ctx.historyMessages.includes(message),
    onReply: (message) => {
      if (ctx.disposed || !ctx.policyEnabled || ctx.panel.hidden || ctx.navigating || !ctx.activeConversationId || !ctx.historyMessages.includes(message) || message.revokedAt || message.visibilityMask || !message.id || !(Number(message.seq) > 0)) return;
      ctx.composer.setReply?.({ messageId: message.id });
      byId("collaborationComposer")?.focus();
    },
    // Anyone in the conversation may react to any live message — unlike edit and
    // revoke, which are author-only.
    canReact: (message) => !ctx.disposed && ctx.policyEnabled && !ctx.panel.hidden && !ctx.navigating
      && Boolean(ctx.activeConversationId) && ctx.historyMessages.includes(message)
      && !message.revokedAt && !message.visibilityMask && Boolean(message.id) && Number(message.seq) > 0,
    onReact: (message, emoji, active) => {
      if (ctx.disposed || !ctx.policyEnabled || ctx.panel.hidden || ctx.navigating || !ctx.activeConversationId) return;
      if (!message?.id || !(Number(message.seq) > 0) || message.revokedAt || message.visibilityMask) return;
      const conversationId = ctx.activeConversationId;
      const clientCommandId = `rct_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
      void Promise.resolve(window.assistantClient?.collaboration?.react?.({
        conversationId, messageId: message.id, clientCommandId, emoji, active,
      })).then(async (result) => {
        if (ctx.disposed || conversationId !== ctx.activeConversationId) return;
        await ctx.openConversation(conversationId, { userNavigation: false });
        if (ctx.disposed || conversationId !== ctx.activeConversationId) return;
        if (result?.ok !== true || result?.state === "failed" || result?.state === "delivery_unknown") throw new Error("reaction failed");
      }).catch(() => {
        if (ctx.disposed || conversationId !== ctx.activeConversationId) return;
        if (ctx.status) { ctx.status.textContent = t("collaboration.reactionFailed"); ctx.status.classList.remove("is-available"); }
        if (ctx.live) ctx.live.textContent = t("collaboration.reactionFailed");
      });
    },
    canEdit: (message) => message.isOwn === true || message.senderUserId === ctx.directory?.profile?.userId,
    onEdit: (message) => {
      if (ctx.disposed || !ctx.policyEnabled || ctx.panel.hidden || ctx.navigating || !ctx.activeConversationId || !message.id) return;
      ctx.composer.beginEdit?.({ conversationId: ctx.activeConversationId, messageId: message.id, baseRevision: Number(message.revision) || 1, bodyText: message.bodyText || "" });
      byId("collaborationComposer")?.focus();
    },
    onForward: ctx.forwardMessage, selection: ctx.multiSelect, onDeleteLocal: ctx.deleteMessageLocally,
    canRevoke: (message) => message.isOwn === true || message.senderUserId === ctx.directory?.profile?.userId,
    onRevoke: async (message) => {
      if (ctx.disposed || !ctx.policyEnabled || !ctx.activeConversationId || !message.id) return;
      if (!window.confirm?.(t("collaboration.revoke.confirm"))) return;
      const result = await window.assistantClient?.collaboration?.revoke?.({ conversationId: ctx.activeConversationId, messageId: message.id, clientCommandId: collabCommandId(), expectedRevision: Number(message.revision) || 1 }).catch(() => null);
      if (result?.ok) void ctx.load();
    },
  });
    refreshScrollLatest();
    visibleRead.schedule();
  };
  // Scroll-to-latest: a thread scrolled away from the bottom must offer a way
  // back, and must say how many messages arrived while you were reading up.
  // Without it, "new messages arrived" is invisible unless you happen to be at
  // the bottom already, which is where the timeline auto-scrolls only when you
  // ALREADY were.
  const scrollLatest = byId("collaborationScrollLatest");
  const scrollLatestCount = byId("collaborationScrollLatestCount");
  let unseenBelow = 0;
  const atThreadBottom = () => !ctx.timeline || ctx.timeline.scrollHeight - ctx.timeline.scrollTop - ctx.timeline.clientHeight < 40;
  function refreshScrollLatest() {
    if (!scrollLatest) return;
    const away = Boolean(ctx.activeConversationId) && !atThreadBottom();
    if (!away) unseenBelow = 0;
    scrollLatest.hidden = !away;
    if (scrollLatestCount) {
      scrollLatestCount.hidden = unseenBelow < 1;
      scrollLatestCount.textContent = unseenBelow > 99 ? "99+" : String(unseenBelow);
    }
  }
  ctx.timeline?.addEventListener("scroll", refreshScrollLatest, { passive: true });
  scrollLatest?.addEventListener("click", () => {
    if (!ctx.timeline) return;
    ctx.timeline.scrollTop = ctx.timeline.scrollHeight;
    unseenBelow = 0;
    refreshScrollLatest();
  });

  return renderTimeline;
}
