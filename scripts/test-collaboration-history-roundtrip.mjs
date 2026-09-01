import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { CollaborationStore } = require("../src/main/collaboration/collaboration-store.js");
const { LocalCollaborationKeyring } = require("../src/main/collaboration/local-keyring.js");
const { createCollaborationClient } = require("../src/main/collaboration/client.js");
const { createCollaborationService } = require("../src/main/collaboration/service.js");
const { createCollaborationIpc } = require("../src/main/ipc-collaboration.js");
const dir = mkdtempSync(path.join(os.tmpdir(), "collab-history-roundtrip-"));
const keyring = new LocalCollaborationKeyring({ filePath: path.join(dir, "keys.json"), safeStorage: {
  isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString(),
} });
const store = new CollaborationStore({ dbPath: path.join(dir, "collaboration.db"), accountId: "alice", keyring });
let offline = false;
let history = [{ id: "m1", conversationId: "c1", createSeq: 1, senderUserId: "bob", kind: "attachment", attachmentIds: ["object-first", "object-second"], bodyText: "real history body", revision: 2, replyToMessageId: "parent", revokedAt: null }];
const client = createCollaborationClient({
  accountManager: { accessTokenForService: async () => ({ ok: true, accessToken: "test" }) },
  signDeviceRequest: async () => ({}),
  request: async ({ body }) => {
    if (offline) throw Object.assign(new Error("offline"), { code: "ECONNRESET" });
    assert.equal(body.action, "history");
    // Exact HTTP contract: the message route wraps listMessageHistory's ARRAY.
    return { ok: true, status: 200, json: { ok: true, result: history } };
  },
});
const service = createCollaborationService({ openStore: () => ({ ok: true, store }), client, deviceId: "device" });
try {
  store.replaceProjectionFromBootstrap({ conversations: [{ id: "c1", kind: "direct" }] });
  const opened = await service.open({ conversationId: "c1" });
  assert.equal(opened.messages.length, 1, "real route array reaches encrypted cache and desktop view");
  assert.equal(opened.messages[0].bodyText, "real history body");
  assert.equal(opened.messages[0].revision, 2, "revision survives caching for edit CAS");
  assert.equal(opened.messages[0].replyToMessageId, "parent");
  assert.deepEqual(opened.messages[0].attachmentIds, ["object-first", "object-second"], "authorized attachment order survives the real HTTP-to-cache chain");
  assert.deepEqual(store.getMessage({ conversationId: "c1", messageId: "m1" }).attachmentIds, ["object-first", "object-second"], "online response fields must really be durable, not only spread into the current view");
  const handlers = new Map();
  createCollaborationIpc({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, getService: () => service });
  offline = true;
  const attachmentView = await handlers.get("collaboration:open")(null, { conversationId: "c1" });
  assert.deepEqual(attachmentView.messages[0].attachmentIds, ["object-first", "object-second"], "offline IPC retains bounded object references");
  assert.equal(attachmentView.messages[0].kind, "attachment");
  const reopened = new CollaborationStore({ dbPath: path.join(dir, "collaboration.db"), accountId: "alice", keyring });
  try { assert.deepEqual(reopened.getMessage({ conversationId: "c1", messageId: "m1" }).attachmentIds, ["object-first", "object-second"]); }
  finally { reopened.close(); }
  offline = false;
  const originalHistory = history;
  for (const invalidIds of [["duplicate", "duplicate"], ["../unsafe"], Array.from({ length: 21 }, (_, i) => `object-${i}`), "not-an-array", null]) {
    history = [{ ...originalHistory[0], id: "m2", createSeq: 2 }, { ...originalHistory[0], id: "m3", createSeq: 3, attachmentIds: invalidIds }];
    await assert.rejects(service.open({ conversationId: "c1" }), { code: "COLLAB_HISTORY_INVALID" });
    assert.equal(store.getMessage({ conversationId: "c1", messageId: "m2" }), null, "an invalid object reference rolls back the whole history page");
  }
  history = originalHistory;
  history = [{ ...history[0], revision: 3, bodyText: "", revokedAt: "2026-08-31T00:00:00Z" }];
  const revoked = await service.open({ conversationId: "c1" });
  assert.equal(revoked.messages[0].revokedAt, history[0].revokedAt, "revoke remains a tombstone, not an empty ordinary message");
  assert.deepEqual(revoked.messages[0].attachmentIds, [], "a revoked message cannot retain actionable download references");
  // A stale in-flight response must not resurrect a revoked message.
  store.hydrateAuthorizedHistory({ conversationId: "c1", messages: [{ ...history[0], revision: 2, bodyText: "old secret", revokedAt: null }] });
  assert.equal(store.getMessage({ conversationId: "c1", messageId: "m1" }).revision, 3);
  assert.equal(store.getMessage({ conversationId: "c1", messageId: "m1" }).bodyText, "");
  store.hydrateAuthorizedHistory({ conversationId: "c1", messages: [{ ...history[0], revision: 3, bodyText: "equal revision secret", revokedAt: null }] });
  assert.equal(store.getMessage({ conversationId: "c1", messageId: "m1" }).bodyText, "", "a repeated equal revision cannot reverse a tombstone");
  assert.deepEqual(store.getMessage({ conversationId: "c1", messageId: "m1" }).attachmentIds, []);
  for (const extra of [{ revision: 2, revokedAt: null }, { revision: 3, revokedAt: history[0].revokedAt }]) {
    assert.throws(() => store.hydrateAuthorizedHistory({ conversationId: "c1", messages: [{ ...history[0], ...extra, attachmentIds: ["../unsafe"] }] }),
      { code: "COLLAB_HISTORY_INVALID" }, "malformed object references are rejected even on stale or revoked rows");
  }
  offline = true;
  const cached = await service.open({ conversationId: "c1" });
  assert.equal(cached.ok, true, "offline local-first conversation remains readable");
  assert.equal(cached.messages[0].revision, 3);
  const view = await handlers.get("collaboration:open")(null, { conversationId: "c1" });
  assert.equal(view.messages[0].revision, 3, "renderer IPC retains edit/revoke metadata without secrets");
  assert.equal(view.messages[0].revokedAt, history[0].revokedAt);
  store.persistDraftAndOptimisticMessage({ conversationId: "c1", messageId: "local", clientCommandId: "pending", draftId: "composer", draftText: "", bodyText: "pending" });
  store.setOutboxState({ outboxId: "pending", expectedStates: ["queued"], state: "confirming" });
  const pendingView = await handlers.get("collaboration:open")(null, { conversationId: "c1" });
  assert.equal(pendingView.messages.at(-1).clientCommandId, "pending");
  assert.equal(pendingView.messages.at(-1).isOwn, true, "message projection explicitly identifies the local sender so UI never guesses from a delayed directory");
  assert.equal(pendingView.messages.at(-1).seq, null, "optimistic sequence is unknown, never fabricated zero");
  assert.equal(pendingView.messages.at(-1).state, "confirming", "timeline sees durable delivery state, not perpetual optimistic");
  console.log("collaboration real history roundtrip passed");
} finally {
  service.stop();
  rmSync(dir, { recursive: true, force: true });
}
