import assert from "node:assert/strict";

import { createCollaborationIpc } from "../src/main/ipc-collaboration.js";

const handlers = new Map();
const ipcMain = { handle(name, handler) { handlers.set(name, handler); } };
const calls = [];
const service = {
  ok: true,
  getState: () => ({ ok: true, cursor: 2, accessToken: "never-render", outbox: [{ id: "o1", state: "queued", authorization: "no", encryptedPath: "/no" }] }),
  list: () => ({ ok: true, conversations: [{ id: "c1", kind: "team", title: "Safe", scopeId: "team:t", localPath: "/private", sourcePath: "/source", deviceSignature: "no", nested: { token: "no" } }] }),
  open: ({ conversationId }) => ({ ok: true, conversation: { id: conversationId, title: "Safe", encryptedPath: "/no" }, messages: [{ id: "m1", conversationId, bodyText: "hi", filePath: "/no", authorization: "no" }], wrappedDek: "never-render" }),
  send: (payload) => { calls.push(payload); return { ok: true, clientCommandId: payload.clientCommandId, authorization: "never", internalReceipt: { token: "never" } }; },
  edit: (payload) => ({ ok: true, clientCommandId: payload.clientCommandId, state: "confirming", authorization: "never" }),
  revoke: (payload) => ({ ok: true, clientCommandId: payload.clientCommandId, state: "confirming", authorization: "never" }),
  friend: (payload) => ({ ok: true, clientCommandId: payload.clientCommandId, state: "confirming", authorization: "never" }),
  retry: ({ outboxId }) => ({ ok: true, outboxId }),
  cancel: ({ outboxId }) => ({ ok: true, outboxId, state: "delivery_unknown", recovery: "retry_or_sync" }),
  markRead: ({ conversationId, seq }) => ({ ok: true, conversationId, seq }),
  bootstrap: () => ({ ok: true, bootstrapCompletionToken: "never-render" }),
};

createCollaborationIpc({ ipcMain, getService: () => service });
assert.deepEqual([...handlers.keys()].sort(), [
  "collaboration:bootstrap", "collaboration:cancel", "collaboration:edit", "collaboration:friend", "collaboration:get-directory", "collaboration:get-draft", "collaboration:get-state", "collaboration:list",
  "collaboration:mark-read", "collaboration:open", "collaboration:read-messages", "collaboration:retry", "collaboration:revoke", "collaboration:save-draft", "collaboration:send", "collaboration:subscribe", "collaboration:unsubscribe",
  "collaboration:conversation", "collaboration:get-social-commands", "collaboration:retry-social", "collaboration:open-friend", "collaboration:get-conversation-details",
].sort());

const publicState = { ok: true, cursor: 2, watermark: 0, outbox: [{ id: "o1", conversationId: "", clientCommandId: "", scopeId: "", state: "queued", attempts: 0, createdAt: 0 }] };
assert.deepEqual(await handlers.get("collaboration:get-state")(), publicState);
assert.deepEqual(await handlers.get("collaboration:list")(), { ok: true, conversations: [{ id: "c1", scopeId: "team:t", kind: "team", title: "Safe", updatedAt: 0, lastSeq: null }] });
assert.deepEqual(await handlers.get("collaboration:open")(null, { conversationId: "c1" }), { ok: true, conversation: { id: "c1", scopeId: "", kind: "", title: "Safe", updatedAt: 0, lastSeq: null }, messages: [{ id: "m1", conversationId: "c1", seq: null, senderUserId: "", state: "", bodyText: "hi", createdAt: 0, updatedAt: 0 }], hasMore: false, nextBeforeSeq: null, offline: false });
assert.deepEqual(await handlers.get("collaboration:bootstrap")(), { ok: true, cursor: 0 });

const sent = await handlers.get("collaboration:send")(null, {
  conversationId: "c1", clientCommandId: "cmd-1", bodyText: "Hello",
});
assert.deepEqual(sent, { ok: true, clientCommandId: "cmd-1" });
assert.deepEqual(calls, [{ conversationId: "c1", clientCommandId: "cmd-1", bodyText: "Hello" }]);
assert.deepEqual(await handlers.get("collaboration:cancel")(null, { outboxId: "o1" }), { ok: true, outboxId: "o1", state: "delivery_unknown", recovery: "retry_or_sync" }, "the renderer receives only the explicit delivery-unknown recovery decision");

for (const payload of [
  { conversationId: "c1", clientCommandId: "cmd-2", bodyText: "Hello", accessToken: "secret" },
  { conversationId: "c1", clientCommandId: "cmd-2", bodyText: "Hello", localPath: "/private/a" },
  { conversationId: "c1", clientCommandId: "cmd-2", bodyText: "x".repeat(65 * 1024) },
  { conversationId: "", clientCommandId: "cmd-2", bodyText: "Hello" },
]) {
  assert.deepEqual(await handlers.get("collaboration:send")(null, payload), { ok: false, code: "COLLABORATION_INVALID_INPUT", retryable: false });
}

const unavailable = new Map();
createCollaborationIpc({ ipcMain: { handle(name, handler) { unavailable.set(name, handler); } }, getService: () => ({ ok: false }) });
assert.deepEqual(await unavailable.get("collaboration:list")(), { ok: false, code: "COLLABORATION_UNAVAILABLE", retryable: false });

const watched = new Map();
const sentEvents = [];
let publish = null;
createCollaborationIpc({
  ipcMain: { handle(name, handler) { watched.set(name, handler); } },
  getService: () => service,
  subscribeState: (listener) => { publish = listener; return () => { publish = null; }; },
});
const sender = { send(channel, payload) { sentEvents.push([channel, payload]); } };
assert.deepEqual(await watched.get("collaboration:subscribe")({ sender }), publicState);
publish?.({ type: "sync", accessToken: "never" });
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(sentEvents, [["collaboration:state", { type: "sync", state: publicState }]]);
assert.deepEqual(await watched.get("collaboration:unsubscribe")({ sender }), { ok: true });

console.log("collaboration IPC checks passed");
