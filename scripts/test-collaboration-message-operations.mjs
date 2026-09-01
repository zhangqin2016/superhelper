#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { CollaborationStore } = require("../src/main/collaboration/collaboration-store");
const { LocalCollaborationKeyring } = require("../src/main/collaboration/local-keyring");
const { createCollaborationService } = require("../src/main/collaboration/service");
const { createCollaborationOutbox } = require("../src/main/collaboration/outbox");
const { openDatabase } = require("../src/main/store/sqlite-db");
const { COLLABORATION_MIGRATIONS } = require("../src/main/collaboration/schema");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-message-operations-"));
const safeStorage = { isEncryptionAvailable: () => true, encryptString: v => Buffer.from(v), decryptString: v => Buffer.from(v).toString() };
const keyring = new LocalCollaborationKeyring({ filePath: path.join(dir, "keys.json"), safeStorage });
const options = { dbPath: path.join(dir, "cache.db"), accountId: "alice", keyring };
let store, service;
const timers = { setTimeoutFn: () => null, clearTimeoutFn() {} };
try {
  // Build a real v14 database with encrypted durable data before opening v15.
  const legacy = openDatabase(options.dbPath); legacy.migrate(COLLABORATION_MIGRATIONS.slice(0, 14));
  const encrypted = JSON.stringify(keyring.encrypt({ accountId: "alice", scopeId: "personal", recordId: "outbox:legacy", plaintext: JSON.stringify({ messageId: "legacy-m", clientCommandId: "legacy", bodyText: "private legacy create" }) }));
  legacy.run("INSERT INTO conversations(account_id,id,scope_id,kind,updated_at) VALUES('alice','c','personal','direct',1)");
  legacy.run("INSERT INTO outbox(account_id,id,conversation_id,client_command_id,scope_id,state,payload_envelope_json,created_at,updated_at) VALUES('alice','legacy','c','legacy','personal','queued',?,1,1)", encrypted);
  legacy.close(); store = new CollaborationStore(options);
  assert.equal(store.db.pragma("user_version"), COLLABORATION_MIGRATIONS.length, "v14 data upgrades through every additive migration");
  const add = (id, cid = "c", type = "message.edit", origin = "device-a") => store.persistMessageMutation({ conversationId: cid, commandType: type, messageId: "m", clientCommandId: id, expectedRevision: 1, bodyText: "private persisted edit", originDeviceId: origin });
  store.db.run("INSERT INTO conversations(account_id,id,scope_id,kind,updated_at) VALUES('alice','foreign','personal','direct',2)");
  add("edit"); add("revoke", "c", "message.revoke"); add("foreign-edit", "foreign");
  const lightBefore = store.listOutbox();
  service = createCollaborationService({ openStore: () => ({ ok: true, store }), deviceId: "device-a", realtimeEnabled: false, transport: { async submit() { throw new Error("not dispatched"); } } });
  assert.equal(typeof service.readMessageOperations, "function");
  let result = await service.readMessageOperations({ conversationId: "c", outboxIds: ["edit", "legacy", "missing", "foreign-edit", "revoke"] });
  assert.deepEqual(result, { ok: true, conversationId: "c", operations: [
    { id: "edit", conversationId: "c", clientCommandId: "edit", scopeId: "personal", commandType: "message.edit", messageId: "m", expectedRevision: 1, state: "queued", attempts: 0, deliveryConfirmed: false, deliveryUncertain: false, blockedBy: "legacy", originalDeviceRequired: false, errorCode: null, bodyText: "private persisted edit" },
    { id: "legacy", conversationId: "c", clientCommandId: "legacy", scopeId: "personal", commandType: "message.create", messageId: "legacy-m", state: "queued", attempts: 0, deliveryConfirmed: false, deliveryUncertain: false, blockedBy: null, originalDeviceRequired: false, errorCode: null },
    { id: "revoke", conversationId: "c", clientCommandId: "revoke", scopeId: "personal", commandType: "message.revoke", messageId: "m", expectedRevision: 1, state: "queued", attempts: 0, deliveryConfirmed: false, deliveryUncertain: false, blockedBy: "legacy", originalDeviceRequired: false, errorCode: null },
  ], unavailableOutboxIds: ["missing", "foreign-edit"] }, "read view partitions exact requested IDs and exposes only edit recovery content");
  assert.deepEqual(store.listOutbox(), lightBefore, "new view does not change legacy list metadata or stored intent");
  assert.deepEqual(service.getState().outbox, lightBefore);
  const editEnvelope = store.db.get("SELECT payload_envelope_json FROM outbox WHERE id = 'edit'").payload_envelope_json;
  assert.equal(editEnvelope.includes("private persisted edit"), false, "recovery draft remains encrypted at rest");
  for (const corrupt of [null, { commandType: "unknown" }, { commandType: "" }, { expectedRevision: "1" }, { clientCommandId: "forged" }, { bodyText: 5 }]) {
    const original = store.getOutbox({ outboxId: "edit" });
    const value = corrupt === null ? "broken envelope" : store._encrypt({ scopeId: "personal", recordId: "outbox:edit", value: { ...original, ...corrupt } });
    store.db.run("UPDATE outbox SET payload_envelope_json = ? WHERE id = 'edit'", value);
    await assert.rejects(service.readMessageOperations({ conversationId: "c", outboxIds: ["legacy", "edit"] }), error => error.code === "COLLAB_MESSAGE_OPERATIONS_INVALID", "corrupt requested row fails the entire read, never partial success or guessed create");
    assert.doesNotThrow(() => service.getState(), "light state never decrypts historical outbox rows");
    store.db.run("UPDATE outbox SET payload_envelope_json = ? WHERE id = 'edit'", editEnvelope);
  }
  assert.deepEqual(await service.readMessageOperations({ conversationId: "c", outboxIds: [] }), { ok: true, conversationId: "c", operations: [], unavailableOutboxIds: [] });
  const ids200 = Array.from({ length: 200 }, (_, n) => `absent-${n}`);
  assert.equal((await service.readMessageOperations({ conversationId: "c", outboxIds: ids200 })).unavailableOutboxIds.length, 200);
  for (const request of [{ conversationId: "c", outboxIds: [...ids200, "201"] }, { conversationId: "c", outboxIds: ["edit", "edit"] }, { conversationId: "c", outboxIds: [" bad"] }, { conversationId: "c", outboxIds: [2] }, { conversationId: "c", outboxIds: Array(1) }, { conversationId: "c", outboxIds: "edit" }, { conversationId: " bad", outboxIds: [] }]) assert.equal((await service.readMessageOperations(request)).code, "COLLABORATION_INVALID_INPUT");
  assert.equal((await service.readMessageOperations({ conversationId: "absent", outboxIds: ["edit"] })).ok, false);
  // A foreign ciphertext must never even be decrypted for this conversation.
  store.db.run("UPDATE outbox SET payload_envelope_json = 'broken' WHERE id = 'foreign-edit'");
  assert.deepEqual((await service.readMessageOperations({ conversationId: "c", outboxIds: ["foreign-edit"] })).unavailableOutboxIds, ["foreign-edit"]);
  store.db.run("INSERT INTO revoked_conversations(account_id,conversation_id) VALUES('alice','c')");
  assert.equal((await service.readMessageOperations({ conversationId: "c", outboxIds: ["edit"] })).code, "COLLAB_ACCESS_REVOKED");
  store.db.run("DELETE FROM revoked_conversations WHERE account_id = 'alice'");
  const other = new CollaborationStore({ ...options, accountId: "bob" });
  other.db.run("INSERT INTO conversations(account_id,id,scope_id,kind,updated_at) VALUES('bob','c','personal','direct',1)");
  const otherService = createCollaborationService({ openStore: () => ({ ok: true, store: other }), realtimeEnabled: false });
  assert.deepEqual((await otherService.readMessageOperations({ conversationId: "c", outboxIds: ["edit"] })).unavailableOutboxIds, ["edit"]); otherService.stop();
  assert.equal(store.setOutboxState({ outboxId: "edit", expectedStates: ["queued"], state: "failed", errorCode: "MESSAGE_REVISION_CONFLICT" }), true);
  assert.equal(store.setOutboxState({ outboxId: "edit", expectedStates: ["submitting"], state: "failed", errorCode: "COLLAB_MESSAGE_EDIT_FORBIDDEN" }), false);
  assert.equal(store.getOutbox({ outboxId: "edit" }).errorCode, "MESSAGE_REVISION_CONFLICT", "late failed CAS cannot replace reason");
  assert.equal(store.recordOutboxRetry({ outboxId: "edit", maxAttempts: 3, errorCode: "COLLAB_RATE_LIMITED" }), null);
  service.stop(); store = new CollaborationStore(options);
  assert.equal(store.getOutbox({ outboxId: "edit" }).errorCode, "MESSAGE_REVISION_CONFLICT", "safe reason survives encrypted store reopen");
  assert.equal(store.getOutbox({ outboxId: "legacy" }).bodyText, "private legacy create");
  assert.equal(store.getOutbox({ outboxId: "legacy" }).errorCode, undefined, "NULL preserves old getOutbox equality");
  store.setOutboxState({ outboxId: "edit", expectedStates: ["failed"], state: "failed", errorCode: "/private/token=secret\nstack" });
  assert.equal(store.db.get("SELECT error_code FROM outbox WHERE id = 'edit'").error_code, "COLLAB_OPERATION_FAILED");
  store.db.run("UPDATE outbox SET error_code = '/private/legacy-error' WHERE id = 'edit'");
  assert.equal(store.getOutbox({ outboxId: "edit" }).errorCode, "COLLAB_OPERATION_FAILED");
  store.settleOutboxFromSync({ clientCommandId: "edit", commandType: "message.edit", conversationId: "c", messageId: "m", revision: 2, eventId: "edit-event" });
  assert.equal(store.getOutbox({ outboxId: "edit" }).errorCode, undefined, "direct mutation receipt clears obsolete reason");
  store.setOutboxState({ outboxId: "legacy", expectedStates: ["queued"], state: "failed", errorCode: "COLLAB_NETWORK_UNAVAILABLE" });
  store.settleOutboxFromSync({ clientCommandId: "legacy", eventId: "create-event", messageId: "server-m", sequence: 1 });
  assert.equal(store.getOutbox({ outboxId: "legacy" }).errorCode, undefined, "creation settlement clears obsolete reason");
  for (const code of ["MESSAGE_REVISION_CONFLICT", "COLLAB_MESSAGE_EDIT_WINDOW_EXPIRED", "COLLAB_MESSAGE_REVOKE_WINDOW_EXPIRED", "COLLAB_MESSAGE_EDIT_FORBIDDEN", "COLLAB_MESSAGE_REVOKE_FORBIDDEN", "COLLAB_AUTHORIZATION_DENIED", "COLLAB_NETWORK_UNAVAILABLE", "COLLAB_TRANSACTION_RETRY", "COLLAB_RATE_LIMITED", "COLLAB_RESPONSE_UNKNOWN", "arbitrary raw error"]) {
    const cid = `error-${code.replaceAll(" ", "-")}`;
    store.db.run("INSERT INTO conversations(account_id,id,scope_id,kind,updated_at) VALUES('alice',?,'personal','direct',1)", cid); add(cid, cid);
    const outbox = createCollaborationOutbox({ store, deviceId: "device-a", ...timers, transport: { async submit() { throw Object.assign(new Error("private stack"), { code }); } } });
    await outbox.submit(cid).catch(() => {});
    assert.equal(store.getOutbox({ outboxId: cid }).errorCode, code === "arbitrary raw error" ? "COLLAB_OPERATION_FAILED" : code, "production outbox persists only safe codes"); outbox.stop();
  }
  console.log("collaboration message operations: ok");
} finally { service?.stop(); try { store?.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); }
