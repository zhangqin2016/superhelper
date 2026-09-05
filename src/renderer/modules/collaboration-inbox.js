import { t } from "../i18n/index.js";
import { avatarHue, mosaicAvatar, conversationDisplayTitle, preserveScroll } from "./collaboration-social-ui.js";
import { openContextMenu } from "./context-menu.js";

function clear(node) { node?.replaceChildren(); }

function formatInboxTime(value) {
  const epoch = Number(value || 0);
  if (!Number.isSafeInteger(epoch) || epoch <= 0) return "";
  const at = new Date(epoch);
  if (Number.isNaN(at.getTime())) return "";
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (at >= midnight) {
    return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(at);
  }
  if (at >= midnight - 7 * 24 * 60 * 60 * 1000) {
    return new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(at);
  }
  return new Intl.DateTimeFormat(undefined, { month: "2-digit", day: "2-digit" }).format(at);
}

export function renderCollaborationInbox(node, conversations = [], options = {}) {
  if (!node) return;
  preserveScroll(node, () => paintInboxRows(node, conversations, options));
}

function paintInboxRows(node, conversations, options) {
  const { onOpen = () => {}, teams = [], activeConversationId = "", filterText = "", resolveSender = () => "", currentUserId = "", prefs = null, onPrefsChange = () => {} } = options;
  const displayTitle = (conversation) => conversationDisplayTitle(conversation, { currentUserId, resolveName: resolveSender });
  clear(node);
  // Pinned float to the top, muted are dimmed, deleted are hidden — applied
  // here so every render (load, search, pref change) stays consistent.
  const source = conversations;
  conversations = prefs ? prefs.apply(conversations) : conversations;
  const needle = String(filterText || "").trim().toLocaleLowerCase();
  const rows = [...conversations]
    .filter((conversation) => !needle || displayTitle(conversation).toLocaleLowerCase().includes(needle))
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || Number(b.lastSeq || 0) - Number(a.lastSeq || 0) || Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  const activeId = String(activeConversationId || "");
  if (rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "collaboration-empty";
    empty.textContent = t("collaboration.empty");
    node.append(empty);
    return;
  }
  for (const conversation of rows) {
    const conversationId = String(conversation.id || "");
    const item = document.createElement("button");
    item.type = "button";
    item.className = `collaboration-inbox-item${conversationId === activeId ? " is-active" : ""}`
      + (Number(conversation.unreadCount || 0) > 0 ? " is-unread" : "");
    item.dataset.conversationId = conversationId;
    item.setAttribute("aria-current", conversationId === activeId ? "page" : "false");
    if (conversation.pinned) item.classList.add("is-pinned");
    if (conversation.muted) item.classList.add("is-muted");
    if (prefs) item.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      const repaint = () => renderCollaborationInbox(node, source, options);
      openContextMenu({ x: event.clientX, y: event.clientY, items: [
        { label: t(prefs.isPinned(conversationId) ? "collaboration.unpinChat" : "collaboration.pinChat"), onSelect: () => { prefs.togglePin(conversationId); repaint(); onPrefsChange({ action: "pin", conversationId }); } },
        { label: t(prefs.isMuted(conversationId) ? "collaboration.unmuteChat" : "collaboration.muteChat"), onSelect: () => { prefs.toggleMute(conversationId); repaint(); onPrefsChange({ action: "mute", conversationId }); } },
        "separator",
        { label: t("collaboration.deleteChat"), danger: true, onSelect: () => { prefs.hide(conversationId, conversation.updatedAt); repaint(); onPrefsChange({ action: "delete", conversationId }); } },
      ] });
    });
    const scopeId = String(conversation.scopeId || "personal");
    const scope = scopeId.startsWith("team:") ? (teams.find((team) => team.scopeId === scopeId)?.name || t("collaboration.scopeTeam")) : t("collaboration.scopePersonal");
    const title = displayTitle(conversation);
    // A group's tile is composed from its members. A single title initial gave
    // every "设计…" conversation the same avatar, which is the common case in a
    // workspace; a direct chat keeps the single initial, as it should.
    const avatarKind = scopeId.startsWith("team:") ? "team" : "chat";
    const memberNames = conversation.kind === "direct" ? []
      : (Array.isArray(conversation.memberUserIds) ? conversation.memberUserIds : [])
        .filter((userId) => userId !== currentUserId)
        .map((userId) => String(resolveSender?.(userId) || "").trim())
        .filter(Boolean);
    const avatar = mosaicAvatar(title, memberNames, avatarKind);
    const content = document.createElement("span"); content.className = "collaboration-row-content";
    const heading = document.createElement("strong"); heading.textContent = title;
    heading.title = title;
    // A chat row's second line is the LAST MESSAGE — that is what makes a list
    // read as an IM. It used to show the scope ("个人" / team name), which is
    // constant per row and told the user nothing. Scope stays as the fallback
    // for a conversation with no messages yet.
    const preview = conversation.lastMessage;
    const previewOwn = Boolean(preview && currentUserId && preview.senderUserId === currentUserId);
    const previewSender = preview && !previewOwn ? String(resolveSender?.(preview.senderUserId) || "").trim() : "";
    const previewText = preview ? String(preview.text || "").trim() : "";
    const metadata = document.createElement("small");
    // "你: …" for your own last message, the sender's name in a group, bare text
    // in a 1:1. Same convention as every mainstream messenger.
    const speaker = previewOwn ? t("collaboration.selfPrefix")
      : (previewSender && !/^usr_[a-z0-9]+$/i.test(previewSender) ? previewSender : "");
    metadata.textContent = previewText ? (speaker ? `${speaker}: ${previewText}` : previewText) : scope;
    if (previewText) metadata.title = metadata.textContent;
    content.append(heading, metadata); item.append(avatar, content);
    const unread = Number(conversation.unreadCount || 0);
    const meta = document.createElement("span");
    meta.className = "collaboration-row-meta";
    const time = formatInboxTime(conversation.updatedAt);
    if (time) {
      const timeNode = document.createElement("small");
      timeNode.className = "collaboration-row-time";
      timeNode.textContent = time;
      meta.append(timeNode);
    }
    if (meta.childNodes.length) item.append(meta);
    if (unread > 0) { const badge = document.createElement("span"); badge.className = "collaboration-row-unread" + (conversation.muted ? " is-dot" : ""); badge.textContent = conversation.muted ? "" : (unread > 99 ? "99+" : String(unread)); badge.setAttribute("aria-label", String(unread)); meta.append(badge); }
    item.addEventListener("click", () => onOpen(conversationId));
    node.append(item);
  }
}

/** Move the active-row highlight to a conversation without rebuilding the list.
 *  Opening a conversation switches the thread immediately, but the list is only
 *  re-rendered on a later state event, so without this the highlight lagged
 *  behind — the row appeared to switch only after the next sync (e.g. a send). */
export function setActiveConversation(node, conversationId) {
  if (!node?.querySelectorAll) return;
  const id = String(conversationId || "");
  for (const item of node.querySelectorAll(".collaboration-inbox-item")) {
    const on = item.dataset.conversationId === id;
    item.classList.toggle("is-active", on);
    item.setAttribute("aria-current", on ? "page" : "false");
  }
}
