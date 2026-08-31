import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { CollaborationStore } = require("../src/main/collaboration/collaboration-store");
const { LocalCollaborationKeyring } = require("../src/main/collaboration/local-keyring");
const { createCollaborationSyncEngine } = require("../src/main/collaboration/sync-engine");
const { createCollaborationService } = require("../src/main/collaboration/service");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-revoke-"));
let serial = 0;
function fixture() {
  const id = ++serial;
  const keyring = new LocalCollaborationKeyring({ filePath: path.join(dir, `key-${id}`), safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() } });
  const options = { dbPath: path.join(dir, `cache-${id}`), accountId: "alice", keyring };
  const store = new CollaborationStore(options);
  store.replaceProjectionFromBootstrap({ conversations: [{ id: "a", scopeId: "team:A" }, { id: "a2", scopeId: "team:A" }, { id: "b", scopeId: "team:B" }, { id: "p", scopeId: "personal" }] });
  for (const [conversationId, scopeId] of [["a", "team:A"], ["a2", "team:A"], ["b", "team:B"], ["p", "personal"]]) {
    store.persistDraftAndOptimisticMessage({ conversationId, scopeId, draftId: "composer", draftText: "draft", messageId: `m-${conversationId}`, clientCommandId: `cmd-${conversationId}`, bodyText: `secret-${conversationId}` });
    store.db.run("INSERT INTO history_hydration VALUES (?, ?, 1)", "alice", conversationId);
    store.db.run("INSERT INTO history_hydration_targets VALUES (?, ?, ?, 2)", "alice", conversationId, `old-${conversationId}`);
    store.db.run("INSERT INTO transfers (account_id,id,scope_id,state,created_at,updated_at) VALUES (?, ?, ?, 'uploading', 1, 1)", "alice", conversationId, scopeId);
    store.db.run("INSERT INTO share_mappings (account_id,id,scope_id,created_at) VALUES (?, ?, ?, 1)", "alice", conversationId, scopeId);
  }
  return { store, options, keyring, engine: createCollaborationSyncEngine({ store }) };
}
const revoke = { id: "revoke-A", cursor: 1, type: "scope.revoked", actorUserId: "admin", payload: { scopeType: "organization", organizationId: "A", userId: "alice" } };
const page = (events, fromCursor = 0) => ({ fromCursor, toCursor: fromCursor + events.length, events });
try {
  {
    const { store, engine, keyring } = fixture();
    const encrypted = store.db.get("SELECT body_envelope_json FROM messages WHERE conversation_id='a'").body_envelope_json;
    engine.applyPage(page([revoke, { id: "late", cursor: 2, type: "message.edited", conversationId: "a", seq: 9, payload: { messageId: "old-a", revision: 2 } }]));
    assert.equal(store.getConversation({ conversationId: "a" }), null, "Team revoke removes cached conversations");
    assert.equal(store.countMessages({ conversationId: "a" }), 0);
    assert.equal(store.getDraft({ conversationId: "a", draftId: "composer" }), null);
    assert.equal(store.getOutbox({ outboxId: "cmd-a" }), null);
    assert.deepEqual(store.listPendingHistoryHydration(), ["b", "p"], "same-page late events cannot recreate revoked hydration checkpoints");
    assert.equal(store.db.get("SELECT COUNT(*) AS n FROM transfers WHERE scope_id='team:A'").n, 0);
    assert.equal(store.db.get("SELECT COUNT(*) AS n FROM share_mappings WHERE scope_id='team:A'").n, 0);
    assert.throws(() => keyring.decrypt({ accountId: "alice", scopeId: "team:A", recordId: "message:a:m-a", envelope: JSON.parse(encrypted) }), /key.*unavailable/i);
    assert.equal(store.getMessage({ conversationId: "b", messageId: "m-b" }).bodyText, "secret-b");
    assert.equal(store.getMessage({ conversationId: "p", messageId: "m-p" }).bodyText, "secret-p");
    assert.throws(() => store.persistDraftAndOptimisticMessage({ conversationId: "a", scopeId: "team:A", draftId: "composer", messageId: "late", clientCommandId: "late", bodyText: "must not resurrect" }), /revoked/i);
    store.close();
  }
  {
    const { store, engine } = fixture();
    assert.throws(() => engine.applyPage(page([revoke, { id: "fail", cursor: 2, type: "test", payload: { failProjection: true } }])), /projection failed/);
    assert.equal(store.getSyncState().cursor, 0);
    assert.equal(store.getMessage({ conversationId: "a", messageId: "m-a" }).bodyText, "secret-a", "rolled-back revocation must not destroy keys");
    store.close();
  }
  {
    const { store, engine, keyring } = fixture();
    const oldEnvelope = store.db.get("SELECT body_envelope_json FROM messages WHERE conversation_id='a'").body_envelope_json;
    engine.applyPage(page([revoke]));
    store.replaceProjectionFromBootstrap({ watermark: 2, teams: [{ id: "A", status: "active" }, { id: "B", status: "active" }], conversations: [{ id: "a", scopeId: "team:A" }, { id: "b", scopeId: "team:B" }, { id: "p" }] });
    store.hydrateAuthorizedHistory({ conversationId: "a", messages: [{ id: "new-a", seq: 10, bodyText: "new grant" }] });
    assert.equal(store.getMessage({ conversationId: "a", messageId: "new-a" }).bodyText, "new grant", "fresh authorized bootstrap can regrant access with a new scope key");
    assert.throws(() => keyring.decrypt({ accountId: "alice", scopeId: "team:A", recordId: "message:a:m-a", envelope: JSON.parse(oldEnvelope) }), /authenticated/i, "new grant cannot recover destroyed old ciphertext");
    store.replaceProjectionFromBootstrap({ watermark: 3, teams: [{ id: "B", status: "active" }], conversations: [{ id: "b", scopeId: "team:B" }, { id: "p" }] });
    assert.equal(store.getConversation({ conversationId: "a" }), null);
    assert.equal(store.db.get("SELECT key_delete_pending FROM revoked_scopes WHERE scope_id='team:A'").key_delete_pending, 0, "authoritative bootstrap absence also destroys Team key");
    assert.equal(store.getOutbox({ outboxId: "cmd-b" }).bodyText, "secret-b");
    store.close();
  }
  {
    const { store, engine, keyring, options } = fixture();
    const destroy = keyring.destroyScopeKey.bind(keyring);
    keyring.destroyScopeKey = () => { throw new Error("keyring write failed"); };
    assert.throws(() => engine.applyPage(page([revoke])), /keyring write failed/);
    assert.equal(store.getSyncState().cursor, 1, "SQL commit and durable key deletion intent precede fallible filesystem work");
    assert.equal(store.getConversation({ conversationId: "a" }), null);
    store.close(); keyring.destroyScopeKey = destroy;
    const reopened = new CollaborationStore(options);
    assert.equal(reopened.db.get("SELECT COUNT(*) AS n FROM revoked_scopes WHERE key_delete_pending=1").n, 0, "restart finishes interrupted key destruction");
    assert.equal(reopened.getMessage({ conversationId: "p", messageId: "m-p" }).bodyText, "secret-p");
    reopened.close();
  }
  {
    const { store, engine } = fixture();
    engine.applyPage(page([{ id: "remove", cursor: 1, type: "member.removed", conversationId: "a", seq: 7, payload: { userId: "alice" } }]));
    assert.equal(store.getConversation({ conversationId: "a" }), null);
    assert.equal(store.getMessage({ conversationId: "a2", messageId: "m-a2" }).bodyText, "secret-a2", "private channel removal must preserve another channel's shared Team key");
    store.close();
  }
  {
    const { store } = fixture();
    let acknowledgements = 0;
    const client = {
      async listMessageHistory({ conversationId }) { if (conversationId.startsWith("a")) throw Object.assign(new Error("revoked"), { code: "COLLAB_ORGANIZATION_ACCESS_REVOKED" }); return { messages: [], unavailableMessageIds: [`old-${conversationId}`] }; },
      async syncAndAcknowledge({ afterCursor, onIncrementalPage }) { return onIncrementalPage({ page: page([], afterCursor), acknowledge: async () => { acknowledgements++; } }); },
    };
    const service = createCollaborationService({ openStore: () => ({ ok: true, store }), client, deviceId: "device" });
    await service.realtime.notifyAvailable();
    assert.equal(acknowledgements, 1, "denied old checkpoints cannot permanently prevent syncing the revocation event");
    assert.equal(store.getConversation({ conversationId: "a2" }), null);
    service.stop();
  }
  {
    const { store, keyring } = fixture();
    for (const conversationId of store.listPendingHistoryHydration()) store.completeHistoryHydration({ conversationId });
    keyring.destroyScopeKey = () => { throw new Error("keyring temporarily unavailable"); };
    const client = { listMessageHistory: async () => [], syncAndAcknowledge: ({ onIncrementalPage }) => onIncrementalPage({ page: page([revoke]), acknowledge: async () => { throw new Error("must not ACK key deletion failure"); } }) };
    const service = createCollaborationService({ openStore: () => ({ ok: true, store }), client, deviceId: "device" });
    const notifications = []; service.subscribe((event) => notifications.push(event.type));
    await service.realtime.notifyAvailable();
    assert.ok(notifications.includes("access-revoked"), "committed revocation notifies views even when key cleanup blocks ACK");
    assert.equal(store.getConversation({ conversationId: "a" }), null);
    service.stop();
  }
  {
    const { store } = fixture();
    store.replaceProjectionFromBootstrap({ watermark: 3, teams: [], conversations: [{ id: "a", scopeId: "team:A" }, { id: "p" }], members: [{ conversationId: "a", userId: "alice" }], history: [{ id: "late", conversationId: "a", bodyText: "stale" }] });
    assert.equal(store.getConversation({ conversationId: "a" }), null, "old server's stale cm rows cannot override authoritative Team revocation");
    assert.equal(store.countMessages({ conversationId: "a" }), 0);
    assert.deepEqual(store.listConversationMembers({ conversationId: "a" }), []);
    store.close();
  }
  {
    const { store, engine, keyring } = fixture();
    for (const table of ["transfers", "share_mappings"]) store.db.run(`DELETE FROM ${table} WHERE scope_id='team:A'`);
    const oldEnvelope = JSON.parse(store.db.get("SELECT body_envelope_json FROM messages WHERE conversation_id='a'").body_envelope_json);
    engine.applyPage(page(["a", "a2"].map((conversationId, i) => ({ id: `remove-${i}`, cursor: i + 1, type: "member.removed", conversationId, seq: 7, payload: { userId: "alice" } }))));
    store.replaceProjectionFromBootstrap({ watermark: 3, teams: [], conversations: [{ id: "p" }] });
    assert.throws(() => keyring.decrypt({ accountId: "alice", scopeId: "team:A", recordId: "message:a:m-a", envelope: oldEnvelope }), /key.*unavailable/i, "removing final channel must not hide its key from later Team revocation");
    store.close();
  }
  {
    const { store } = fixture();
    for (const conversationId of store.listPendingHistoryHydration()) store.completeHistoryHydration({ conversationId });
    store.db.run("INSERT INTO history_hydration VALUES ('alice','unknown-channel',1)");
    let acked = false;
    const client = { listMessageHistory: async () => { throw Object.assign(new Error("revoked"), { code: "COLLAB_ORGANIZATION_ACCESS_REVOKED" }); }, syncAndAcknowledge: ({ onIncrementalPage }) => onIncrementalPage({ page: page([]), acknowledge: async () => { acked = true; } }) };
    const service = createCollaborationService({ openStore: () => ({ ok: true, store }), client, deviceId: "device" });
    await service.realtime.notifyAvailable();
    assert.equal(acked, true, "a denied unknown channel cannot block the next sync page forever");
    assert.deepEqual(store.listPendingHistoryHydration(), []);
    assert.equal(store.getConversation({ conversationId: "b" }).scopeId, "team:B", "unknown channel denial never guesses another Team's scope");
    service.stop();
  }
  {
    const { store } = fixture();
    for (const snapshot of [{ watermark: 5 }, { watermark: 5, conversations: null }, { watermark: 5, conversations: [], teams: [null] }, { watermark: 5, conversations: [], teams: [{ id: "A" }] }, { watermark: 5, conversations: [{}] }]) {
      assert.throws(() => store.replaceProjectionFromBootstrap(snapshot), /bootstrap.*invalid/i);
      assert.equal(store.getSyncState().cursor, 0, "malformed snapshot cannot advance cursor");
      assert.equal(store.getDraft({ conversationId: "p", draftId: "composer" }).text, "draft");
      assert.equal(store.getOutbox({ outboxId: "cmd-p" }).bodyText, "secret-p", "missing snapshot fields must not erase durable intent");
      assert.equal(store.getMessage({ conversationId: "a", messageId: "m-a" }).bodyText, "secret-a");
    }
    store.close();
  }
  for (const entry of ["open", "bootstrap"]) {
    const { store, keyring } = fixture();
    keyring.destroyScopeKey = () => { throw new Error("keyring failure after commit"); };
    const client = { bootstrap: async () => ({ watermark: 5, conversations: [{ id: "p" }], teams: [] }), listMessageHistory: async () => { throw Object.assign(new Error("revoked"), { code: "COLLAB_ORGANIZATION_ACCESS_REVOKED" }); } };
    const service = createCollaborationService({ openStore: () => ({ ok: true, store }), client, deviceId: "device" });
    const notifications = []; service.subscribe((event) => notifications.push(event.type));
    await assert.rejects(entry === "open" ? service.open({ conversationId: "a" }) : service.bootstrap(), /keyring failure/);
    assert.equal(store.getConversation({ conversationId: "a" }), null);
    assert.ok(notifications.includes("access-revoked"), `${entry} must notify committed cache removal despite key failure`);
    service.stop();
  }
  console.log("collaboration scope revocation: cache isolation, transactional key cleanup, restart and checkpoint recovery passed");
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
