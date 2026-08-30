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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-collab-outbox-"));
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`protected:${value}`),
  decryptString: (value) => Buffer.from(value).toString().replace(/^protected:/, ""),
};
const keyring = new LocalCollaborationKeyring({ filePath: path.join(dir, "keys.json"), safeStorage });
const store = new CollaborationStore({ dbPath: path.join(dir, "collaboration.db"), accountId: "alice", keyring });
store.persistDraftAndOptimisticMessage({
  conversationId: "conv-1", draftId: "draft-1", draftText: "draft", messageId: "local-message-1",
  clientCommandId: "command-1", bodyText: "body", scopeId: "personal",
});

let sends = 0;
const outbox = createCollaborationOutbox({
  store,
  transport: {
    async submit() {
      sends += 1;
      const error = new Error("connection lost after server commit");
      error.code = "COLLAB_RESPONSE_UNKNOWN";
      throw error;
    },
  },
});

const result = await outbox.submit("command-1");
assert.deepEqual(result, { state: "confirming", clientCommandId: "command-1" }, "a lost command response retains its original idempotency key in confirming state");
assert.equal(store.getOutbox({ outboxId: "command-1" }).state, "confirming");
await outbox.submit("command-1");
assert.equal(sends, 1, "confirming work is never blindly retransmitted after an ambiguous server commit");

store.settleOutboxFromSync({ clientCommandId: "command-1", eventId: "event-1", messageId: "local-message-1", sequence: 7 });
assert.equal(store.getOutbox({ outboxId: "command-1" }).state, "persisted", "durable sync settles the exact optimistic command in place");
assert.equal(store.getMessage({ conversationId: "conv-1", messageId: "local-message-1" }).state, "persisted");

for (const [id, conversationId] of [["command-2", "conv-lane"], ["command-3", "conv-lane"], ["command-4", "conv-other"]]) {
  store.persistDraftAndOptimisticMessage({
    conversationId, draftId: `draft-${id}`, draftText: "draft", messageId: `message-${id}`,
    clientCommandId: id, bodyText: id, scopeId: "personal",
  });
}
const order = [];
let releaseFirst;
const firstPending = new Promise((resolve) => { releaseFirst = resolve; });
const lanes = createCollaborationOutbox({
  store,
  transport: {
    async submit(item) {
      order.push(`start:${item.clientCommandId}`);
      if (item.clientCommandId === "command-2") await firstPending;
      order.push(`end:${item.clientCommandId}`);
    },
  },
});
const sameConversationFirst = lanes.submit("command-2");
const sameConversationSecond = lanes.submit("command-3");
const otherConversation = lanes.submit("command-4");
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(order, ["start:command-2", "start:command-4", "end:command-4"], "same conversation remains serial while a different conversation may submit concurrently");
releaseFirst();
await Promise.all([sameConversationFirst, sameConversationSecond, otherConversation]);
assert.deepEqual(order, ["start:command-2", "start:command-4", "end:command-4", "end:command-2", "start:command-3", "end:command-3"]);

store.persistDraftAndOptimisticMessage({ conversationId: "conv-retry", draftId: "draft-retry", draftText: "draft", messageId: "message-retry", clientCommandId: "command-retry", bodyText: "retry" });
const retrying = createCollaborationOutbox({ store, transport: { async submit() { const error = new Error("offline"); error.code = "COLLAB_NETWORK_UNAVAILABLE"; throw error; } } });
await assert.rejects(() => retrying.submit("command-retry"), /offline/);
assert.equal(store.getOutbox({ outboxId: "command-retry" }).state, "queued", "retryable failures preserve the original command for retry");
retrying.stop();

store.persistDraftAndOptimisticMessage({ conversationId: "conv-failed", draftId: "draft-failed", draftText: "draft", messageId: "message-failed", clientCommandId: "command-failed", bodyText: "failed" });
const permanent = createCollaborationOutbox({ store, transport: { async submit() { const error = new Error("denied"); error.code = "COLLAB_AUTHORIZATION_DENIED"; throw error; } } });
await assert.rejects(() => permanent.submit("command-failed"), /denied/);
assert.equal(store.getOutbox({ outboxId: "command-failed" }).state, "failed", "permanent failures stop automatic replay");

