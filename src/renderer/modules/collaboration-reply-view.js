import { t } from "../i18n/index.js";

// Read-model evidence only, scoped to this account/view lifetime. Quote revision
// does not order source visibility: a later cache page must never unmask it.
export function createReplySourceMaskView() {
  const conversations = new Map();
  const get = (conversationId, messageId) => conversations.get(conversationId)?.get(messageId);
  const record = (conversationId, messageId, status) => {
    if (!conversationId || typeof messageId !== "string" || !messageId) return;
    if (!conversations.has(conversationId)) conversations.set(conversationId, new Map());
    const masks = conversations.get(conversationId);
    if (masks.get(messageId) !== "unavailable") masks.set(messageId, status);
  };
  return {
    get,
    observe(conversationId, messages) {
      for (const message of messages) {
        if (message.conversationId !== conversationId) continue;
        if (message.revokedAt) { record(conversationId, message.id, "revoked"); continue; }
        const snapshot = message.replySnapshot;
        // A revoked reply and a legacy missing snapshot prove nothing about
        // the target. Only explicit, non-legacy source masks propagate.
        if (snapshot && !snapshot.reason && ["revoked", "unavailable"].includes(snapshot.status)) record(conversationId, message.replyToMessageId, snapshot.status);
      }
    },
    apply(conversationId, messages) {
      return messages.map((message) => {
        if (message.conversationId !== conversationId) return message;
        const visibilityMask = get(conversationId, message.id), sourceMask = get(conversationId, message.replyToMessageId);
        const snapshot = message.replySnapshot;
        const maskQuote = sourceMask && !message.revokedAt && snapshot && snapshot.status !== "unavailable" && snapshot.status !== sourceMask;
        if ((!visibilityMask || visibilityMask === message.visibilityMask) && !maskQuote) return message;
        return { ...message, ...(visibilityMask ? { visibilityMask } : {}), ...(maskQuote ? { replySnapshot: { status: sourceMask } } : {}) };
      });
    },
    forget(conversationId) { conversations.delete(conversationId); },
    retainConversations(ids) { const allowed = new Set(ids); for (const id of conversations.keys()) if (!allowed.has(id)) conversations.delete(id); },
    clear() { conversations.clear(); },
  };
}

// Sent quotes receive only server snapshots; draft previews use authorized rows.
export function replyDisplay(snapshot) {
  if (snapshot?.status === "revoked") return t("collaboration.reply.revoked");
  if (snapshot?.status !== "available") return t(snapshot?.reason === "legacy" ? "collaboration.reply.legacy" : "collaboration.reply.unavailable");
  const body = String(snapshot.bodyText || "");
  const text = body || t(snapshot.kind === "workspace_share" ? "collaboration.reply.workspace" : snapshot.kind === "attachment" ? "collaboration.reply.attachment" : "collaboration.reply.empty");
  return snapshot.truncated ? `${text}\n${t("collaboration.reply.truncated")}` : text;
}

export function draftReplyPreview(message) {
  if (!message) return { status: "unavailable" };
  if (message.visibilityMask) return { status: message.visibilityMask };
  if (message.revokedAt) return { status: "revoked" };
  const points = [...String(message.bodyText || "")];
  return { status: "available", kind: message.kind, bodyText: points.slice(0, 512).join(""), truncated: points.length > 512 };
}
