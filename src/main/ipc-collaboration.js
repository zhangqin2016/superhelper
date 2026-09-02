"use strict";
const { normalizeMentionCandidates } = require("./collaboration/mention-candidates");
const { directoryView } = require("./collaboration/directory-view");
const { normalizeSocialCommand, socialIdentifier } = require("./collaboration/social-command-contract");
const { attachmentIds } = require("./collaboration/history-cache");
const { transferResult, registerTransferIpc } = require("./collaboration/transfer-ipc");
const { messageMetadata, messageIdentifier, MAX_CREATE_BYTES } = require("./collaboration/message-intent");
const { normalizeReplySnapshot } = require("./collaboration/reply-snapshot");
const { validOperationRequest, operationResult } = require("./collaboration/message-operation-view");

// The collaboration renderer is deliberately not a transport client.  It only
// sees a small, validated command vocabulary; credentials and local encrypted
// storage remain in the main process.
const MAX_TEXT_BYTES = 64 * 1024;
const SENSITIVE_KEY = /(?:token|dek|key|secret|path|cipher|authorization|signature|credential)/i;

function unavailable() {
  return { ok: false, code: "COLLABORATION_UNAVAILABLE", retryable: false };
}

function invalid() {
  return { ok: false, code: "COLLABORATION_INVALID_INPUT", retryable: false };
}

function safeIdentifier(value) {
  return messageIdentifier(value) ? value : "";
}

function hasOnlyKeys(value, allowed) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => allowed.has(key));
}

function bytes(value) {
  return Buffer.byteLength(String(value || ""), "utf8");
}

function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !SENSITIVE_KEY.test(key))
    .map(([key, child]) => [key, sanitize(child)]));
}

function nonNegativeInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function optionalInteger(value) {
  if (value == null) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function rendererConversation(value = {}) {
  const fields = ["projectionSeq", "lastReadSeq", "unreadCount", "mentionCount"];
  const known = value.activityKnown === true && fields.every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0)
    && value.lastReadSeq <= value.projectionSeq && value.mentionCount <= value.unreadCount;
  return {
    id: safeIdentifier(value.id) || "", scopeId: safeIdentifier(value.scopeId) || "", kind: safeIdentifier(value.kind) || "",
    title: typeof value.title === "string" ? value.title.slice(0, 500) : "", updatedAt: nonNegativeInteger(value.updatedAt), lastSeq: optionalInteger(value.lastSeq), peerReadSeq: nonNegativeInteger(value.peerReadSeq),
    // Last-message preview for the list row. Bounded and re-sanitized here like
    // any other rendered text: only a sender id and a short single-line snippet
    // cross, never the envelope, paths or delivery internals.
    ...(value.lastMessage && typeof value.lastMessage.text === "string" && value.lastMessage.text.trim()
      ? { lastMessage: {
          senderUserId: safeIdentifier(value.lastMessage.senderUserId) || "",
          text: value.lastMessage.text.replace(/\s+/g, " ").trim().slice(0, 160),
        } }
      : {}),
    ...(value.activityKnown == null ? {} : known ? { activityKnown: true, ...Object.fromEntries(fields.map((key) => [key, value[key]])) } : { activityKnown: false }),
  };
}