store.persistDraftAndOptimisticMessage({ conversationId: "conv-paused", draftId: "draft-paused", draftText: "draft", messageId: "message-paused", clientCommandId: "command-paused", bodyText: "paused" });
const bounded = createCollaborationOutbox({ maxAutoRetries: 1, store, transport: { async submit() { const error = new Error("offline again"); error.code = "COLLAB_NETWORK_UNAVAILABLE"; throw error; } } });
await assert.rejects(() => bounded.submit("command-paused"), /offline again/);
assert.equal(store.getOutbox({ outboxId: "command-paused" }).state, "paused", "retry cap pauses a failed command for an explicit user decision");
assert.equal(bounded.continue("command-paused").state, "queued", "continue resumes the same idempotency key");
assert.equal(bounded.skip("command-paused").state, "cancelled", "skip records a local non-send decision");

store.persistDraftAndOptimisticMessage({ conversationId: "conv-cancel", draftId: "draft-cancel", draftText: "draft", messageId: "message-cancel", clientCommandId: "command-cancel", bodyText: "cancel" });
store.setOutboxState({ outboxId: "command-cancel", expectedStates: ["queued"], state: "confirming" });
const committedCancel = createCollaborationOutbox({
  store,
  transport: { async submit() {}, async lookupReceipt() { return { committed: true, eventId: "event-cancel", messageId: "server-message-cancel", sequence: 11 }; } },
});
assert.deepEqual(await committedCancel.cancel("command-cancel"), { state: "persisted", canRevoke: true }, "confirming cancel checks the original receipt and never lies about an already-sent command");
assert.equal(store.getOutbox({ outboxId: "command-cancel" }).state, "persisted");
assert.equal(store.getMessage({ conversationId: "conv-cancel", messageId: "message-cancel" }), null, "receipt settlement removes the optimistic message alias");
assert.equal(store.getMessage({ conversationId: "conv-cancel", messageId: "server-message-cancel" }).seq, 11, "receipt settlement retains one authoritative sent message eligible for revoke");

store.persistDraftAndOptimisticMessage({ conversationId: "conv-cancel-2", draftId: "draft-cancel-2", draftText: "draft", messageId: "message-cancel-2", clientCommandId: "command-cancel-2", bodyText: "cancel" });
store.setOutboxState({ outboxId: "command-cancel-2", expectedStates: ["queued"], state: "confirming" });
const absentCancel = createCollaborationOutbox({
  store,
  transport: { async submit() {}, async lookupReceipt() { return { committed: false }; } },
});
assert.deepEqual(await absentCancel.cancel("command-cancel-2"), { state: "delivery_unknown", recovery: "retry_or_sync", requiresSync: true }, "an absent receipt is not proof that an ambiguous server command never committed");
assert.equal(store.getOutbox({ outboxId: "command-cancel-2" }).state, "delivery_unknown");

store.persistDraftAndOptimisticMessage({ conversationId: "conv-cancel-receipt-error", draftId: "draft-cancel-receipt-error", draftText: "draft", messageId: "message-cancel-receipt-error", clientCommandId: "command-cancel-receipt-error", bodyText: "cancel" });
store.setOutboxState({ outboxId: "command-cancel-receipt-error", expectedStates: ["queued"], state: "confirming" });
const receiptErrorCancel = createCollaborationOutbox({ store, transport: { async submit() {}, async lookupReceipt() { throw new Error("receipt transport offline"); } } });
assert.deepEqual(await receiptErrorCancel.cancel("command-cancel-receipt-error"), { state: "delivery_unknown", recovery: "retry_or_sync", requiresSync: true }, "a receipt transport failure never strands cancellation_requested");
assert.equal(store.getOutbox({ outboxId: "command-cancel-receipt-error" }).state, "delivery_unknown");

