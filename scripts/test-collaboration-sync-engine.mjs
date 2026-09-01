#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { CollaborationStore } = require("../src/main/collaboration/collaboration-store.js");
const { LocalCollaborationKeyring } = require("../src/main/collaboration/local-keyring.js");
const { createCollaborationSyncEngine } = require("../src/main/collaboration/sync-engine.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-collab-sync-"));
const dbPath = path.join(dir, "collaboration.db");
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`protected:${value}`),
  decryptString: (value) => Buffer.from(value).toString().replace(/^protected:/, ""),
};
const keyringPath = path.join(dir, "keys.json");
const clientCreatedAt = Date.parse("2026-08-31T00:00:00.000Z");
let localNow = clientCreatedAt;
const store = new CollaborationStore({ dbPath, accountId: "alice", now: () => localNow, keyring: new LocalCollaborationKeyring({ filePath: keyringPath, safeStorage }) });
const engine = createCollaborationSyncEngine({ store });

store.persistDraftAndOptimisticMessage({
  conversationId: "conv-confirm", draftId: "draft-confirm", draftText: "draft", messageId: "local-confirm-message",
  clientCommandId: "confirm-command", bodyText: "keep one local bubble", scopeId: "personal",
});
store.setOutboxState({ outboxId: "confirm-command", expectedStates: ["queued"], state: "confirming" });
localNow += 1000;
assert.deepEqual(engine.applyPage({
  status: "OK", fromCursor: 0, toCursor: 1,
  events: [{ cursor: 1, id: "event-confirm", conversationId: "conv-confirm", actorUserId: "alice", seq: 9, type: "message.created", payload: { clientCommandId: "confirm-command", messageId: "server-message-9" } }],
}), { cursor: 1, appliedEventIds: ["event-confirm"] });
assert.equal(store.getOutbox({ outboxId: "confirm-command" }).state, "persisted");
assert.equal(store.getMessage({ conversationId: "conv-confirm", messageId: "local-confirm-message" }), null, "sync confirmation replaces the optimistic identifier instead of rendering a second message");
assert.deepEqual(store.getMessage({ conversationId: "conv-confirm", messageId: "server-message-9" }), {
  id: "server-message-9", conversationId: "conv-confirm", state: "persisted", seq: 9, bodyText: "keep one local bubble", clientCommandId: "confirm-command",
  senderUserId: null, isOwn: true, replyToMessageId: null, mentionUserIds: [], replySnapshot: null, createdAt: null, clientCreatedAt, updatedAt: localNow,
}, "confirmation carries authoritative server id/seq while retaining the encrypted local body");
assert.equal(store.getMessage({ conversationId: "conv-confirm", messageId: "server-message-9" }).createdAt, null,
  "sync confirmation without authorized creation time cannot turn the client's admission clock into server edit-window authority");
assert.equal(store.countMessages({ conversationId: "conv-confirm" }), 1, "a command confirmation has one local message projection");

const page = {
  status: "OK", fromCursor: 1, toCursor: 2,
  events: [{ cursor: 2, id: "event-1", conversationId: "conv-1", type: "message.created", payload: { messageId: "server-message-1" } }],
};
assert.deepEqual(engine.applyPage(page), { cursor: 2, appliedEventIds: ["event-1"] });
assert.equal(store.getSyncState().cursor, 2);
assert.equal(store.countAppliedEvents(), 2);

// A crash after commit but before ACK restarts with the persisted cursor. The
// next exact page is an empty continuation, never a second local projection.
store.close();
const restartedStore = new CollaborationStore({ dbPath, accountId: "alice", keyring: new LocalCollaborationKeyring({ filePath: keyringPath, safeStorage }) });
const restarted = createCollaborationSyncEngine({ store: restartedStore });
assert.deepEqual(restarted.applyPage({ status: "OK", fromCursor: 2, toCursor: 2, events: [] }), { cursor: 2, appliedEventIds: [] });
assert.equal(restartedStore.countAppliedEvents(), 2, "restart cannot duplicate an event committed before its ACK");

assert.throws(
  () => restarted.applyPage({ status: "OK", fromCursor: 2, toCursor: 4, events: [
    { cursor: 3, id: "event-2", conversationId: "conv-1", type: "message.created", payload: {} },
    { cursor: 4, id: "event-3", conversationId: "conv-1", type: "message.created", payload: { failProjection: true } },
  ] }),
  /projection failed/i,
  "a page projection failure rolls back the whole SQLite transaction",
);
assert.equal(restartedStore.getSyncState().cursor, 2, "cursor moves only with a fully applied page");
assert.equal(restartedStore.countAppliedEvents(), 2, "a failed later event leaves no partially applied event record");

const secondAccount = new CollaborationStore({ dbPath, accountId: "bob", keyring: new LocalCollaborationKeyring({ filePath: keyringPath, safeStorage }) });
secondAccount.replaceProjectionFromBootstrap({ watermark: 4, conversations: [{ id: "bob-conv", scopeId: "personal", kind: "direct" }] });
restartedStore.persistDraftAndOptimisticMessage({ conversationId: "pending-conv", draftId: "pending-draft", draftText: "draft", messageId: "pending-local", clientCommandId: "pending-command", bodyText: "do not discard me" });
restartedStore.setOutboxState({ outboxId: "pending-command", expectedStates: ["queued"], state: "confirming" });
restartedStore.replaceProjectionFromBootstrap({
  watermark: 9,
  profile: { userId: "alice", lilyId: "alice-id", displayName: "Alice" },
  profiles: [{ userId: "peer", lilyId: "peer-id", displayName: "Peer" }],
  conversations: [{ id: "alice-conv", scopeId: "personal", kind: "direct", title: "Alice + Peer" }],
  members: [{ conversationId: "alice-conv", userId: "alice", role: "member", status: "active", joinedSeq: 0 }, { conversationId: "alice-conv", userId: "peer", role: "member", status: "active", joinedSeq: 2 }],
  history: [{ id: "history-1", conversationId: "alice-conv", createSeq: 4, senderUserId: "peer", bodyText: "bootstrap body", scopeId: "personal" }],
});
assert.equal(restartedStore.getSyncState().cursor, 9, "full resync atomically moves only the current account cursor to its bootstrap watermark");
assert.equal(restartedStore.listConversationIds().join(","), "alice-conv");
assert.equal(restartedStore.getProfile({ userId: "alice" }).displayName, "Alice", "bootstrap rebuilds current profile");
assert.deepEqual(restartedStore.listConversationMembers({ conversationId: "alice-conv" }).map((row) => row.userId), ["alice", "peer"], "bootstrap rebuilds membership projection");
assert.equal(restartedStore.getMessage({ conversationId: "alice-conv", messageId: "history-1" }).bodyText, "bootstrap body", "bootstrap rebuilds controlled encrypted history");
assert.equal(restartedStore.getOutbox({ outboxId: "pending-command" }).state, "confirming", "full resync preserves original confirming outbox intent");
assert.equal(restartedStore.getMessage({ conversationId: "pending-conv", messageId: "pending-local" }).bodyText, "do not discard me", "full resync rebuilds the confirming optimistic bubble from its durable outbox intent");
assert.equal(secondAccount.listConversationIds().join(","), "bob-conv", "full resync cannot clear another account's encrypted cache");

restartedStore.close();
secondAccount.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log("collaboration sync engine: ok");