function rendererMessage(value = {}) {
  return {
    id: safeIdentifier(value.id) || "", conversationId: safeIdentifier(value.conversationId) || "", seq: optionalInteger(value.seq),
    senderUserId: safeIdentifier(value.senderUserId) || "", isOwn: value.isOwn === true, state: safeIdentifier(value.state) || "",
    bodyText: typeof value.bodyText === "string" ? value.bodyText.slice(0, MAX_TEXT_BYTES) : "",
    kind: ["text", "attachment", "workspace_share"].includes(value.kind) ? value.kind : "text", attachmentIds: attachmentIds(value),
    ...(Array.isArray(value.reactions) && value.reactions.length ? { reactions: value.reactions.slice(0, 24).flatMap((entry) => {
      const emoji = typeof entry?.emoji === "string" ? entry.emoji.trim() : "";
      const count = Number(entry?.count);
      return emoji && emoji.length <= 32 && [...emoji].length <= 8 && Number.isSafeInteger(count) && count > 0
        ? [{ emoji, count, mine: entry.mine === true }] : [];
    }) } : {}),
    createdAt: optionalInteger(value.createdAt), clientCreatedAt: optionalInteger(value.clientCreatedAt), updatedAt: nonNegativeInteger(value.updatedAt),
    ...(safeIdentifier(value.clientCommandId) ? { clientCommandId: safeIdentifier(value.clientCommandId) } : {}),
    ...(optionalInteger(value.revision) != null ? { revision: optionalInteger(value.revision) } : {}),
    ...messageMetadata(value),
    replySnapshot: normalizeReplySnapshot(value),
    ...(typeof value.revokedAt === "string" ? { revokedAt: value.revokedAt.slice(0, 40) } : {}),
    ...(typeof value.editedAt === "string" ? { editedAt: value.editedAt.slice(0, 40) } : {}),
  };
}

function rendererOutbox(value = {}) {
  return {
    id: safeIdentifier(value.id) || "", conversationId: safeIdentifier(value.conversationId) || "", clientCommandId: safeIdentifier(value.clientCommandId) || "",
    scopeId: safeIdentifier(value.scopeId) || "", state: safeIdentifier(value.state) || "", attempts: nonNegativeInteger(value.attempts), createdAt: nonNegativeInteger(value.createdAt),
  };
}

