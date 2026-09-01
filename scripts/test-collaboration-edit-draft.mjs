import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { CollaborationStore } = require("../src/main/collaboration/collaboration-store");
const { LocalCollaborationKeyring } = require("../src/main/collaboration/local-keyring");
const { removeConversationRows } = require("../src/main/collaboration/access-revocation");
const { applyAuthorizedConversation } = require("../src/main/collaboration/conversation-hydration");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lily-edit-draft-"));
const dbPath = path.join(root, "cache.db");
const keyPath = path.join(root, "keys.json");
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value),
  decryptString: (value) => value.toString(),
};
const open = (accountId = "alice") => new CollaborationStore({
  dbPath,
  accountId,
  keyring: new LocalCollaborationKeyring({ filePath: keyPath, safeStorage }),
  now: () => 1700000000000,
});

let store = open();
store.db.run("INSERT INTO conversations(account_id,id,scope_id,kind,updated_at) VALUES(?,?,?,?,?)", "alice", "c", "personal", "direct", 1);
store.hydrateAuthorizedHistory({ conversationId: "c", messages: [{ id: "m", seq: 1, senderUserId: "alice", bodyText: "original", revision: 2 }] });
store.saveDraft({ conversationId: "c", text: "composer stays" });
const saved = store.saveEditDraft({ conversationId: "c", messageId: "m", bodyText: "private edit", baseRevision: 2, expectedGeneration: 0 });
assert.deepEqual(saved, { generation: 1, updatedAt: 1700000000000 });
assert.deepEqual(store.getEditDraft({ conversationId: "c", messageId: "m" }), {
  conversationId: "c", messageId: "m", bodyText: "private edit", baseRevision: 2, generation: 1, updatedAt: 1700000000000,
});
const raw = store.db.get("SELECT content_envelope_json FROM edit_drafts WHERE account_id = ?", "alice");
assert.ok(raw && !raw.content_envelope_json.includes("private edit"), "editing plaintext is encrypted at rest");
assert.equal(store.getDraft({ conversationId: "c", draftId: "composer" }).text, "composer stays", "edit drafts are independent of the composer");
store.hydrateAuthorizedHistory({ conversationId: "c", messages: [
  { id: "own-new", seq: 4, senderUserId: "alice", bodyText: "own new", revision: 2 },
  { id: "peer", seq: 2, senderUserId: "bob", bodyText: "peer secret", revision: 1 },
  { id: "revoked", seq: 3, senderUserId: "alice", bodyText: "", revision: 2, revokedAt: "2026-09-01T00:00:00Z" },
] });
for (const messageId of ["peer", "revoked"]) {
  for (const operation of [
    () => store.getEditDraft({ conversationId: "c", messageId }),
    () => store.saveEditDraft({ conversationId: "c", messageId, bodyText: "must not persist", baseRevision: 1, expectedGeneration: 0 }),
    () => store.clearEditDraft({ conversationId: "c", messageId, expectedGeneration: 0 }),
  ]) assert.throws(operation, (error) => error?.code === "COLLAB_MESSAGE_EDIT_FORBIDDEN" && !String(error?.message).includes("secret"));
}
assert.equal(store.db.get("SELECT COUNT(*) AS count FROM edit_drafts WHERE account_id='alice'").count, 1, "forbidden targets cannot create edit records");
assert.throws(() => store.saveEditDraft({ conversationId: "c", messageId: "own-new", bodyText: "wrong initial base", baseRevision: 1, expectedGeneration: 0 }),
  (error) => error?.code === "COLLAB_EDIT_DRAFT_BASE_MISMATCH");
const beforeBaseRewrite = store.db.get("SELECT generation, content_envelope_json, updated_at FROM edit_drafts WHERE account_id='alice' AND conversation_id='c' AND message_id='m'");
assert.throws(() => store.saveEditDraft({ conversationId: "c", messageId: "m", bodyText: "rewrite base", baseRevision: 3, expectedGeneration: 1 }),
  (error) => error?.code === "COLLAB_EDIT_DRAFT_BASE_MISMATCH");
assert.deepEqual(store.db.get("SELECT generation, content_envelope_json, updated_at FROM edit_drafts WHERE account_id='alice' AND conversation_id='c' AND message_id='m'"), beforeBaseRewrite,
  "a generation-correct save cannot rewrite the encrypted base revision or draft");
store.hydrateAuthorizedHistory({ conversationId: "c", messages: [{ id: "m", seq: 1, senderUserId: "alice", bodyText: "server edit", revision: 3 }] });
assert.equal(store.getEditDraft({ conversationId: "c", messageId: "m" }).baseRevision, 2, "a stale-base own draft remains readable for conflict comparison");
assert.deepEqual(store.saveEditDraft({ conversationId: "c", messageId: "m", bodyText: "continue stale draft", baseRevision: 2, expectedGeneration: 1 }),
  { generation: 2, updatedAt: 1700000000000 }, "the existing encrypted base remains writable after the authoritative revision advances");
