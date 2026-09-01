import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { CollaborationStore } = require("../src/main/collaboration/collaboration-store.js");
const { LocalCollaborationKeyring } = require("../src/main/collaboration/local-keyring.js");
const { createCollaborationService } = require("../src/main/collaboration/service.js");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-recovery-integrity-"));
const keyring = new LocalCollaborationKeyring({ filePath: path.join(dir, "keys.json"), safeStorage: {
  isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString(),
} });
let store = new CollaborationStore({ dbPath: path.join(dir, "cache.db"), accountId: "alice", keyring });
const service = createCollaborationService({ openStore: () => ({ ok: true, store }), deviceId: "device-alice", transport: { submit: async () => ({}) } });
const snapshot = { watermark: 0, conversations: [{ id: "c1", kind: "direct" }, { id: "c2", kind: "direct" }],
  profile: { userId: "alice", displayName: "Alice" }, profiles: [{ userId: "alice", displayName: "Alice" }] };
try {
  assert.doesNotThrow(() => store.replaceProjectionFromBootstrap(snapshot), "own profile may also appear among visible member profiles");
  const initialSend = await service.send({ conversationId: "c1", clientCommandId: "cmd", bodyText: "original" });
  assert.equal(initialSend.ok, true, "the first original-device send must be admitted before checking reuse conflicts");
  assert.equal(store.getOutbox({ outboxId: "cmd" }).originDeviceId, "device-alice", "the admitted intent retains its real device identity");
  assert.deepEqual(await service.send({ conversationId: "c2", clientCommandId: "cmd", bodyText: "original" }),
    { ok: false, code: "IDEMPOTENCY_KEY_REUSED", retryable: false }, "same local command cannot silently target another conversation");
  assert.deepEqual(await service.send({ conversationId: "c1", clientCommandId: "cmd", bodyText: "different" }),
    { ok: false, code: "IDEMPOTENCY_KEY_REUSED", retryable: false }, "same local key with different body is a conflict");
  const optimistic = store.listMessages({ conversationId: "c1" })[0];
  assert.equal(optimistic.clientCommandId, "cmd", "DOM identity is bound to durable intent before the ACK");
  store.applySyncPage({ fromCursor: 0, toCursor: 1, events: [{ id: "foreign", cursor: 1, type: "message.created", conversationId: "c1", actorUserId: "bob", seq: 1, clientCommandId: "cmd", payload: { messageId: "bob-message" } }] });
  assert.equal(store.getOutbox({ outboxId: "cmd" }).state, "confirming", "another user's colliding command id cannot confirm my intent");
  store.applySyncPage({ fromCursor: 1, toCursor: 2, events: [{ id: "own", cursor: 2, type: "message.created", conversationId: "c1", actorUserId: "alice", seq: 2, clientCommandId: "cmd", payload: { messageId: "server-message" } }] });
  assert.equal(store.listMessages({ conversationId: "c1" })[0].clientCommandId, "cmd", "server id remap preserves DOM identity");
  assert.equal(store.listMessages({ conversationId: "c1" })[0].id, "server-message");
  for (const state of ["queued", "paused", "failed", "delivery_unknown", "confirming"]) {
    const id = `pending-${state}`;
    store.persistDraftAndOptimisticMessage({ conversationId: "c2", messageId: `optimistic:${id}`, clientCommandId: id, draftId: "composer", draftText: "", bodyText: id });
    if (state !== "queued") store.setOutboxState({ outboxId: id, expectedStates: ["queued"], state });
  }
  store.replaceProjectionFromBootstrap({ ...snapshot, watermark: 2 });
  assert.equal(store.listMessages({ conversationId: "c2" }).length, 5, "full resync preserves every nonterminal or recoverable local bubble");
  store.hydrateAuthorizedHistory({ conversationId: "c1", messages: [{ id: "visible", seq: 10, bodyText: "must remain visible", revision: 1 }] });
  for (let i = 0; i < 200; i++) {
    const id = `cancelled-${i}`;
    store.persistDraftAndOptimisticMessage({ conversationId: "c1", messageId: id, clientCommandId: id, draftId: "composer", draftText: "", bodyText: "cancelled" });
    store.setOutboxState({ outboxId: id, expectedStates: ["queued"], state: "cancelled" });
  }
  assert.equal(store.listMessages({ conversationId: "c1" }).some((message) => message.id === "visible"), true, "cancelled optimistic aliases cannot consume the history page limit");
  // Existing v5 optimistic rows have no indexed command id. Opening the
  // upgraded cache must recover it from the encrypted durable outbox.
  const legacy = store.db.get("SELECT scope_id FROM messages WHERE id = ?", "optimistic:pending-paused");
  store.db.run("UPDATE messages SET body_envelope_json = ? WHERE id = ?", store._encrypt({ scopeId: legacy.scope_id,
    recordId: store._messageRecord("c2", "optimistic:pending-paused"), value: { bodyText: "pending-paused" } }), "optimistic:pending-paused");
  store.db.run("UPDATE messages SET client_command_id = NULL WHERE seq IS NULL");
  store.close();
  store = new CollaborationStore({ dbPath: path.join(dir, "cache.db"), accountId: "alice", keyring });
  assert.equal(store.listMessages({ conversationId: "c1" }).some((message) => message.id === "visible"), true, "legacy cancelled aliases remain excluded after restart/backfill");
  assert.equal(store.db.get("SELECT client_command_id FROM messages WHERE id = ?", "cancelled-0").client_command_id, "cancelled-0");
  assert.equal(store.listMessages({ conversationId: "c2" }).length, 5, "backfill preserves recoverable queued messages");
  const paused = store.listMessages({ conversationId: "c2" }).find((message) => message.id === "optimistic:pending-paused");
  assert.equal(paused.state, "paused", "v4 body-only envelopes inherit delivery state from migrated command identity");
  assert.equal(paused.clientCommandId, "pending-paused");
  assert.equal(store.getMessage({ conversationId: "c2", messageId: paused.id }).clientCommandId, "pending-paused");
  console.log("collaboration recovery integrity passed");
} finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