function rendererView(method, value, payload, options = {}) {
  const transfer = transferResult(method, value, options);
  if (transfer) return transfer;
  if (["friend", "conversation", "retrySocial", "openFriend"].includes(method)) return {
    ok: value?.ok === true,
    ...Object.fromEntries(["clientCommandId", "state", "code", "conversationId"].filter((key) => socialIdentifier(value?.[key])).map((key) => [key, value[key]])),
  };
  if (value?.ok === false) return { ok: false, code: safeIdentifier(value.code) || "COLLABORATION_UNAVAILABLE", retryable: value.retryable === true };
  if (method === "readMessageOperations") return operationResult(value, payload);
  if (["retry", "skip", "cancel"].includes(method) && value?.ok !== true) return unavailable();
  if (method === "getSocialCommands") return { ok: true, commands: (value?.commands || []).flatMap((row) => {
    const input = normalizeSocialCommand(row.kind, row.input);
    return input && socialIdentifier(row.clientCommandId) ? [{ ...rendererView("retrySocial", row), kind: row.kind, scopeId: safeIdentifier(row.scopeId), input }] : [];
  }) };
  if (method === "getConversationDetails") return { ok: true, conversation: rendererConversation(value?.conversation), canManage: value?.canManage === true,
    mentionCandidates: normalizeMentionCandidates(value?.mentionCandidates, { allowUnknown: true }),
    visibility: ["public", "private"].includes(value?.visibility) ? value.visibility : null,
    members: (value?.members || []).map((m) => ({ userId: safeIdentifier(m.userId), role: ["owner", "admin", "member"].includes(m.role) ? m.role : "member",
      displayName: typeof m.displayName === "string" ? m.displayName.slice(0, 500) : "", lilyId: safeIdentifier(m.lilyId) })),
  };
  if (method === "getMentionCandidates") {
    if (value?.ok !== true || !messageIdentifier(value.conversationId) || value.conversationId !== payload?.conversationId
      || !Object.hasOwn(value, "mentionCandidates") || value.mentionCandidates === undefined) {
      return { ok: false, code: "COLLAB_MENTION_CANDIDATES_INVALID", retryable: false };
    }
    return { ok: true, conversationId: value.conversationId, mentionCandidates: normalizeMentionCandidates(value.mentionCandidates, { allowUnknown: true }) };
  }
  if (method === "getDirectory") return { ok: true, ...directoryView(value) };
  if (method === "getState") return { ok: true, cursor: nonNegativeInteger(value?.cursor), watermark: nonNegativeInteger(value?.watermark), outbox: Array.isArray(value?.outbox) ? value.outbox.map(rendererOutbox) : [] };
  if (method === "list") return { ok: true, conversations: Array.isArray(value?.conversations) ? value.conversations.map(rendererConversation) : [] };
  if (method === "open") return { ok: true, conversation: rendererConversation(value?.conversation), messages: Array.isArray(value?.messages) ? value.messages.map(rendererMessage) : [],
    hasMore: value?.hasMore === true, nextBeforeSeq: optionalInteger(value?.nextBeforeSeq), offline: value?.offline === true };
  if (method === "bootstrap") return { ok: true, cursor: nonNegativeInteger(value?.cursor) };
  if (method === "getDraft") return { ok: true, text: typeof value?.text === "string" ? value.text.slice(0, MAX_TEXT_BYTES) : "", ...messageMetadata(value || {}) };
  if (method === "saveDraft") return { ok: true };
  if (["getEditDraft", "saveEditDraft", "clearEditDraft"].includes(method)) {
    if (value?.ok !== true || value.conversationId !== payload?.conversationId || value.messageId !== payload?.messageId) {
      return { ok: false, code: "COLLAB_EDIT_DRAFT_INVALID", retryable: false };
    }
    if (method === "getEditDraft") {
      if (value.draft == null) return { ok: true, conversationId: payload.conversationId, messageId: payload.messageId, draft: null };
      const draft = value.draft;
      if (!draft || typeof draft !== "object" || Array.isArray(draft) || typeof draft.bodyText !== "string" || bytes(draft.bodyText) > MAX_TEXT_BYTES
        || !Number.isSafeInteger(draft.baseRevision) || draft.baseRevision < 1 || !Number.isSafeInteger(draft.generation) || draft.generation < 1
        || !Number.isSafeInteger(draft.updatedAt) || draft.updatedAt < 0) return { ok: false, code: "COLLAB_EDIT_DRAFT_INVALID", retryable: false };
      return { ok: true, conversationId: payload.conversationId, messageId: payload.messageId,
        draft: { bodyText: draft.bodyText, baseRevision: draft.baseRevision, generation: draft.generation, updatedAt: draft.updatedAt } };
    }
    if (method === "saveEditDraft" && Number.isSafeInteger(value.generation) && value.generation >= 1 && Number.isSafeInteger(value.updatedAt) && value.updatedAt >= 0) {
      return { ok: true, conversationId: payload.conversationId, messageId: payload.messageId, generation: value.generation, updatedAt: value.updatedAt };
    }
    if (method === "clearEditDraft" && typeof value.cleared === "boolean") return { ok: true, conversationId: payload.conversationId, messageId: payload.messageId, cleared: value.cleared };
    return { ok: false, code: "COLLAB_EDIT_DRAFT_INVALID", retryable: false };
  }
  if (method === "readMessages") return { ok: true, messages: (value?.messages || []).map(rendererMessage), unavailableMessageIds: (value?.unavailableMessageIds || []).map(safeIdentifier).filter(Boolean) };
  if (["send", "edit", "revoke", "friend", "retry", "skip", "cancel", "markRead"].includes(method)) {
    return {
      ok: value?.ok !== false,
      ...(safeIdentifier(value?.code) ? { code: safeIdentifier(value.code) } : {}),
      ...(typeof value?.retryable === "boolean" ? { retryable: value.retryable } : {}),
      ...(safeIdentifier(value?.clientCommandId) ? { clientCommandId: safeIdentifier(value.clientCommandId) } : {}),
      ...(safeIdentifier(value?.state) ? { state: safeIdentifier(value.state) } : {}),
      ...(safeIdentifier(value?.outboxId) ? { outboxId: safeIdentifier(value.outboxId) } : {}),
      ...(safeIdentifier(value?.conversationId) ? { conversationId: safeIdentifier(value.conversationId) } : {}),
      ...(safeIdentifier(value?.recovery) ? { recovery: safeIdentifier(value.recovery) } : {}),
      ...(typeof value?.canRevoke === "boolean" ? { canRevoke: value.canRevoke } : {}),
      ...(typeof value?.requiresSync === "boolean" ? { requiresSync: value.requiresSync } : {}),
      ...(optionalInteger(value?.seq) != null ? { seq: optionalInteger(value.seq) } : {}),
    };
  }
  return sanitize(value);
}

