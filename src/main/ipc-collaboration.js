"use strict";

// The collaboration renderer is deliberately not a transport client.  It only
// sees a small, validated command vocabulary; credentials and local encrypted
// storage remain in the main process.
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_IDENTIFIER_LENGTH = 200;
const SENSITIVE_KEY = /(?:token|dek|key|secret|path|cipher|authorization|signature|credential)/i;

function unavailable() {
  return { ok: false, code: "COLLABORATION_UNAVAILABLE", retryable: false };
}

function invalid() {
  return { ok: false, code: "COLLABORATION_INVALID_INPUT", retryable: false };
}

function safeIdentifier(value) {
  const id = typeof value === "string" ? value.trim() : "";
  return id && id.length <= MAX_IDENTIFIER_LENGTH ? id : "";
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
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function rendererConversation(value = {}) {
  return {
    id: safeIdentifier(value.id) || "", scopeId: safeIdentifier(value.scopeId) || "", kind: safeIdentifier(value.kind) || "",
    title: typeof value.title === "string" ? value.title.slice(0, 500) : "", updatedAt: nonNegativeInteger(value.updatedAt), lastSeq: optionalInteger(value.lastSeq),
  };
}

function rendererMessage(value = {}) {
  return {
    id: safeIdentifier(value.id) || "", conversationId: safeIdentifier(value.conversationId) || "", seq: optionalInteger(value.seq),
    senderUserId: safeIdentifier(value.senderUserId) || "", state: safeIdentifier(value.state) || "",
    bodyText: typeof value.bodyText === "string" ? value.bodyText.slice(0, MAX_TEXT_BYTES) : "",
    createdAt: nonNegativeInteger(value.createdAt), updatedAt: nonNegativeInteger(value.updatedAt),
  };
}

function rendererOutbox(value = {}) {
  return {
    id: safeIdentifier(value.id) || "", conversationId: safeIdentifier(value.conversationId) || "", clientCommandId: safeIdentifier(value.clientCommandId) || "",
    scopeId: safeIdentifier(value.scopeId) || "", state: safeIdentifier(value.state) || "", attempts: nonNegativeInteger(value.attempts), createdAt: nonNegativeInteger(value.createdAt),
  };
}

function rendererView(method, value) {
  if (value?.ok === false) return { ok: false, code: safeIdentifier(value.code) || "COLLABORATION_UNAVAILABLE", retryable: value.retryable === true };
  if (method === "getState") return { ok: true, cursor: nonNegativeInteger(value?.cursor), watermark: nonNegativeInteger(value?.watermark), outbox: Array.isArray(value?.outbox) ? value.outbox.map(rendererOutbox) : [] };
  if (method === "list") return { ok: true, conversations: Array.isArray(value?.conversations) ? value.conversations.map(rendererConversation) : [] };
  if (method === "open") return { ok: true, conversation: rendererConversation(value?.conversation), messages: Array.isArray(value?.messages) ? value.messages.map(rendererMessage) : [] };
  if (method === "bootstrap") return { ok: true, cursor: nonNegativeInteger(value?.cursor) };
  if (["send", "retry", "cancel", "markRead"].includes(method)) {
    return {
      ok: value?.ok !== false,
      ...(safeIdentifier(value?.code) ? { code: safeIdentifier(value.code) } : {}),
      ...(typeof value?.retryable === "boolean" ? { retryable: value.retryable } : {}),
      ...(safeIdentifier(value?.clientCommandId) ? { clientCommandId: safeIdentifier(value.clientCommandId) } : {}),
      ...(safeIdentifier(value?.state) ? { state: safeIdentifier(value.state) } : {}),
      ...(safeIdentifier(value?.outboxId) ? { outboxId: safeIdentifier(value.outboxId) } : {}),
      ...(safeIdentifier(value?.conversationId) ? { conversationId: safeIdentifier(value.conversationId) } : {}),
      ...(safeIdentifier(value?.recovery) ? { recovery: safeIdentifier(value.recovery) } : {}),
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

async function invoke(getService, method, payload) {
  const service = serviceFor(getService);
  if (!service || typeof service[method] !== "function") return unavailable();
  try {
    return rendererView(method, await service[method](payload));
  } catch (error) {
    return { ok: false, code: String(error?.code || "COLLABORATION_UNAVAILABLE"), retryable: false };
  }
}

function validSend(payload) {
  if (!hasOnlyKeys(payload, new Set(["conversationId", "clientCommandId", "bodyText"]))) return null;
  const conversationId = safeIdentifier(payload.conversationId);
  const clientCommandId = safeIdentifier(payload.clientCommandId);
  if (!conversationId || !clientCommandId || typeof payload.bodyText !== "string" || bytes(payload.bodyText) > MAX_TEXT_BYTES) return null;
  return { conversationId, clientCommandId, bodyText: payload.bodyText };
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

function registerCommand(ipcMain, channel, getService, method, validate) {
  ipcMain.handle(channel, (_event, payload) => {
    const normalized = validate(payload);
    return normalized ? invoke(getService, method, normalized) : invalid();
  });
}

function createCollaborationIpc({ ipcMain, getService, subscribeState = () => () => {} } = {}) {
  if (!ipcMain || typeof ipcMain.handle !== "function") throw new TypeError("ipcMain.handle is required");
  const subscriptions = new Map();
  const emitState = async (sender, change = {}) => {
    if (!sender || sender.isDestroyed?.()) return;
    sender.send("collaboration:state", {
      type: safeIdentifier(change.type) || "state",
      state: await invoke(getService, "getState"),
    });
  };
  ipcMain.handle("collaboration:get-state", () => invoke(getService, "getState"));
  ipcMain.handle("collaboration:list", () => invoke(getService, "list"));
  ipcMain.handle("collaboration:bootstrap", () => invoke(getService, "bootstrap"));
  registerCommand(ipcMain, "collaboration:open", getService, "open", validOpen);
  registerCommand(ipcMain, "collaboration:send", getService, "send", validSend);
  registerCommand(ipcMain, "collaboration:retry", getService, "retry", validOutbox);
  registerCommand(ipcMain, "collaboration:cancel", getService, "cancel", validOutbox);
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
