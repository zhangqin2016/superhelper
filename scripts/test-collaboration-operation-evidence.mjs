import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { CollaborationStore } = require("../src/main/collaboration/collaboration-store");
const { LocalCollaborationKeyring } = require("../src/main/collaboration/local-keyring");
const { createCollaborationOutbox } = require("../src/main/collaboration/outbox");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collaboration-operation-evidence-"));
const safeStorage = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => Buffer.from(value).toString() };
const options = { dbPath: path.join(dir, "cache.db"), accountId: "alice", keyring: new LocalCollaborationKeyring({ filePath: path.join(dir, "keys.json"), safeStorage }) };
let store, outbox;
try {
  store = new CollaborationStore(options);
  store.db.run("INSERT INTO conversations(account_id,id,scope_id,kind,updated_at) VALUES('alice','c','personal','direct',1)");
  store.persistDraftAndOptimisticMessage({ conversationId: "c", draftId: "composer", draftText: "", messageId: "optimistic:command", clientCommandId: "command", bodyText: "original", originDeviceId: "device-a" });
  store.setOutboxState({ outboxId: "command", expectedStates: ["queued"], state: "confirming", errorCode: "COLLAB_RESPONSE_UNKNOWN" });
  let rejectReceipt, receiptStarted, submits = 0;
  const started = new Promise(resolve => { receiptStarted = resolve; });
  outbox = createCollaborationOutbox({ store, deviceId: "device-a", setTimeoutFn: () => null, clearTimeoutFn() {}, transport: {
    async submit() { submits += 1; throw new Error("positive evidence must prevent resend"); },
    lookupReceipt() { receiptStarted(); return new Promise((_, reject) => { rejectReceipt = reject; }); },
  } });
  const recovery = outbox.reconcilePending();
  await started;
  // A positive ACK can be persisted before projection changes the state. A
  // state-only CAS therefore cannot identify this stale receipt error.
  store.confirmOutboxDelivery({ outboxId: "command" });
  rejectReceipt(Object.assign(new Error("receipt request failed later"), { code: "COLLAB_NETWORK_UNAVAILABLE" }));
  await recovery;
  const row = store.getOutbox({ outboxId: "command" });
  assert.equal(row.state, "confirming");
  assert.equal(row.deliveryConfirmed, true);
  assert.equal(row.deliveryUncertain, false);
  assert.equal(row.errorCode ?? null, null, "late receipt failure cannot restore a delivery error after durable positive ACK even with unchanged state");
  assert.equal(submits, 0);
  store.recordOutboxRetry({ outboxId: "command", maxAttempts: 3, uncertainDelivery: true, errorCode: "COLLAB_RATE_LIMITED" });
  assert.equal(store.getOutbox({ outboxId: "command" }).errorCode ?? null, null, "retry accounting cannot revive an error after confirmed delivery");
  assert.equal(store.getOutbox({ outboxId: "command" }).deliveryUncertain, false);
  outbox.stop(); store.close(); store = new CollaborationStore(options);
  assert.equal(store.getOutbox({ outboxId: "command" }).errorCode ?? null, null, "restart keeps positive evidence, not a stale error reason");
  console.log("collaboration operation evidence: ACK dominates late same-state errors and retry accounting");
} finally {
  outbox?.stop(); try { store?.close(); } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
}