function serviceFor(getService) {
  try {
    const service = getService?.();
    return service?.ok === true ? service : null;
  } catch {
    return null;
  }
}

async function invoke(getService, method, payload, options = {}) {
  const service = serviceFor(getService);
  if (!service || typeof service[method] !== "function") return unavailable();
  try {
    const result = await service[method](payload);
    if (serviceFor(getService) !== service) return { ok: false, code: "COLLAB_ACCOUNT_CHANGED", retryable: false };
    return rendererView(method, result, payload, options);
  } catch (error) {
    return { ok: false, code: String(error?.code || "COLLABORATION_UNAVAILABLE"), retryable: false };
  }
}

function validSend(payload) {
  if (!hasOnlyKeys(payload, new Set(["conversationId", "clientCommandId", "bodyText", "replyToMessageId", "mentionUserIds"]))) return null;
  const conversationId = safeIdentifier(payload.conversationId);
  const clientCommandId = safeIdentifier(payload.clientCommandId);
  if (!conversationId || !clientCommandId || typeof payload.bodyText !== "string" || bytes(payload.bodyText) > MAX_CREATE_BYTES) return null;
  try { return { conversationId, clientCommandId, bodyText: payload.bodyText, ...messageMetadata(payload) }; } catch { return null; }
}

function validOutbox(payload) {
  if (!hasOnlyKeys(payload, new Set(["outboxId"]))) return null;
  const outboxId = safeIdentifier(payload.outboxId);
  return outboxId ? { outboxId } : null;
}

function validOpen(payload) {
  if (!hasOnlyKeys(payload, new Set(["conversationId"]))) return null;
  const conversationId = safeIdentifier(payload.conversationId);
  return conversationId ? { conversationId } : null;
}

function validMarkRead(payload) {
  if (!hasOnlyKeys(payload, new Set(["conversationId", "seq"]))) return null;
  const conversationId = safeIdentifier(payload.conversationId);
  const seq = Number(payload.seq);
  return conversationId && Number.isSafeInteger(seq) && seq >= 0 ? { conversationId, seq } : null;
}

function validMessageMutation(payload, { bodyRequired }) {
  const allowed = new Set(["conversationId", "messageId", "clientCommandId", "expectedRevision", ...(bodyRequired ? ["bodyText"] : [])]);
  if (!hasOnlyKeys(payload, allowed)) return null;
  const conversationId = safeIdentifier(payload.conversationId);
  const messageId = safeIdentifier(payload.messageId);
  const clientCommandId = safeIdentifier(payload.clientCommandId);
  const expectedRevision = Number(payload.expectedRevision);
  if (!conversationId || !messageId || !clientCommandId || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) return null;
  if (bodyRequired && (typeof payload.bodyText !== "string" || bytes(payload.bodyText) > MAX_TEXT_BYTES)) return null;
  return { conversationId, messageId, clientCommandId, expectedRevision, ...(bodyRequired ? { bodyText: payload.bodyText } : {}) };
}

function validEditDraftKey(payload) {
  if (!hasOnlyKeys(payload, new Set(["conversationId", "messageId"]))) return null;
  const conversationId = safeIdentifier(payload.conversationId);
  const messageId = safeIdentifier(payload.messageId);
  return conversationId && messageId ? { conversationId, messageId } : null;
}

function validSaveEditDraft(payload) {
  if (!hasOnlyKeys(payload, new Set(["conversationId", "messageId", "bodyText", "baseRevision", "expectedGeneration"]))) return null;
  const key = validEditDraftKey({ conversationId: payload.conversationId, messageId: payload.messageId });
  return key && typeof payload.bodyText === "string" && bytes(payload.bodyText) <= MAX_TEXT_BYTES
    && Number.isSafeInteger(payload.baseRevision) && payload.baseRevision >= 1
    && Number.isSafeInteger(payload.expectedGeneration) && payload.expectedGeneration >= 0
    ? { ...key, bodyText: payload.bodyText, baseRevision: payload.baseRevision, expectedGeneration: payload.expectedGeneration } : null;
}

