import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { CollaborationStore } = require("../src/main/collaboration/collaboration-store");
const { LocalCollaborationKeyring } = require("../src/main/collaboration/local-keyring");
const { createCollaborationService } = require("../src/main/collaboration/service");
const { createReadRecovery } = require("../src/main/collaboration/read-recovery");
const checkpoint = require("../src/main/collaboration/read-checkpoint");
const { recoverConversationHydration } = require("../src/main/collaboration/conversation-hydration");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-read-recovery-"));
const safeStorage = { isEncryptionAvailable: () => true, encryptString: (v) => Buffer.from(v), decryptString: (v) => v.toString() };
let clock = 1000, store, service;
const open = () => new CollaborationStore({ dbPath: path.join(dir, "cache.db"), accountId: "alice", now: () => clock, keyring: new LocalCollaborationKeyring({ filePath: path.join(dir, "keys"), safeStorage }) });
const tick = () => new Promise((resolve) => setImmediate(resolve));
const seed = (id = "c", scopeId = "personal", joinedSeq = 0, stats = {}) => store.replaceProjectionFromBootstrap({ conversations: [{ id, scopeId, kind: "direct", ...stats }], members: [{ conversationId: id, userId: "alice", role: "member", status: "active", joinedSeq }] });
const lane = (client, deviceId = "device-a") => createReadRecovery({ store, client, deviceId, assertActive() {}, onChange() {}, recoverDeniedHistory() {} });
try {
  store = open(); seed();
  const commands = [];
  let fail = true;
  const client = { async submitMessage(c) { commands.push(c); if (fail) throw new Error("offline"); return { ok: true, result: { lastReadSeq: c.seq } }; } };
  let reads = lane(client);
  for (let i = 0; i < 4; i++) {
    await reads.markRead({ conversationId: "c", seq: 10 });
    const attempts = checkpoint.getReadCheckpoint(store, "c").attempts;
    await reads.markRead({ conversationId: "c", seq: 10 });
    assert.equal(checkpoint.getReadCheckpoint(store, "c").attempts, attempts, "same viewport observation cannot reset retry backoff");
    clock += 60_000;
  }
  assert.equal(commands.length, 4);
  store.close(); store = open(); fail = false; reads = lane(client);
  await reads.markRead({ conversationId: "c", seq: 20 });
  assert.deepEqual(commands[4], commands[0], "exhausted/crashed offline flight eventually resumes with original immutable key");
  assert.equal(commands[5].seq, 20);

  seed("device");
  checkpoint.admitRead(store, { conversationId: "device", seq: 10, deviceId: "device-a" });
  const frozen = checkpoint.beginReadAttempt(store, "device", "device-a");
  clock += 60_000;
  const before = commands.length;
  await lane(client, "device-b").recover(); await lane(client, "").recover();
  assert.equal(commands.length, before, "different/missing devices never replay old intent");
  checkpoint.admitRead(store, { conversationId: "device", seq: 20, deviceId: "device-b" });
  seed("device", "personal", 0, { projectionSeq: 30, lastReadSeq: 10, unreadCount: 2, mentionCount: 1 });
  assert.equal(checkpoint.getReadCheckpoint(store, "device").flight, null, "authorized snapshot may settle an old-device flight");
  assert.equal(checkpoint.getReadCheckpoint(store, "device").pendingMax, 20, "snapshot confirmation retains higher pending");
  await lane(client, "device-b").recover();
  assert.equal(commands.at(-1).deviceId, "device-b");
  assert.notEqual(commands.at(-1).clientCommandId, frozen.clientCommandId);

  for (const lateError of [false, true]) {
    seed("stop");
    let resolve, reject;
    service = createCollaborationService({ openStore: () => ({ ok: true, store }), deviceId: "device-a", realtimeEnabled: false, client: { submitMessage() { return new Promise((r, j) => { resolve = r; reject = j; }); } } });
    const changes = []; service.subscribe((e) => changes.push(e));
    const task = service.markRead({ conversationId: "stop", seq: 10 }); await tick();
    service.stop();
    if (lateError) reject(new Error("late offline")); else resolve({ ok: true, result: { lastReadSeq: 10 } });
    assert.deepEqual(await task, { ok: false, code: "COLLABORATION_STOPPED" });
    assert.deepEqual(changes, [], "late success/error emits nothing and cannot use closed SQLite");
    store = open();
    assert.equal(checkpoint.getReadCheckpoint(store, "stop").confirmedSeq, 0);
    store.db.run("DELETE FROM read_checkpoints WHERE conversation_id='stop'");
  }
  for (const lateError of [false, true]) {
    seed("revoked", "team:t");
    let resolve, reject;
    service = createCollaborationService({ openStore: () => ({ ok: true, store }), deviceId: "device-a", realtimeEnabled: false, client: { submitMessage() { return new Promise((r, j) => { resolve = r; reject = j; }); } } });
    const task = service.markRead({ conversationId: "revoked", seq: 10 }); await tick();
    store.revokeScope({ scopeId: "team:t" });
    assert.equal(checkpoint.getReadCheckpoint(store, "revoked"), null);
    seed("revoked", "team:t", 20);
    checkpoint.admitRead(store, { conversationId: "revoked", seq: 30, deviceId: "device-a" });
    if (lateError) reject(Object.assign(new Error("late denied"), { code: "COLLAB_ORGANIZATION_ACCESS_REVOKED" })); else resolve({ ok: true, result: { lastReadSeq: 10 } });
    await task;
    assert.equal(checkpoint.getReadCheckpoint(store, "revoked").pendingMax, 30, "late old grant response cannot erase or revoke new epoch");
    seed("revoked", "team:t", 40);
    assert.equal(checkpoint.getReadCheckpoint(store, "revoked"), null, "membership epoch reset cannot inherit pending read");
    service.stop(); store = open();
  }
  seed("hydrate");
  store.applySyncPage({ fromCursor: 0, toCursor: 1, events: [{ id: "read-1", conversationId: "hydrate", type: "conversation.read", actorUserId: "alice", seq: 10, payload: { lastReadSeq: 5 } }] });
  let resolveProjection;
  const hydration = recoverConversationHydration({ store, deviceId: "device-a", assertActive() {}, recoverDeniedHistory() { return false; }, client: { getConversationProjection() { return new Promise((r) => { resolveProjection = r; }); } } });
  await tick();
  store.applySyncPage({ fromCursor: 1, toCursor: 2, events: [{ id: "read-2", conversationId: "hydrate", type: "conversation.read", actorUserId: "alice", seq: 11, payload: { lastReadSeq: 8 } }] });
  resolveProjection({ conversation: { id: "hydrate", kind: "direct", scopeType: "personal", projectionSeq: 10, lastReadSeq: 5, unreadCount: 3, mentionCount: 1 }, members: [{ conversationId: "hydrate", userId: "alice", role: "member", status: "active", joinedSeq: 0 }], profiles: [] });
  await assert.rejects(hydration, (error) => error.code === "COLLAB_CONVERSATION_STALE", "a changed hydration generation prevents cursor ACK until the next authorized refresh");
  assert.ok(store.db.get("SELECT 1 FROM conversation_hydration WHERE conversation_id='hydrate'"), "a new read while GET is in flight retains its durable exact-refresh generation");
  seed("hydrate", "personal", 0, { projectionSeq: 10, lastReadSeq: 5, unreadCount: 3, mentionCount: 1 });
  assert.ok(store.db.get("SELECT 1 FROM conversation_hydration WHERE conversation_id='hydrate'"), "a stale bootstrap started before the newer own read cannot discard its exact refresh");
  let acks = 0;
  service = createCollaborationService({ openStore: () => ({ ok: true, store }), deviceId: "device-a", realtimeEnabled: false, client: {
    async bootstrap() { return { conversations: [{ id: "hydrate", kind: "direct", scopeType: "personal", projectionSeq: 10, lastReadSeq: 5, unreadCount: 3, mentionCount: 1 }] }; },
    async listMessageHistory() { return { messages: [] }; }, async getConversationProjection() { throw new Error("projection offline"); },
    async acknowledgeCursor() { acks++; },
  } });
  await assert.rejects(service.bootstrap(), /projection offline/, "stale full bootstrap cannot ACK before pending own-read hydration succeeds");
  assert.equal(acks, 0);
  service.stop(); store = open();
  let syncs = 0;
  service = createCollaborationService({ openStore: () => ({ ok: true, store }), deviceId: "device-a", realtimeEnabled: false, client: {
    async getConversationProjection() { return { conversation: { id: "hydrate", kind: "direct", scopeType: "personal", projectionSeq: 11, lastReadSeq: 8, unreadCount: 1, mentionCount: 0 }, members: [{ conversationId: "hydrate", userId: "alice", role: "member", status: "active", joinedSeq: 0 }], profiles: [] }; },
    async listMessageHistory() { return { messages: [] }; },
    async syncAndAcknowledge({ afterCursor, onIncrementalPage }) { syncs++; return onIncrementalPage({ page: { fromCursor: afterCursor, toCursor: afterCursor, events: [] }, acknowledge() { assert.equal(store.getConversation({ conversationId: "hydrate" }).unreadCount, 1); acks++; } }); },
  } });
  service.start(); for (let i = 0; i < 8; i++) await tick();
  assert.equal(syncs, 1); assert.equal(acks, 1, "restart hydrates exact own counts before acknowledging even an empty next page");
  service.stop(); store = open();
  seed("independent");
  let releaseRead, textSends = 0;
  service = createCollaborationService({ openStore: () => ({ ok: true, store }), deviceId: "device-a", realtimeEnabled: false,
    client: { submitMessage() { return new Promise((r) => { releaseRead = r; }); } },
    transport: { async submit() { textSends++; return { ok: true }; } } });
  const readPending = service.markRead({ conversationId: "independent", seq: 10 }); await tick();
  const sent = await service.send({ conversationId: "independent", clientCommandId: "independent-text", bodyText: "still works" });
  assert.equal(sent.ok, true); assert.equal(textSends, 1, "a hung read never occupies the independent text send lane");
  releaseRead({ ok: true, result: { lastReadSeq: 10 } }); await readPending;
  const cached = service.markRead({ conversationId: "independent", seq: 10 }); service.stop();
  assert.deepEqual(await cached, { ok: false, code: "COLLABORATION_STOPPED" }, "even a cached confirmed result is fenced at the service await boundary");
  store = open();
  console.log("collaboration read recovery: backoff, restart, device/snapshot, stop, revoke/regrant, membership epoch, hydration generation passed");
} finally { try { store?.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); }