store.persistDraftAndOptimisticMessage({ conversationId: "conv-cancel-no-receipt", draftId: "draft-cancel-no-receipt", draftText: "draft", messageId: "message-cancel-no-receipt", clientCommandId: "command-cancel-no-receipt", bodyText: "cancel" });
store.setOutboxState({ outboxId: "command-cancel-no-receipt", expectedStates: ["queued"], state: "confirming" });
const noReceiptCancel = createCollaborationOutbox({ store, transport: { async submit() {} } });
assert.deepEqual(await noReceiptCancel.cancel("command-cancel-no-receipt"), { state: "delivery_unknown", recovery: "retry_or_sync", requiresSync: true }, "without a receipt endpoint cancellation is explicitly recoverable rather than falsely cancelled");
assert.equal(store.getOutbox({ outboxId: "command-cancel-no-receipt" }).state, "delivery_unknown");
assert.equal(noReceiptCancel.continue("command-cancel-no-receipt").state, "queued", "delivery-unknown recovery retries the original idempotency key");
assert.equal(noReceiptCancel.skip("command-cancel-no-receipt").state, "cancelled", "a user may explicitly discard a delivery-unknown draft without claiming server cancellation");

store.persistDraftAndOptimisticMessage({ conversationId: "conv-cancel-race", draftId: "draft-cancel-race", draftText: "draft", messageId: "message-cancel-race", clientCommandId: "command-cancel-race", bodyText: "race" });
let releaseSubmitting;
const pendingSubmit = new Promise((resolve) => { releaseSubmitting = resolve; });
const raceOrder = [];
const serializedCancel = createCollaborationOutbox({
  store,
  transport: {
    async submit() { raceOrder.push("submit:start"); await pendingSubmit; raceOrder.push("submit:end"); },
    async lookupReceipt() { raceOrder.push("receipt"); return { committed: false }; },
  },
});
const submitting = serializedCancel.submit("command-cancel-race");
const cancelling = serializedCancel.cancel("command-cancel-race");
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(raceOrder, ["submit:start"], "cancel is serialized behind an in-flight same-conversation submit");
releaseSubmitting();
await Promise.all([submitting, cancelling]);
assert.deepEqual(raceOrder, ["submit:start", "submit:end", "receipt"], "cancellation checks the original receipt after the submit reaches a durable confirmation state");
assert.equal(store.getOutbox({ outboxId: "command-cancel-race" }).state, "delivery_unknown", "an absent receipt after a race remains explicitly delivery-unknown");

store.persistDraftAndOptimisticMessage({ conversationId: "conv-auto", draftId: "draft-auto", draftText: "draft", messageId: "message-auto", clientCommandId: "command-auto", bodyText: "automatic retry" });
const retryTimers = [];
let automaticAttempts = 0;
const automatic = createCollaborationOutbox({
  store, maxAutoRetries: 2, retryBaseMs: 50, retryMaxMs: 100,
  setTimeoutFn: (fn, delay) => { retryTimers.push({ fn, delay }); return retryTimers.length; }, clearTimeoutFn() {},
  transport: { async submit(item) { automaticAttempts += 1; assert.equal(item.clientCommandId, "command-auto", "automatic retry must preserve the durable idempotency key"); const error = new Error("offline automatic"); error.code = "COLLAB_NETWORK_UNAVAILABLE"; throw error; } },
});
await assert.rejects(() => automatic.submit("command-auto"), /offline automatic/);
assert.deepEqual(retryTimers.map((timer) => timer.delay), [50], "first retry is delayed rather than a tight loop");
await retryTimers[0].fn();
assert.equal(automaticAttempts, 2);
assert.equal(store.getOutbox({ outboxId: "command-auto" }).state, "paused", "automatic retry reaches a durable paused state at the configured cap");
assert.equal(retryTimers.length, 1, "paused commands schedule no further automatic work");

store.persistDraftAndOptimisticMessage({ conversationId: "conv-drain", draftId: "draft-drain", draftText: "draft", messageId: "message-drain", clientCommandId: "command-drain", bodyText: "drain after restart" });
const drained = [];
const restartedOutbox = createCollaborationOutbox({ store, transport: { async submit(item) { drained.push(item.clientCommandId); } } });
await restartedOutbox.drainQueued();
assert.deepEqual(drained, ["command-retry", "command-drain"], "startup/reconnect drain submits every durable queued item with its original command id");
assert.equal(store.getOutbox({ outboxId: "command-drain" }).state, "confirming");

store.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log("collaboration outbox: ok");
