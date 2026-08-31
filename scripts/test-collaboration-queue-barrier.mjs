import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { CollaborationStore } = require("../src/main/collaboration/collaboration-store.js");
const { LocalCollaborationKeyring } = require("../src/main/collaboration/local-keyring.js");
const { createCollaborationOutbox } = require("../src/main/collaboration/outbox.js");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-queue-barrier-"));
const keyring = new LocalCollaborationKeyring({ filePath: path.join(dir, "keys.json"), safeStorage: {
  isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString(),
} });
const store = new CollaborationStore({ dbPath: path.join(dir, "cache.db"), accountId: "alice", keyring, now: () => 100 });
const sent = [];
const outbox = createCollaborationOutbox({ store, transport: { submit: async (item) => { sent.push(item.clientCommandId); } } });
try {
  // Same timestamp and reverse lexical IDs: chronology is durable insertion order.
  for (const id of ["z-first", "a-second"]) store.persistDraftAndOptimisticMessage({ conversationId: "c", messageId: `m:${id}`, clientCommandId: id, bodyText: id, draftId: "composer", draftText: "" });
  store.setOutboxState({ outboxId: "z-first", expectedStates: ["queued"], state: "paused" });
  const blocked = await outbox.submit("a-second");
  assert.deepEqual(sent, [], "a paused predecessor prevents later messages overtaking it");
  assert.equal(blocked.state, "queued");
  assert.equal(blocked.blockedBy, "z-first");
  assert.equal(store.getOutbox({ outboxId: "a-second" }).state, "queued", "blocked successor stays durable, not failed");
  outbox.skip("z-first");
  await outbox.drainQueued();
  assert.deepEqual(sent, ["a-second"], "explicit skip releases the queue barrier");
  for (const id of ["uncertain", "after-uncertain"]) store.persistDraftAndOptimisticMessage({ conversationId: "other", messageId: `m:${id}`, clientCommandId: id, bodyText: id, draftId: "composer", draftText: "" });
  const ambiguous = createCollaborationOutbox({ store, transport: { submit: async (item) => {
    if (item.clientCommandId === "uncertain") throw Object.assign(new Error("lost ACK"), { code: "COLLAB_RESPONSE_UNKNOWN" });
    sent.push(item.clientCommandId);
  } } });
  await ambiguous.submit("uncertain");
  assert.equal((await ambiguous.submit("after-uncertain")).blockedBy, "uncertain", "unknown commit must not let successors overtake the original intent");
  store.settleOutboxFromSync({ clientCommandId: "uncertain", eventId: "event", messageId: "server", sequence: 1 });
  await ambiguous.submit("after-uncertain");
  assert.equal(sent.at(-1), "after-uncertain", "durable receipt releases an uncertain predecessor");
  ambiguous.stop();
  store.persistDraftAndOptimisticMessage({ conversationId: "recover", messageId: "recover-local", clientCommandId: "recover-cmd", bodyText: "original", draftId: "composer", draftText: "" });
  let attempts = 0;
  const recovering = createCollaborationOutbox({ store, transport: {
    submit: async () => { attempts += 1; throw Object.assign(new Error("lost"), { code: "COLLAB_RESPONSE_UNKNOWN" }); },
    lookupReceipt: async () => ({ committed: true, eventId: "recover-event", messageId: "recover-server", sequence: 9 }),
  } });
  await recovering.submit("recover-cmd");
  assert.equal(typeof recovering.reconcilePending, "function", "startup/sync must have a receipt recovery path, without user cancellation");
  await recovering.reconcilePending();
  assert.equal(store.getOutbox({ outboxId: "recover-cmd" }).state, "persisted");
  assert.equal(store.getMessage({ conversationId: "recover", messageId: "recover-server" }).seq, 9);
  assert.equal(attempts, 1, "committed receipt is recovered without retransmitting");
  recovering.stop();
  console.log("collaboration durable queue barrier passed");
} finally { outbox.stop(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
