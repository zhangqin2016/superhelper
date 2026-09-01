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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-operation-recovery-"));
const safeStorage = { isEncryptionAvailable: () => true, encryptString: v => Buffer.from(v), decryptString: v => Buffer.from(v).toString() };
const keyring = new LocalCollaborationKeyring({ filePath: path.join(dir, "keys.json"), safeStorage });
const store = new CollaborationStore({ dbPath: path.join(dir, "cache.db"), accountId: "alice", keyring });
const services = [], outboxes = [];
const timers = { setTimeoutFn: () => null, clearTimeoutFn() {} };
const add = (id, cid) => store.persistMessageMutation({ commandType: "message.edit", conversationId: cid, messageId: "m", clientCommandId: id, expectedRevision: 1, bodyText: "unchanged durable edit", originDeviceId: "device-a" });
const conversation = cid => store.db.run("INSERT INTO conversations(account_id,id,scope_id,kind,updated_at) VALUES('alice',?,'personal','direct',1)", cid);
const makeService = transport => { const s = createCollaborationService({ openStore: () => ({ ok: true, store }), deviceId: "device-a", realtimeEnabled: false, transport }); services.push(s); return s; };
const makeOutbox = options => { const o = createCollaborationOutbox({ store, deviceId: "device-a", ...timers, ...options }); outboxes.push(o); return o; };
try {
  conversation("foreign-device"); add("foreign-device", "foreign-device");
  const foreign = makeOutbox({ deviceId: "device-b", transport: { async submit() { assert.fail("foreign device must never submit"); } } });
  assert.equal(foreign.skip("foreign-device").code, "COLLAB_OUTBOX_DEVICE_CHANGED", "skip needs the same original-device guard as cancel/retry");
  store.setOutboxState({ outboxId: "foreign-device", expectedStates: ["queued"], state: "paused" });
  assert.equal((await foreign.continue("foreign-device")).code, "COLLAB_OUTBOX_DEVICE_CHANGED", "retry must guard before modifying the durable row");
  assert.equal(store.getOutbox({ outboxId: "foreign-device" }).state, "paused");
  assert.equal(store.readMessageOperations({ conversationId: "foreign-device", outboxIds: ["foreign-device"], deviceId: "device-b" }).operations[0].originalDeviceRequired, true);
  for (const action of ["skip", "cancel"]) {
    conversation(action); add(`${action}-first`, action); add(`${action}-next`, action);
    store.setOutboxState({ outboxId: `${action}-first`, expectedStates: ["queued"], state: "failed", errorCode: "MESSAGE_REVISION_CONFLICT" });
    const submitted = [], changes = [];
    const service = makeService({ async submit(item) { submitted.push(item.clientCommandId); return { committed: true, state: "completed", commandType: "message.edit", conversationId: action, messageId: "m", revision: 2, eventId: `${action}-event`, eventSequence: 3 }; } });
    service.subscribe(change => changes.push(change));
    assert.equal((await service[action]({ outboxId: `${action}-first` })).state, "cancelled");
    assert.deepEqual(submitted, [`${action}-next`], "confirmed local cancellation drains already queued successor without new command IDs");
    assert.ok(changes.length > 0, "cancellation emits fresh operation state");
    assert.equal(store.getOutbox({ outboxId: `${action}-next` }).state, "persisted");
  }
  conversation("uncertain"); add("uncertain-first", "uncertain"); add("uncertain-next", "uncertain");
  store.setOutboxState({ outboxId: "uncertain-first", expectedStates: ["queued"], state: "delivery_unknown", errorCode: "MESSAGE_REVISION_CONFLICT" });
  store.setOutboxState({ outboxId: "uncertain-first", expectedStates: ["delivery_unknown"], state: "queued" });
  const uncertain = makeService({ async submit() { assert.fail("uncertainty remains a conversation barrier"); } });
  assert.equal((await uncertain.skip({ outboxId: "uncertain-first" })).state, "delivery_unknown");
  await uncertain.outbox.drainQueued();
  assert.equal(store.getOutbox({ outboxId: "uncertain-next" }).state, "queued");
  assert.equal((await uncertain.cancel({ outboxId: "uncertain-first" })).state, "delivery_unknown");
  store.confirmOutboxDelivery({ outboxId: "uncertain-first" });
  assert.equal((await uncertain.skip({ outboxId: "uncertain-first" })).canRevoke, true, "confirmed delivery cannot be locally cancelled");
  assert.equal(store.getOutbox({ outboxId: "uncertain-first" }).errorCode, undefined);
  store.settleOutboxFromSync({ clientCommandId: "uncertain-first", commandType: "message.edit", conversationId: "uncertain", messageId: "m", revision: 2, eventId: "uncertain-event" });
  // A receipt read may fail after an ACK has become durable without changing
  // confirming state. Neither same-state CAS nor retry may restore its error.
  conversation("late-error"); add("late-error", "late-error");
  store.setOutboxState({ outboxId: "late-error", expectedStates: ["queued"], state: "confirming", errorCode: "COLLAB_RESPONSE_UNKNOWN" });
  let rejectReceipt;
  const late = makeOutbox({ transport: { async submit() {}, lookupReceipt() { return new Promise((_, reject) => { rejectReceipt = reject; }); } } });
  const pending = late.reconcilePending();
  await new Promise(resolve => setImmediate(resolve));
  store.confirmOutboxDelivery({ outboxId: "late-error" });
  rejectReceipt(Object.assign(new Error("private failure"), { code: "COLLAB_NETWORK_UNAVAILABLE" }));
  await pending;
  assert.equal(store.getOutbox({ outboxId: "late-error" }).errorCode, undefined, "late error cannot overwrite actual positive delivery evidence");
  store.recordOutboxRetry({ outboxId: "late-error", maxAttempts: 3, uncertainDelivery: true, errorCode: "COLLAB_RATE_LIMITED" });
  assert.equal(store.getOutbox({ outboxId: "late-error" }).errorCode, undefined);
  assert.equal(store.getOutbox({ outboxId: "late-error" }).deliveryUncertain, false);
  // Stopping after an await must not emit successful cancellation or touch a
  // closed cache. Use an isolated store because stop owns store closure.
  const stoppedStore = new CollaborationStore({ dbPath: path.join(dir, "stop.db"), accountId: "alice", keyring });
  stoppedStore.db.run("INSERT INTO conversations(account_id,id,scope_id,kind,updated_at) VALUES('alice','c','personal','direct',1)");
  stoppedStore.persistMessageMutation({ commandType: "message.edit", conversationId: "c", messageId: "m", clientCommandId: "stop-edit", expectedRevision: 1, bodyText: "kept", originDeviceId: "device-a" });
  stoppedStore.setOutboxState({ outboxId: "stop-edit", expectedStates: ["queued"], state: "confirming" });
  let release;
  const stopped = createCollaborationService({ openStore: () => ({ ok: true, store: stoppedStore }), deviceId: "device-a", realtimeEnabled: false, transport: { async submit() {}, lookupReceipt() { return new Promise(resolve => { release = resolve; }); } } });
  const cancelling = stopped.cancel({ outboxId: "stop-edit" }); await new Promise(resolve => setImmediate(resolve)); stopped.stop(); release({ state: "unknown", committed: false, deliveryUnknown: true });
  assert.deepEqual(await cancelling, { ok: false, code: "COLLABORATION_STOPPED" });
  assert.deepEqual(await stopped.skip({ outboxId: "stop-edit" }), { ok: false, code: "COLLABORATION_STOPPED" });
  assert.deepEqual(await stopped.readMessageOperations({ conversationId: "c", outboxIds: ["stop-edit"] }), { ok: false, code: "COLLABORATION_STOPPED" });
  const drainStore = new CollaborationStore({ dbPath: path.join(dir, "stop-drain.db"), accountId: "alice", keyring });
  drainStore.db.run("INSERT INTO conversations(account_id,id,scope_id,kind,updated_at) VALUES('alice','c','personal','direct',1)");
  for (const id of ["first", "next"]) drainStore.persistMessageMutation({ commandType: "message.edit", conversationId: "c", messageId: "m", clientCommandId: id, expectedRevision: 1, bodyText: "kept", originDeviceId: "device-a" });
  const draining = createCollaborationService({ openStore: () => ({ ok: true, store: drainStore }), deviceId: "device-a", realtimeEnabled: false, transport: { submit() { return new Promise(resolve => { release = resolve; }); } } });
  const skipping = draining.skip({ outboxId: "first" }); await new Promise(resolve => setImmediate(resolve)); draining.stop(); release(null);
  assert.deepEqual(await skipping, { ok: false, code: "COLLABORATION_STOPPED" }, "skip rechecks shutdown after its queued successor dispatch awaits transport");
  console.log("collaboration message operation recovery: ok");
} finally { for (const outbox of outboxes) outbox.stop(); for (const service of services) service.stop(); try { store.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); }
