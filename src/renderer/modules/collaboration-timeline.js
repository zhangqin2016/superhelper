import { t } from "../i18n/index.js";
import { replyDisplay } from "./collaboration-reply-view.js";

function messageKey(message) { return String(message.clientCommandId || message.id || ""); }

function deliveryLabel(message) {
  if (message.state === "delivery_unknown") return t("collaboration.deliveryUnknown");
  if (message.state === "confirming" || message.state === "submitting") return t("collaboration.confirming");
  if (message.state === "failed" || message.state === "paused") return t("collaboration.sendFailed");
  return "";
}

function sequence(message) {
  const value = Number(message.seq);
  return message.seq != null && Number.isSafeInteger(value) && value > 0 ? value : Infinity;
}

export function renderCollaborationTimeline(node, messages = [], { onDownload, canDownload = () => true, onReply, canReply = () => true, currentUserId = "", resolveSender = (id) => id } = {}) {
  if (!node) return;
  const prior = new Map([...node.children].map((child) => [child.dataset.messageKey, child]));
  const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
  const viewportTop = node.getBoundingClientRect().top + node.clientTop;
  const anchor = [...node.children].find((child) => child.getBoundingClientRect().bottom > viewportTop);
  const anchorOffset = anchor ? anchor.getBoundingClientRect().top - viewportTop : 0;
  let index = 0;
  for (const message of [...messages].sort((a, b) => sequence(a) - sequence(b) || Number(a.createdAt || 0) - Number(b.createdAt || 0))) {
    const key = messageKey(message);
    if (!key) continue;
    const row = prior.get(key) || document.createElement("article");
    row.className = "collaboration-message";
    const outgoing = Boolean(currentUserId && message.senderUserId === currentUserId);
    row.classList.toggle("is-outgoing", outgoing);
    row.dataset.messageKey = key;
    row.dataset.clientCommandId = String(message.clientCommandId || "");
    const senderName = String(resolveSender(message.senderUserId || "") || message.senderUserId || "");
    let avatar = row.querySelector(".collaboration-message-avatar");
    if (!avatar) { avatar = document.createElement("span"); avatar.className = "collaboration-message-avatar"; avatar.setAttribute("aria-hidden", "true"); row.prepend(avatar); }
    avatar.textContent = senderName.trim().slice(0, 1).toUpperCase() || "L";
    let bubble = row.querySelector(".collaboration-message-bubble");
    if (!bubble) { bubble = document.createElement("div"); bubble.className = "collaboration-message-bubble"; row.append(bubble); }
    let header = bubble.querySelector(".collaboration-message-header");
    if (!header) { header = document.createElement("header"); header.className = "collaboration-message-header"; bubble.prepend(header); }
    let author = header.querySelector(".collaboration-message-author");
    if (!author) { author = document.createElement("strong"); author.className = "collaboration-message-author"; header.append(author); }
    author.textContent = senderName;
    let time = header.querySelector("time");
    if (!time) { time = document.createElement("time"); header.append(time); }
    const createdAt = Number(message.createdAt || 0);
    time.dateTime = createdAt > 0 ? new Date(createdAt).toISOString() : "";
    time.textContent = createdAt > 0 ? new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(createdAt) : "";
    let body = row.querySelector(".collaboration-message-body");
    if (!body) { body = document.createElement("p"); body.className = "collaboration-message-body"; bubble.append(body); }
    const hiddenSource = message.revokedAt || message.visibilityMask;
    const text = message.visibilityMask === "unavailable" ? t("collaboration.messageUnavailable") : hiddenSource ? t("collaboration.messageRevoked") : String(message.bodyText || "");
    if (body.textContent !== text) body.textContent = text;
    const mentionIds = Array.isArray(message.mentionUserIds) ? [...new Set(message.mentionUserIds.filter((id) => typeof id === "string" && id))] : [];
    let mentions = row.querySelector(".collaboration-message-mentions");
    if (!hiddenSource && mentionIds.length) {
      if (!mentions) { mentions = document.createElement("small"); mentions.className = "collaboration-message-mentions"; bubble.append(mentions); }
      const label = currentUserId && mentionIds.includes(currentUserId) ? t("collaboration.mentions.you") : t("collaboration.mentions.count", { count: mentionIds.length });
      if (mentions.textContent !== label) mentions.textContent = label;
    } else mentions?.remove();
    let quote = row.querySelector(".collaboration-reply-quote");
    if (!hiddenSource && (message.replyToMessageId || message.replySnapshot)) {
      if (!quote) { quote = document.createElement("blockquote"); quote.className = "collaboration-reply-quote"; quote.dir = "auto"; bubble.insertBefore(quote, body); }
      const quoteText = replyDisplay(message.replySnapshot || { status: "unavailable", reason: "legacy" });
      if (quote.textContent !== quoteText) quote.textContent = quoteText;
    } else quote?.remove();
    let replyButton = row.querySelector('[data-action="reply-message"]');
    let actions = row.querySelector(".collaboration-message-actions");
    if (!actions) { actions = document.createElement("div"); actions.className = "collaboration-message-actions"; row.append(actions); }
    if (onReply && message.id && sequence(message) !== Infinity && !hiddenSource && canReply(message)) {
      if (!replyButton) { replyButton = document.createElement("button"); replyButton.type = "button"; replyButton.dataset.action = "reply-message"; actions.append(replyButton); }
      replyButton.textContent = t("collaboration.reply.action");
      replyButton.setAttribute("aria-label", t("collaboration.reply.action"));
      replyButton.onclick = () => {
        if (node.isConnected && !node.closest("[hidden]") && row.parentElement === node && replyButton.closest(".collaboration-message") === row && canReply(message)) onReply(message);
      };
    } else replyButton?.remove();
    let attachments = row.querySelector(".collaboration-message-attachments");
    const purpose = message.kind === "workspace_share" ? "workspace" : "attachment";
    if (!hiddenSource && message.attachmentIds?.length && onDownload && canDownload(purpose)) {
      if (!attachments) { attachments = document.createElement("div"); attachments.className = "collaboration-message-attachments"; bubble.append(attachments); }
      const existing = new Map([...attachments.children].map((button) => [button.dataset.objectId, button]));
      for (const objectId of message.attachmentIds) {
        const button = existing.get(objectId) || document.createElement("button"); button.type = "button";
        button.dataset.action = "download-attachment"; button.dataset.objectId = objectId;
        button.textContent = t("collaboration.transfer.download");
        button.onclick = () => onDownload({ conversationId: message.conversationId, messageId: message.id, objectId }, purpose);
        attachments.append(button); existing.delete(objectId);
      }
      for (const button of existing.values()) button.remove();
    } else attachments?.remove();
    const status = deliveryLabel(message);
    let meta = row.querySelector(".collaboration-message-status");
    if (status) {
      if (!meta) { meta = document.createElement("small"); meta.className = "collaboration-message-status"; bubble.append(meta); }
      if (meta.textContent !== status) meta.textContent = status;
    } else meta?.remove();
    if (node.children[index] !== row) node.insertBefore(row, node.children[index] || null);
    index += 1;
    prior.delete(key);
  }
  for (const child of prior.values()) child.remove();
  if (atBottom) node.scrollTop = node.scrollHeight;
  else if (anchor?.parentElement === node) node.scrollTop += anchor.getBoundingClientRect().top - viewportTop - anchorOffset;
}