assert.equal(store.clearEditDraft({ conversationId: "c", messageId: "m", expectedGeneration: 2 }), true);
assert.equal(store.saveEditDraft({ conversationId: "c", messageId: "m", bodyText: "resolved against current", baseRevision: 3, expectedGeneration: 0 }).generation, 1,
  "explicit conflict resolution clears then recreates against the current authoritative revision");
for (const bad of [
  { conversationId: "wrong", messageId: "m", bodyText: "x", baseRevision: 1, expectedGeneration: 0 },
  { conversationId: "c", messageId: "wrong", bodyText: "x", baseRevision: 1, expectedGeneration: 0 },
  { conversationId: "c", messageId: "m", bodyText: "x".repeat(65537), baseRevision: 2, expectedGeneration: 1 },
  { conversationId: "c", messageId: "m", bodyText: "x", baseRevision: 0, expectedGeneration: 1 },
]) assert.throws(() => store.saveEditDraft(bad));
store.close();

store = open();
assert.equal(store.getEditDraft({ conversationId: "c", messageId: "m" }).bodyText, "resolved against current", "edit draft survives restart");
assert.throws(() => store.saveEditDraft({ conversationId: "c", messageId: "m", bodyText: "stale", baseRevision: 3, expectedGeneration: 0 }), /EDIT_DRAFT_CONFLICT/);
assert.equal(store.clearEditDraft({ conversationId: "c", messageId: "m", expectedGeneration: 0 }), false, "stale clear cannot erase a newer draft");
assert.equal(store.getEditDraft({ conversationId: "c", messageId: "m" }).bodyText, "resolved against current");
assert.equal(store.clearEditDraft({ conversationId: "c", messageId: "m", expectedGeneration: 1 }), true);
assert.equal(store.getEditDraft({ conversationId: "c", messageId: "m" }), null);
assert.equal(store.getDraft({ conversationId: "c", draftId: "composer" }).text, "composer stays", "clearing an edit draft cannot clear composer state");
store.db.run("INSERT INTO conversation_members(account_id,conversation_id,user_id,status,role,joined_seq) VALUES(?,?,?,?,?,?)", "alice", "c", "alice", "active", "member", 0);
store.saveEditDraft({ conversationId: "c", messageId: "m", bodyText: "old membership", baseRevision: 3, expectedGeneration: 0 });
applyAuthorizedConversation(store, "c", {
  conversation: { id: "c", kind: "direct", scopeType: "personal", title: "c", projectionSeq: 5, lastReadSeq: 0, unreadCount: 0, mentionCount: 0 },
  members: [{ conversationId: "c", userId: "alice", status: "active", role: "member", joinedSeq: 4 }], profiles: [],
});
assert.equal(store.db.get("SELECT 1 AS present FROM edit_drafts WHERE account_id='alice' AND conversation_id='c'"), undefined, "a new membership epoch cannot inherit an old edit draft");
store.hydrateAuthorizedHistory({ conversationId: "c", messages: [{ id: "m", seq: 1, senderUserId: "alice", bodyText: "regranted", revision: 2 }] });
const revocationDraft = store.saveEditDraft({ conversationId: "c", messageId: "m", bodyText: "remove me", baseRevision: 2, expectedGeneration: 0 });
assert.equal(revocationDraft.generation, 1);
store.db.transaction(() => removeConversationRows(store, "c", "personal"))();
assert.equal(store.db.get("SELECT 1 AS present FROM edit_drafts WHERE account_id='alice' AND conversation_id='c'"), undefined, "revocation deletes editing plaintext envelopes transactionally");
assert.throws(() => store.getEditDraft({ conversationId: "c", messageId: "m" }), /target not found/);
store.close();

store = open("bob");
store.db.run("INSERT INTO conversations(account_id,id,scope_id,kind,updated_at) VALUES(?,?,?,?,?)", "bob", "c", "personal", "direct", 1);
store.hydrateAuthorizedHistory({ conversationId: "c", messages: [{ id: "m", seq: 1, senderUserId: "bob", bodyText: "bob original", revision: 1 }] });
assert.equal(store.getEditDraft({ conversationId: "c", messageId: "m" }), null, "another account cannot read Alice's draft row");
assert.equal(store.saveEditDraft({ conversationId: "c", messageId: "m", bodyText: "bob edit", baseRevision: 1, expectedGeneration: 0 }).generation, 1);
assert.equal(store.getEditDraft({ conversationId: "c", messageId: "m" }).bodyText, "bob edit");
store.close();

console.log("collaboration edit draft: encrypted restart and CAS");
