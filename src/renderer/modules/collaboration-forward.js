/**
 * WeChat's 转发: pick one chat, and the message's text is sent there.
 *
 * A modal over the panel with a search box and the conversation list. The
 * source conversation is excluded — forwarding to the chat you are already in
 * is the one target that is never what you meant. Picking is a single click,
 * because `send` takes one conversation per call.
 */
import { t } from "../i18n/index.js";
import { mosaicAvatar } from "./collaboration-social-ui.js";

let openPicker = null;

function close() {
  if (!openPicker) return;
  const { scrim, onKey } = openPicker;
  openPicker = null;
  document.removeEventListener("keydown", onKey, true);
  scrim.remove();
}

export function closeForwardPicker() { close(); }

export function openForwardPicker({ conversations = [], resolveSender = () => "", currentUserId = "", excludeId = "", onPick } = {}) {
  close();
  const targets = (Array.isArray(conversations) ? conversations : []).filter((c) => c && c.id && c.id !== excludeId);

  const scrim = document.createElement("div");
  scrim.className = "collab-forward-scrim";
  const panel = document.createElement("div");
  panel.className = "collab-forward-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");

  const heading = document.createElement("h2");
  heading.className = "collab-forward-title";
  heading.textContent = t("collaboration.forwardTitle");
  const search = document.createElement("input");
  search.type = "search";
  search.className = "collab-forward-search";
  search.placeholder = t("collaboration.forwardSearch");
  search.setAttribute("aria-label", t("collaboration.forwardSearch"));
  const list = document.createElement("div");
  list.className = "collab-forward-list";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "collab-forward-cancel";
  cancel.textContent = t("collaboration.forwardCancel");
  cancel.addEventListener("click", close);

  const pick = (conversation) => { close(); try { onPick?.(conversation); } catch { /* the caller reports its own failure */ } };

  const paint = () => {
    const needle = search.value.trim().toLocaleLowerCase();
    const rows = targets.filter((c) => !needle || String(c.title || "").toLocaleLowerCase().includes(needle));
    list.replaceChildren();
    if (!rows.length) {
      const empty = document.createElement("p");
      empty.className = "collab-forward-empty";
      empty.textContent = t("collaboration.forwardEmpty");
      list.append(empty);
      return;
    }
    for (const conversation of rows) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "collab-forward-row";
      row.dataset.conversationId = String(conversation.id);
      const title = String(conversation.title || conversation.id || "");
      const names = conversation.kind === "direct" ? []
        : (Array.isArray(conversation.memberUserIds) ? conversation.memberUserIds : [])
          .filter((userId) => userId !== currentUserId)
          .map((userId) => String(resolveSender(userId) || "").trim())
          .filter(Boolean);
      row.append(mosaicAvatar(title, names, String(conversation.scopeId || "").startsWith("team:") ? "team" : "chat"));
      const label = document.createElement("span");
      label.className = "collab-forward-row-title";
      label.textContent = title;
      row.append(label);
      row.addEventListener("click", () => pick(conversation));
      list.append(row);
    }
  };

  const onKey = (event) => {
    if (event.key === "Escape") { event.preventDefault(); close(); return; }
    if (event.key === "Enter" && document.activeElement === search) {
      event.preventDefault();
      list.querySelector(".collab-forward-row")?.click();
    }
  };

  search.addEventListener("input", paint);
  document.addEventListener("keydown", onKey, true);
  scrim.addEventListener("pointerdown", (event) => { if (event.target === scrim) close(); });

  panel.append(heading, search, list, cancel);
  scrim.append(panel);
  document.body.append(scrim);
  paint();
  openPicker = { scrim, onKey };
  requestAnimationFrame(() => search.focus?.());
}

/** The message-menu action: open the picker, then send this message's text to
 *  the chosen chat. Kept here so the centre stays a wiring layer. */
export function createForwardAction({ getConversations = () => [], getActiveConversationId = () => "", getCurrentUserId = () => "", resolveSender = () => "", send = async () => null, isEnabled = () => true } = {}) {
  return (message) => {
    if (!isEnabled()) return;
    const bodyText = String(message?.bodyText || "").trim();
    if (!bodyText) return;
    openForwardPicker({
      conversations: getConversations(), excludeId: getActiveConversationId(),
      currentUserId: getCurrentUserId(), resolveSender,
      onPick: (target) => { void Promise.resolve(send({ conversationId: target.id, bodyText })).catch(() => null); },
    });
  };
}
