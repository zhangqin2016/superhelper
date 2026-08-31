import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { CollaborationStore } = require("../src/main/collaboration/collaboration-store.js");
const { LocalCollaborationKeyring } = require("../src/main/collaboration/local-keyring.js");
const { createCollaborationSyncEngine } = require("../src/main/collaboration/sync-engine.js");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collaboration-direct-projection-"));
const keyring = new LocalCollaborationKeyring({ filePath: path.join(dir, "keys.json"), safeStorage: {
  isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString(),
} });
const options = { dbPath: path.join(dir, "cache.db"), accountId: "alice", keyring };
let store = new CollaborationStore(options);
const accepted = { cursor: 1, id: "accepted", type: "friend.accepted", conversationId: "direct-ab", actorUserId: "bob", payload: {
  participantUserIds: ["alice", "bob"], status: "active",
  profilesByUserId: { bob: { userId: "bob", lilyId: "bob-id", displayName: "Bob" } },
  directConversation: { id: "direct-ab", scopeType: "personal", kind: "direct", participantUserIds: ["alice", "bob"] },
} };
try {
  let engine = createCollaborationSyncEngine({ store });
  engine.applyPage({ fromCursor: 0, toCursor: 2, events: [accepted,
    { cursor: 2, id: "message", type: "message.created", conversationId: "direct-ab", actorUserId: "bob", seq: 1, payload: { messageId: "message-1" } },
  ] });
  assert.equal(store.getConversation({ conversationId: "direct-ab" })?.scopeId, "personal", "accepting peer's sync creates a direct before message hydration without bootstrap");
  assert.deepEqual(store.listConversationMembers({ conversationId: "direct-ab" }).map((member) => member.userId), ["alice", "bob"]);
  assert.equal(store.getProfile({ userId: "bob" }).displayName, "Bob");
  store.hydrateAuthorizedHistory({ conversationId: "direct-ab", messages: [{ id: "message-1", seq: 1, bodyText: "hello", revision: 1 }] });
  assert.deepEqual(store.listPendingHistoryHydration(), [], "new direct history checkpoint can complete");
  store.close(); store = new CollaborationStore(options); engine = createCollaborationSyncEngine({ store });
  assert.equal(store.listMessages({ conversationId: "direct-ab" })[0].bodyText, "hello");
  engine.applyPage({ fromCursor: 2, toCursor: 3, events: [{ ...accepted, cursor: 3 }] });
  assert.equal(store.listConversationIds().length, 1, "duplicate durable event does not recreate a conversation");
  const before = store.getSyncState().cursor;
  assert.throws(() => engine.applyPage({ fromCursor: before, toCursor: before + 1, events: [{ ...accepted,
    id: "invalid", cursor: before + 1, payload: { ...accepted.payload, directConversation: { ...accepted.payload.directConversation, id: "wrong" } },
  }] }), /direct projection/i, "mismatched event/conversation identity cannot project");
  assert.equal(store.getSyncState().cursor, before, "invalid projection rolls cursor back");
  store.db.run("INSERT INTO conversation_members (account_id,conversation_id,user_id,status,joined_seq) VALUES ('alice','direct-ab','charlie','active',0)");
  assert.throws(() => engine.applyPage({ fromCursor: before, toCursor: before + 1,
    events: [{ ...accepted, id: "conflicting-pair", cursor: before + 1 }] }), /direct projection/i, "an existing direct cannot acquire a third participant");
  assert.equal(store.getSyncState().cursor, before);
  assert.equal(store.listConversationMembers({ conversationId: "direct-ab" }).length, 3, "conflict is reported, never repaired by silently deleting existing members");
  store.db.run("DELETE FROM conversation_members WHERE account_id='alice' AND user_id='charlie'");
  const invalidProfile = { ...accepted, id: "invalid-profile", cursor: before + 1, conversationId: "new-direct", payload: { ...accepted.payload,
    directConversation: { ...accepted.payload.directConversation, id: "new-direct" },
    profilesByUserId: { alice: { userId: "alice", displayName: "Alice" }, bob: { userId: "charlie" } },
  } };
  assert.throws(() => engine.applyPage({ fromCursor: before, toCursor: before + 1, events: [invalidProfile] }), /direct projection/i);
  assert.equal(store.getConversation({ conversationId: "new-direct" }), null, "profile failure rolls back earlier conversation/member writes");
  assert.equal(store.getProfile({ userId: "alice" }), null);
  const foreign = { ...accepted, id: "foreign", cursor: before + 1, payload: { ...accepted.payload,
    participantUserIds: ["bob", "charlie"], directConversation: { ...accepted.payload.directConversation, participantUserIds: ["bob", "charlie"] },
  } };
  assert.throws(() => engine.applyPage({ fromCursor: before, toCursor: before + 1, events: [foreign] }), /direct projection/i, "event must bind current account");
  store.db.run("UPDATE conversations SET scope_id='team:org' WHERE account_id='alice' AND id='direct-ab'");
  assert.throws(() => engine.applyPage({ fromCursor: before, toCursor: before + 1, events: [{ ...accepted, id: "scope-conflict", cursor: before + 1 }] }), /direct projection/i);
  assert.equal(store.getConversation({ conversationId: "direct-ab" }).scopeId, "team:org", "scope cannot change through friendship sync");
  engine.applyPage({ fromCursor: before, toCursor: before + 1, events: [{ ...accepted, id: "legacy", cursor: before + 1, payload: {} }] });
  assert.equal(store.getSyncState().cursor, before + 1, "old additive-payload-free event is compatible");
  const bob = new CollaborationStore({ ...options, accountId: "other" });
  try { assert.deepEqual(bob.listConversationIds(), [], "projection is account-scoped"); } finally { bob.close(); }
  console.log("collaboration direct projection passed");
} finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
