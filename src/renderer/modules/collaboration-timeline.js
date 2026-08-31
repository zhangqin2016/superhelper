import { t } from "../i18n/index.js";

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

export function renderCollaborationTimeline(node, messages = [], { onDownload, canDownload = () => true } = {}) {
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
    row.dataset.messageKey = key;
    row.dataset.clientCommandId = String(message.clientCommandId || "");
    let body = row.querySelector(".collaboration-message-body");
    if (!body) { body = document.createElement("p"); body.className = "collaboration-message-body"; row.append(body); }
    const text = message.revokedAt ? t("collaboration.messageRevoked") : String(message.bodyText || "");
    if (body.textContent !== text) body.textContent = text;
    let attachments = row.querySelector(".collaboration-message-attachments");
    const purpose = message.kind === "workspace_share" ? "workspace" : "attachment";
    if (!message.revokedAt && message.attachmentIds?.length && onDownload && canDownload(purpose)) {
      if (!attachments) { attachments = document.createElement("div"); attachments.className = "collaboration-message-attachments"; row.append(attachments); }
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
      if (!meta) { meta = document.createElement("small"); meta.className = "collaboration-message-status"; row.append(meta); }
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