function validClearEditDraft(payload) {
  if (!hasOnlyKeys(payload, new Set(["conversationId", "messageId", "expectedGeneration"]))) return null;
  const key = validEditDraftKey({ conversationId: payload.conversationId, messageId: payload.messageId });
  return key && Number.isSafeInteger(payload.expectedGeneration) && payload.expectedGeneration >= 0
    ? { ...key, expectedGeneration: payload.expectedGeneration } : null;
}

function validFriend(payload) {
  return normalizeSocialCommand("friend", payload);
}

function registerCommand(ipcMain, channel, getService, method, validate) {
  ipcMain.handle(channel, (_event, payload) => {
    const normalized = validate(payload);
    return normalized ? invoke(getService, method, normalized) : invalid();
  });
}

function createCollaborationIpc({ ipcMain, getService, subscribeState = () => () => {}, toPreviewUrl } = {}) {
  if (!ipcMain || typeof ipcMain.handle !== "function") throw new TypeError("ipcMain.handle is required");
  const subscriptions = new Map();
  const transferOptions = { ...(typeof toPreviewUrl === "function" ? { toPreviewUrl } : {}) };
  registerTransferIpc({ ipcMain, invoke: (method, payload) => invoke(getService, method, payload, transferOptions) });
  const emitState = async (sender, change = {}) => {
    if (!sender || sender.isDestroyed?.()) return;
    sender.send("collaboration:state", {
      type: safeIdentifier(change.type) || "state",
      state: await invoke(getService, "getState"),
    });
  };
  ipcMain.handle("collaboration:get-state", () => invoke(getService, "getState"));
  registerCommand(ipcMain, "collaboration:react", getService, "react", (payload) => {
    if (!hasOnlyKeys(payload, new Set(["conversationId", "messageId", "clientCommandId", "emoji", "active"]))) return null;
    const conversationId = safeIdentifier(payload.conversationId);
    const messageId = safeIdentifier(payload.messageId);
    const clientCommandId = safeIdentifier(payload.clientCommandId);
    const emoji = typeof payload.emoji === "string" ? payload.emoji.trim() : "";
    if (!conversationId || !messageId || !clientCommandId) return null;
    if (!emoji || emoji.length > 32 || [...emoji].length > 8 || /\s/.test(emoji)) return null;
    if (payload.active !== undefined && typeof payload.active !== "boolean") return null;
    return { conversationId, messageId, clientCommandId, emoji, active: payload.active !== false };
  });
  registerCommand(ipcMain, "collaboration:typing", getService, "typing", (payload) => {
    if (!hasOnlyKeys(payload, new Set(["conversationId"]))) return null;
    const conversationId = safeIdentifier(payload.conversationId);
    return conversationId ? { conversationId } : null;
  });
  ipcMain.handle("collaboration:list", () => invoke(getService, "list"));
  registerCommand(ipcMain, "collaboration:get-directory", getService, "getDirectory", (payload) =>
    payload === undefined || hasOnlyKeys(payload, new Set()) ? {} : null);
  ipcMain.handle("collaboration:bootstrap", () => invoke(getService, "bootstrap"));
  registerCommand(ipcMain, "collaboration:open", getService, "open", (payload) => {
    if (!hasOnlyKeys(payload, new Set(["conversationId", "beforeSeq"]))) return null;
    const normalized = validOpen({ conversationId: payload.conversationId });
    if (!normalized || (payload.beforeSeq != null && (!Number.isSafeInteger(payload.beforeSeq) || payload.beforeSeq < 1))) return null;
    return { ...normalized, ...(payload.beforeSeq == null ? {} : { beforeSeq: payload.beforeSeq }) };
  });
  registerCommand(ipcMain, "collaboration:get-draft", getService, "getDraft", validOpen);
  registerCommand(ipcMain, "collaboration:get-edit-draft", getService, "getEditDraft", validEditDraftKey);
  registerCommand(ipcMain, "collaboration:save-edit-draft", getService, "saveEditDraft", validSaveEditDraft);
  registerCommand(ipcMain, "collaboration:clear-edit-draft", getService, "clearEditDraft", validClearEditDraft);
  registerCommand(ipcMain, "collaboration:read-messages", getService, "readMessages", (payload) => {
    if (!hasOnlyKeys(payload, new Set(["conversationId", "messageIds"])) || !safeIdentifier(payload.conversationId) || !Array.isArray(payload.messageIds)
      || payload.messageIds.length < 1 || payload.messageIds.length > 200 || payload.messageIds.some((id) => !safeIdentifier(id)) || new Set(payload.messageIds).size !== payload.messageIds.length) return null;
    return { conversationId: safeIdentifier(payload.conversationId), messageIds: payload.messageIds.map(safeIdentifier) };
  });
  registerCommand(ipcMain, "collaboration:read-message-operations", getService, "readMessageOperations", validOperationRequest);
  registerCommand(ipcMain, "collaboration:save-draft", getService, "saveDraft", (payload) => {
    if (!hasOnlyKeys(payload, new Set(["conversationId", "text", "replyToMessageId", "mentionUserIds"])) || !safeIdentifier(payload.conversationId) || typeof payload.text !== "string" || bytes(payload.text) > MAX_TEXT_BYTES) return null;
    try { return { conversationId: safeIdentifier(payload.conversationId), text: payload.text, ...messageMetadata(payload) }; } catch { return null; }
  });
  registerCommand(ipcMain, "collaboration:send", getService, "send", validSend);
  registerCommand(ipcMain, "collaboration:edit", getService, "edit", (payload) => validMessageMutation(payload, { bodyRequired: true }));
  registerCommand(ipcMain, "collaboration:revoke", getService, "revoke", (payload) => validMessageMutation(payload, { bodyRequired: false }));
  registerCommand(ipcMain, "collaboration:friend", getService, "friend", validFriend);
  registerCommand(ipcMain, "collaboration:conversation", getService, "conversation", (p) => normalizeSocialCommand("conversation", p));
  registerCommand(ipcMain, "collaboration:get-social-commands", getService, "getSocialCommands", (p) => p === undefined || hasOnlyKeys(p, new Set()) ? {} : null);
  registerCommand(ipcMain, "collaboration:retry-social", getService, "retrySocial", (p) => hasOnlyKeys(p, new Set(["clientCommandId"])) && socialIdentifier(p.clientCommandId) ? { clientCommandId: p.clientCommandId } : null);
  registerCommand(ipcMain, "collaboration:open-friend", getService, "openFriend", (p) => hasOnlyKeys(p, new Set(["peerUserId"])) && socialIdentifier(p.peerUserId) ? { peerUserId: p.peerUserId } : null);
  registerCommand(ipcMain, "collaboration:get-conversation-details", getService, "getConversationDetails", validOpen);
  registerCommand(ipcMain, "collaboration:get-mention-candidates", getService, "getMentionCandidates", validOpen);
  registerCommand(ipcMain, "collaboration:retry", getService, "retry", validOutbox);
  registerCommand(ipcMain, "collaboration:cancel", getService, "cancel", validOutbox);
  registerCommand(ipcMain, "collaboration:skip", getService, "skip", validOutbox);
  registerCommand(ipcMain, "collaboration:mark-read", getService, "markRead", validMarkRead);
  ipcMain.handle("collaboration:subscribe", async (event) => {
    const sender = event?.sender;
    if (!sender) return unavailable();
    subscriptions.get(sender)?.();
    subscriptions.set(sender, subscribeState((change) => { void emitState(sender, change); }) || (() => {}));
    return invoke(getService, "getState");
  });
  ipcMain.handle("collaboration:unsubscribe", (event) => {
    const sender = event?.sender;
    subscriptions.get(sender)?.();
    subscriptions.delete(sender);
    return { ok: true };
  });
}

module.exports = { createCollaborationIpc, sanitize, rendererView, MAX_TEXT_BYTES };
