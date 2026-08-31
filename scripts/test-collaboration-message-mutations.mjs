#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { CollaborationStore } = require("../src/main/collaboration/collaboration-store.js");
const { LocalCollaborationKeyring } = require("../src/main/collaboration/local-keyring.js");
const { createCollaborationOutbox } = require("../src/main/collaboration/outbox.js");
const { hydratePendingConversation } = require("../src/main/collaboration/history-hydration.js");
const { createCollaborationService } = require("../src/main/collaboration/service.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-collab-mutations-"));
const safeStorage = { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value), decryptString: (value) => Buffer.from(value).toString() };
const open = () => new CollaborationStore({ dbPath: path.join(dir, "cache.db"), accountId: "alice", keyring: new LocalCollaborationKeyring({ filePath: path.join(dir, "keys.json"), safeStorage }) });

try {
  let store = open();
  store.db.run("INSERT INTO conversations(account_id,id,scope_id,kind,updated_at) VALUES('alice','c','personal','direct',1)");
  store.hydrateAuthorizedHistory({ conversationId: "c", messages: [{ id: "m", conversationId: "c", senderUserId: "alice", bodyText: "before", revision: 1, createSeq: 5 }] });
  assert.throws(() => store.persistMessageMutation({ commandType: "message.edit", conversationId: "c", messageId: "m", clientCommandId: "missing-origin", expectedRevision: 1, bodyText: "after" }), (error) => error?.code === "COLLAB_OUTBOX_DEVICE_REQUIRED", "new mutations without the immutable original device identity fail closed before admission");

  const admitted = store.persistMessageMutation({ commandType: "message.edit", conversationId: "c", messageId: "m", clientCommandId: "edit-1", expectedRevision: 1, bodyText: "after", originDeviceId: "device-a" });
  assert.equal(admitted.outboxId, "edit-1", "an edit is durable before any network request");
  assert.deepEqual(store.getOutbox({ outboxId: "edit-1" }), {
    id: "edit-1", conversationId: "c", clientCommandId: "edit-1", scopeId: "personal", state: "queued", attempts: 0,
    deliveryConfirmed: false, deliveryUncertain: false, commandType: "message.edit", messageId: "m", expectedRevision: 1, bodyText: "after", originDeviceId: "device-a",
  }, "mutation intent is immutable and does not create an optimistic message");
  assert.equal(store.getMessage({ conversationId: "c", messageId: "m" }).bodyText, "before", "editing never optimistically changes the historical body");
  assert.equal(store.countMessages({ conversationId: "c" }), 1, "editing adds no optimistic bubble");

  const first = createCollaborationOutbox({ store, deviceId: "device-a", transport: { async submit() { throw Object.assign(new Error("lost ACK"), { code: "COLLAB_RESPONSE_UNKNOWN" }); } } });
  await first.submit("edit-1");
  assert.equal(store.getOutbox({ outboxId: "edit-1" }).state, "confirming", "lost edit ACK retains the original command as a lane barrier");
  first.stop(); store.close(); store = open();
  store.recoverAbandonedSubmittingOutbox();
  const recovered = createCollaborationOutbox({ store, deviceId: "device-a", transport: {
    async submit() { throw new Error("must use original receipt before replay"); },
    async lookupReceipt() { return { committed: true, state: "completed", commandType: "message.edit", conversationId: "c", messageId: "m", revision: 2, eventId: "event-edit", eventSequence: 9 }; },
  } });
  await recovered.reconcilePending();
  assert.equal(store.getOutbox({ outboxId: "edit-1" }).state, "persisted", "typed original-device receipt settles after restart without a second submit");
  assert.equal(store.getMessage({ conversationId: "c", messageId: "m" }).seq, 5, "mutation event sequence never overwrites message create sequence");
  assert.deepEqual(store.listHistoryTargets({ conversationId: "c" }).map(({ messageId, revision }) => ({ messageId, revision })), [{ messageId: "m", revision: 2 }], "positive mutation receipt queues authorized revision hydration atomically");
  assert.deepEqual(store.listPendingHistoryHydration(), ["c"], "receipt evidence survives until authorized history refresh");
  let releaseHistory;
  const staleHistory = new Promise((resolve) => { releaseHistory = resolve; });
  const hydration = hydratePendingConversation({ store, deviceId: "device-a", conversationId: "c", assertActive() {}, client: {
    async listMessageHistory() { return staleHistory; },
  } });
  await new Promise((resolve) => setImmediate(resolve));
  store.persistMessageMutation({ commandType: "message.revoke", conversationId: "c", messageId: "m", clientCommandId: "revoke-2", expectedRevision: 2, originDeviceId: "device-a" });
  store.settleOutboxFromSync({ clientCommandId: "revoke-2", commandType: "message.revoke", conversationId: "c", messageId: "m", revision: 3, eventId: "event-revoke" });
  releaseHistory({ messages: [{ id: "m", conversationId: "c", senderUserId: "alice", bodyText: "after", revision: 2, createSeq: 5 }], unavailableMessageIds: [] });
  await hydration;
  assert.deepEqual(store.listHistoryTargets({ conversationId: "c" }).map(({ messageId, revision }) => ({ messageId, revision })), [{ messageId: "m", revision: 3 }], "a later receipt target survives an in-flight older history hydration");
  assert.deepEqual(store.listPendingHistoryHydration(), ["c"], "the hydration marker remains until every target generation is authorized");
  store.replaceProjectionFromBootstrap({ watermark: 10, conversations: [{ id: "c", kind: "direct" }] });
  assert.deepEqual(store.listHistoryTargets({ conversationId: "c" }).map(({ messageId, revision }) => ({ messageId, revision })), [{ messageId: "m", revision: 3 }], "bootstrap preserves only the already-durable pending mutation history target");
  assert.deepEqual(store.listPendingHistoryHydration(), ["c"], "bootstrap never clears a receipt-backed hydration marker before the target is authorized");
  assert.doesNotThrow(() => store.applySyncPage({ fromCursor: 10, toCursor: 11, events: [{ id: "same-id-other-type", cursor: 11, type: "message.created", actorUserId: "alice", clientCommandId: "edit-1", conversationId: "other-conversation", payload: { messageId: "other-message" } }] }), "a foreign create sharing a UUID with a local mutation cannot poison sync or settle the mutation");
  assert.equal(store.getOutbox({ outboxId: "edit-1" }).state, "persisted", "a create event never settles or rewrites a typed mutation command");

  const replayTimers = [];
  const malformed = store.persistMessageMutation({ commandType: "message.edit", conversationId: "c", messageId: "m", clientCommandId: "edit-malformed", expectedRevision: 3, bodyText: "later", originDeviceId: "device-a" });
  let malformedSubmits = 0;
  const malformedOutbox = createCollaborationOutbox({ store, deviceId: "device-a", setTimeoutFn(fn) { replayTimers.push(fn); return fn; }, clearTimeoutFn() {}, transport: {
    async submit() { malformedSubmits += 1; return malformedSubmits === 1 ? { ok: true } : { ok: false, state: "failed" }; },
    async lookupReceipt() { return { state: "unknown", committed: false, deliveryUnknown: true }; },
  } });
  await malformedOutbox.submit(malformed.outboxId);
  assert.deepEqual(store.getOutbox({ outboxId: "edit-malformed" }).state, "confirming", "a malformed HTTP 200 is not mutation commit evidence");
  assert.equal(store.getOutbox({ outboxId: "edit-malformed" }).deliveryConfirmed, false, "a malformed HTTP 200 never releases the same-conversation barrier");
  await replayTimers.shift()();
  assert.equal(malformedSubmits, 2, "only an explicit server-unknown response permits bounded replay of the same mutation id");
  assert.equal(store.getOutbox({ outboxId: "edit-malformed" }).deliveryConfirmed, false, "a malformed replay response is not silently marked delivered");
  replayTimers.length = 0;

  store.db.run("INSERT INTO conversations(account_id,id,scope_id,kind,updated_at) VALUES('alice','c2','personal','direct',2)");
  const valid = store.persistMessageMutation({ commandType: "message.edit", conversationId: "c2", messageId: "m2", clientCommandId: "edit-replay-valid", expectedRevision: 1, bodyText: "new", originDeviceId: "device-a" });
  let validSubmits = 0;
  const validOutbox = createCollaborationOutbox({ store, deviceId: "device-a", setTimeoutFn(fn) { replayTimers.push(fn); return fn; }, clearTimeoutFn() {}, transport: {
    async submit() {
      validSubmits += 1;
      if (validSubmits === 1) throw Object.assign(new Error("ACK lost"), { code: "COLLAB_RESPONSE_UNKNOWN" });
      return { committed: true, state: "completed", commandType: "message.edit", eventId: "event-replay", eventSequence: 12, sequence: 12, conversationId: "c2", messageId: "m2", revision: 2 };
    },
    async lookupReceipt() { return { state: "unknown", committed: false, deliveryUnknown: true }; },
  } });
  await validOutbox.submit(valid.outboxId);
  await replayTimers.shift()();
  assert.equal(validSubmits, 2, "valid unknown recovery reuses the original mutation id exactly once");
  assert.equal(store.getOutbox({ outboxId: "edit-replay-valid" }).state, "persisted", "a strict replay ACK settles the mutation atomically");
  assert.deepEqual(store.listHistoryTargets({ conversationId: "c2" }).map(({ messageId, revision }) => ({ messageId, revision })), [{ messageId: "m2", revision: 2 }], "a strict replay ACK queues the target history revision rather than treating event sequence as message creation sequence");
  validOutbox.stop();

  const foreignDeviceMutation = store.persistMessageMutation({ commandType: "message.edit", conversationId: "c2", messageId: "m2", clientCommandId: "edit-device-fence", expectedRevision: 2, bodyText: "never", originDeviceId: "device-a" });
  let foreignMutationSubmit = 0;
  const foreignMutationOutbox = createCollaborationOutbox({ store, deviceId: "device-b", transport: { async submit() { foreignMutationSubmit += 1; } } });
  assert.equal((await foreignMutationOutbox.submit(foreignDeviceMutation.outboxId)).code, "COLLAB_OUTBOX_DEVICE_CHANGED", "a replacement device cannot submit a durable mutation under another device's receipt identity");
  assert.equal(foreignMutationSubmit, 0, "device fencing happens before any mutation HTTP request");
  foreignMutationOutbox.stop();

  store.db.run("INSERT INTO conversations(account_id,id,scope_id,kind,updated_at) VALUES('alice','c4','personal','direct',4)");
  const manual = store.persistMessageMutation({ commandType: "message.edit", conversationId: "c4", messageId: "m4", clientCommandId: "edit-manual-continue", expectedRevision: 1, bodyText: "new", originDeviceId: "device-a" });
  let manualSubmits = 0, manualReceipts = 0;
  const manualOutbox = createCollaborationOutbox({ store, deviceId: "device-a", transport: {
    async submit() { manualSubmits += 1; if (manualSubmits === 1) throw Object.assign(new Error("lost"), { code: "COLLAB_RESPONSE_UNKNOWN" }); return { committed: true, state: "completed", commandType: "message.edit", eventId: "event-manual", eventSequence: 14, sequence: 14, conversationId: "c4", messageId: "m4", revision: 2 }; },
    async lookupReceipt() { manualReceipts += 1; if (manualReceipts === 1) throw Object.assign(new Error("receipt offline"), { code: "COLLAB_NETWORK_UNAVAILABLE" }); return { state: "unknown", committed: false, deliveryUnknown: true }; },
  } });
  await manualOutbox.submit(manual.outboxId);
  assert.equal((await manualOutbox.cancel(manual.outboxId)).state, "delivery_unknown", "a failed cancel receipt keeps the mutation ambiguous");
  assert.deepEqual(await manualOutbox.continue(manual.outboxId), { state: "persisted", clientCommandId: "edit-manual-continue" }, "manual continuation performs the original-device receipt check before exact-key replay");
  assert.deepEqual({ submits: manualSubmits, receipts: manualReceipts, state: store.getOutbox({ outboxId: manual.outboxId }).state }, { submits: 2, receipts: 2, state: "persisted" }, "manual mutation recovery cannot bypass the second receipt-first decision");
  manualOutbox.stop();

  store.db.run("INSERT INTO conversations(account_id,id,scope_id,kind,updated_at) VALUES('alice','c3','personal','direct',3)");
  const mismatchedReceipt = store.persistMessageMutation({ commandType: "message.edit", conversationId: "c3", messageId: "m3", clientCommandId: "edit-wrong-receipt", expectedRevision: 1, bodyText: "new", originDeviceId: "device-a" });
  const invalidReceiptTimers = [];
  const invalidReceiptOutbox = createCollaborationOutbox({ store, deviceId: "device-a", setTimeoutFn(fn) { invalidReceiptTimers.push(fn); return fn; }, clearTimeoutFn() {}, transport: {
    async submit() { throw Object.assign(new Error("lost"), { code: "COLLAB_RESPONSE_UNKNOWN" }); },
    async lookupReceipt() { return { committed: true, state: "completed", commandType: "message.edit", conversationId: "c3", messageId: "wrong-target", revision: 2, eventId: "wrong-event", eventSequence: 13 }; },
  } });
  await invalidReceiptOutbox.submit(mismatchedReceipt.outboxId);
  await invalidReceiptOutbox.reconcilePending();
  assert.equal(store.getOutbox({ outboxId: mismatchedReceipt.outboxId }).state, "confirming", "wrong target/type/revision receipt never settles a mutation or releases its lane");
  assert.deepEqual(store.listHistoryTargets({ conversationId: "c3" }), [], "an invalid receipt never queues a history projection target");
  invalidReceiptOutbox.stop();

  store.db.run("INSERT INTO conversations(account_id,id,scope_id,kind,updated_at) VALUES('alice','c5','personal','direct',5)");
  const stringRevision = store.persistMessageMutation({ commandType: "message.edit", conversationId: "c5", messageId: "m5", clientCommandId: "edit-string-revision", expectedRevision: 1, bodyText: "new", originDeviceId: "device-a" });
  const stringRevisionOutbox = createCollaborationOutbox({ store, deviceId: "device-a", transport: {
    async submit() { throw Object.assign(new Error("lost"), { code: "COLLAB_RESPONSE_UNKNOWN" }); },
    async lookupReceipt() { return { committed: true, state: "completed", commandType: "message.edit", conversationId: "c5", messageId: "m5", revision: "2", eventId: "string-revision", eventSequence: 15 }; },
  } });
  await stringRevisionOutbox.submit(stringRevision.outboxId);
  await stringRevisionOutbox.reconcilePending();
  assert.equal(store.getOutbox({ outboxId: stringRevision.outboxId }).state, "confirming", "receipt revision strings are never coerced into mutation commit evidence");
  stringRevisionOutbox.stop();

  const restartDir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-collab-mutation-restart-"));
  const restartOptions = { dbPath: path.join(restartDir, "cache.db"), accountId: "alice", keyring: new LocalCollaborationKeyring({ filePath: path.join(restartDir, "keys.json"), safeStorage }) };
  let restartStore = new CollaborationStore(restartOptions);
  restartStore.db.run("INSERT INTO conversations(account_id,id,scope_id,kind,updated_at) VALUES('alice','restart-c','personal','direct',1)");
  const restartIntent = restartStore.persistMessageMutation({ commandType: "message.edit", conversationId: "restart-c", messageId: "restart-m", clientCommandId: "restart-uncertain", expectedRevision: 1, bodyText: "after", originDeviceId: "device-a" });
  restartStore.setOutboxState({ outboxId: restartIntent.outboxId, expectedStates: ["queued"], state: "delivery_unknown" });
  restartStore.setOutboxState({ outboxId: restartIntent.outboxId, expectedStates: ["delivery_unknown"], state: "queued" });
  restartStore.close(); restartStore = new CollaborationStore(restartOptions);
  let restartedSubmits = 0, restartedReceipts = 0;
  const restartedOutbox = createCollaborationOutbox({ store: restartStore, deviceId: "device-a", transport: {
    async submit() { restartedSubmits += 1; return { committed: true, state: "completed", commandType: "message.edit", eventId: "restart-event", eventSequence: 16, sequence: 16, conversationId: "restart-c", messageId: "restart-m", revision: 2 }; },
    async lookupReceipt() { restartedReceipts += 1; return { state: "unknown", committed: false, deliveryUnknown: true }; },
  } });
  await restartedOutbox.reconcilePending(); await restartedOutbox.drainQueued();
  assert.deepEqual({ submits: restartedSubmits, receipts: restartedReceipts, state: restartStore.getOutbox({ outboxId: restartIntent.outboxId }).state }, { submits: 1, receipts: 1, state: "persisted" }, "a crash after uncertain mutation is queued still rechecks the original-device receipt before restart drain dispatch");
  restartedOutbox.stop(); restartStore.close(); fs.rmSync(restartDir, { recursive: true, force: true });

  const concurrentDir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-collab-mutation-concurrent-drain-"));
  const concurrentOptions = { dbPath: path.join(concurrentDir, "cache.db"), accountId: "alice", keyring: new LocalCollaborationKeyring({ filePath: path.join(concurrentDir, "keys.json"), safeStorage }) };
  const concurrentStore = new CollaborationStore(concurrentOptions);
  concurrentStore.db.run("INSERT INTO conversations(account_id,id,scope_id,kind,updated_at) VALUES('alice','concurrent-c','personal','direct',1)");
  const concurrentIntent = concurrentStore.persistMessageMutation({ commandType: "message.edit", conversationId: "concurrent-c", messageId: "concurrent-m", clientCommandId: "concurrent-uncertain", expectedRevision: 1, bodyText: "after", originDeviceId: "device-a" });
  concurrentStore.setOutboxState({ outboxId: concurrentIntent.outboxId, expectedStates: ["queued"], state: "delivery_unknown" });
  concurrentStore.setOutboxState({ outboxId: concurrentIntent.outboxId, expectedStates: ["delivery_unknown"], state: "queued" });
  let concurrentSubmits = 0, concurrentReceipts = 0;
  const concurrentOutbox = createCollaborationOutbox({ store: concurrentStore, deviceId: "device-a", maxAutoRetries: 1, setTimeoutFn() { return null; }, clearTimeoutFn() {}, transport: {
    async submit() { concurrentSubmits += 1; throw Object.assign(new Error("lost ACK"), { code: "COLLAB_RESPONSE_UNKNOWN" }); },
    async lookupReceipt() { concurrentReceipts += 1; return { state: "unknown", committed: false, deliveryUnknown: true }; },
  } });
  await Promise.all(Array.from({ length: 5 }, () => concurrentOutbox.drainQueued()));
  assert.deepEqual({ submits: concurrentSubmits, receipts: concurrentReceipts, attempts: concurrentStore.getOutbox({ outboxId: concurrentIntent.outboxId }).attempts, state: concurrentStore.getOutbox({ outboxId: concurrentIntent.outboxId }).state }, { submits: 1, receipts: 1, attempts: 0, state: "confirming" }, "parallel drains cannot replay a confirming uncertain mutation after the first lost-ACK submit");

  concurrentStore.db.run("INSERT INTO conversations(account_id,id,scope_id,kind,updated_at) VALUES('alice','skip-c','personal','direct',2)");
  const skippedIntent = concurrentStore.persistMessageMutation({ commandType: "message.edit", conversationId: "skip-c", messageId: "skip-m", clientCommandId: "skip-while-draining", expectedRevision: 1, bodyText: "after", originDeviceId: "device-a" });
  concurrentStore.setOutboxState({ outboxId: skippedIntent.outboxId, expectedStates: ["queued"], state: "delivery_unknown" });
  concurrentStore.setOutboxState({ outboxId: skippedIntent.outboxId, expectedStates: ["delivery_unknown"], state: "queued" });
  const drainingSkippedIntent = concurrentOutbox.drainQueued();
  assert.deepEqual(concurrentOutbox.skip(skippedIntent.outboxId), { state: "delivery_unknown" }, "a queued uncertain mutation may be skipped before its queued drain owns dispatch");
  await drainingSkippedIntent;
  assert.deepEqual({ submits: concurrentSubmits, receipts: concurrentReceipts, state: concurrentStore.getOutbox({ outboxId: skippedIntent.outboxId }).state }, { submits: 1, receipts: 1, state: "delivery_unknown" }, "a drain captured before skip cannot receipt-check, requeue, or submit the skipped mutation");

  concurrentStore.db.run("INSERT INTO conversations(account_id,id,scope_id,kind,updated_at) VALUES('alice','cancel-c','personal','direct',3)");
  const cancelledIntent = concurrentStore.persistMessageMutation({ commandType: "message.revoke", conversationId: "cancel-c", messageId: "cancel-m", clientCommandId: "cancel-before-drain", expectedRevision: 1, originDeviceId: "device-a" });
  assert.deepEqual(await concurrentOutbox.cancel(cancelledIntent.outboxId), { state: "cancelled" }, "a never-dispatched queued mutation may be cancelled before drain");
  await concurrentOutbox.drainQueued();
  assert.deepEqual({ submits: concurrentSubmits, receipts: concurrentReceipts, state: concurrentStore.getOutbox({ outboxId: cancelledIntent.outboxId }).state }, { submits: 1, receipts: 1, state: "cancelled" }, "a cancelled queued mutation is never reactivated or submitted by later drain");
  concurrentOutbox.stop(); concurrentStore.close(); fs.rmSync(concurrentDir, { recursive: true, force: true });
  malformedOutbox.stop();
  store.db.run("INSERT INTO conversations(account_id,id,scope_id,kind,updated_at) VALUES('alice','service-c','personal','direct',3)");
  store.hydrateAuthorizedHistory({ conversationId: "service-c", messages: [{ id: "service-m", conversationId: "service-c", bodyText: "before", revision: 1, createSeq: 20 }] });
  let observedServiceIntent;
  const service = createCollaborationService({ openStore: () => ({ ok: true, store }), deviceId: "device-a", realtimeEnabled: false, transport: {
    async submit(item) {
      observedServiceIntent = store.getOutbox({ outboxId: item.clientCommandId });
      throw Object.assign(new Error("lost service ACK"), { code: "COLLAB_RESPONSE_UNKNOWN" });
    },
  } });
  const serviceEdit = await service.edit({ conversationId: "service-c", messageId: "service-m", clientCommandId: "service-edit", expectedRevision: 1, bodyText: "after" });
  assert.deepEqual({ ok: serviceEdit.ok, state: serviceEdit.state, commandType: observedServiceIntent.commandType, messageId: observedServiceIntent.messageId, expectedRevision: observedServiceIntent.expectedRevision }, { ok: true, state: "confirming", commandType: "message.edit", messageId: "service-m", expectedRevision: 1 }, "service durably admits a typed mutation before dispatching the original idempotency key");
  assert.equal(store.getMessage({ conversationId: "service-c", messageId: "service-m" }).bodyText, "before", "service editing never changes a historical body optimistically");
  assert.deepEqual(await service.edit({ conversationId: "service-c", messageId: "service-m", clientCommandId: "service-edit", expectedRevision: 2, bodyText: "after" }), { ok: false, code: "IDEMPOTENCY_KEY_REUSED", retryable: false }, "same command id with a changed mutation intent fails closed");
  const serviceCancel = await service.cancel({ outboxId: "service-edit" });
  assert.equal(serviceCancel.state, "delivery_unknown", "cancel never claims an ambiguous mutation reverted the original message");
  assert.equal(store.getMessage({ conversationId: "service-c", messageId: "service-m" }).bodyText, "before", "cancelling an unconfirmed mutation does not delete or alter its target message");
  service.stop();
  recovered.stop();
  console.log("collaboration durable message mutations: ok");
} finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
