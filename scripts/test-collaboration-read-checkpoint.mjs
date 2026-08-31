import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { CollaborationStore } = require("../src/main/collaboration/collaboration-store");
const { LocalCollaborationKeyring } = require("../src/main/collaboration/local-keyring");
const { createCollaborationService } = require("../src/main/collaboration/service");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-read-checkpoint-"));
const safeStorage = { isEncryptionAvailable: () => true, encryptString: (v) => Buffer.from(v), decryptString: (v) => v.toString() };
let clock = 1000;
const open = () => new CollaborationStore({ dbPath: path.join(dir, "cache.db"), accountId: "alice", now: () => clock, keyring: new LocalCollaborationKeyring({ filePath: path.join(dir, "keys.json"), safeStorage }) });
const tick = () => new Promise((r) => setImmediate(r));
let store = open(), service;
try {
  assert.ok(store.db.get("SELECT name FROM sqlite_master WHERE name='read_checkpoints'"), "read intent has an independent durable table");
  const checkpoint = require("../src/main/collaboration/read-checkpoint");
  store.replaceProjectionFromBootstrap({ conversations: [{ id: "c", kind: "direct" }] });
  let reject, requests = [];
  service = createCollaborationService({ openStore: () => ({ ok: true, store }), deviceId: "device-a", realtimeEnabled: false,
    client: { submitMessage(request) { requests.push(request); return new Promise((_, r) => { reject = r; }); } } });
  const first = service.markRead({ conversationId: "c", seq: 10 });
  await tick();
  const second = service.markRead({ conversationId: "c", seq: 20 });
  assert.equal(requests.length, 1, "simultaneous reads share one flight");
  const original = { ...requests[0] };
  assert.match(original.clientCommandId, /^[0-9a-f-]{36}$/);
  assert.equal(checkpoint.getReadCheckpoint(store, "c").pendingMax, 20);
  reject(new Error("lost ACK"));
  await Promise.all([first, second]);
  assert.equal(checkpoint.getReadCheckpoint(store, "c").attempts, 1);
  service.stop(); clock += 60_000; store = open();
  service = createCollaborationService({ openStore: () => ({ ok: true, store }), deviceId: "device-a", realtimeEnabled: false,
    client: { async submitMessage(request) { requests.push(request); return { ok: true, result: { lastReadSeq: request.seq } }; } } });
  await service.markRead({ conversationId: "c", seq: 20 });
  assert.deepEqual(requests[1], original, "restart replays the frozen original UUID/device/seq");
  assert.equal(requests[2].seq, 20, "higher pending is sent only after old flight settles");
  assert.notEqual(requests[2].clientCommandId, original.clientCommandId);
  assert.equal(checkpoint.getReadCheckpoint(store, "c").confirmedSeq, 20);
  await service.markRead({ conversationId: "c", seq: 20 });
  assert.equal(requests.length, 3, "same observation cannot readmit confirmed work");
  assert.equal(store.listOutbox().length, 0, "read state never joins the text send barrier");
  store.replaceProjectionFromBootstrap({ conversations: [{ id: "clamp", kind: "direct" }] });
  service.stop(); store = open();
  const clampedRequests = [];
  const clampedClient = { async submitMessage(command) { clampedRequests.push(command); return { ok: true, result: { lastReadSeq: command.seq === 99 ? 5 : command.seq } }; } };
  service = createCollaborationService({ openStore: () => ({ ok: true, store }), deviceId: "device-a", realtimeEnabled: false, client: clampedClient });
  assert.equal((await service.markRead({ conversationId: "clamp", seq: 99 })).seq, 5);
  await service.markRead({ conversationId: "clamp", seq: 99 });
  assert.equal(clampedRequests.length, 1, "a handled clamped observation cannot immediately resubmit");
  service.stop(); store = open();
  service = createCollaborationService({ openStore: () => ({ ok: true, store }), deviceId: "device-a", realtimeEnabled: false, client: clampedClient });
  await service.markRead({ conversationId: "clamp", seq: 99 });
  assert.equal(clampedRequests.length, 1, "handled clamping survives restart");
  assert.equal((await service.markRead({ conversationId: "clamp", seq: 10 })).seq, 10, "a real newer message below an earlier invalid observation is not stranded");
  assert.equal(clampedRequests.length, 2);
  assert.notEqual(clampedRequests[1].clientCommandId, clampedRequests[0].clientCommandId);
  await service.markRead({ conversationId: "clamp", seq: 99 });
  assert.equal(clampedRequests.length, 2, "the handled invalid observation stays suppressed after a valid lower observation");
  assert.equal(checkpoint.getReadCheckpoint(store, "clamp").confirmedSeq, 10);
  store.replaceProjectionFromBootstrap({ conversations: [{ id: "clamp-pending", kind: "direct" }] });
  service.stop(); store = open();
  let loseClampedAck;
  const pendingRequests = [];
  service = createCollaborationService({ openStore: () => ({ ok: true, store }), deviceId: "device-a", realtimeEnabled: false,
    client: { submitMessage(command) { pendingRequests.push(command); return new Promise((_, reject) => { loseClampedAck = reject; }); } } });
  const pendingFirst = service.markRead({ conversationId: "clamp-pending", seq: 99 }); await tick();
  const pendingLower = service.markRead({ conversationId: "clamp-pending", seq: 10 });
  const pendingHigher = service.markRead({ conversationId: "clamp-pending", seq: 120 });
  assert.equal(checkpoint.getReadCheckpoint(store, "clamp-pending").pendingMax, 120, "lower observations never replace a higher coalesced pending sequence");
  loseClampedAck(new Error("lost clamp ACK")); await Promise.all([pendingFirst, pendingLower, pendingHigher]);
  service.stop(); store = open(); clock += 60_000;
  service = createCollaborationService({ openStore: () => ({ ok: true, store }), deviceId: "device-a", realtimeEnabled: false,
    client: { async submitMessage(command) { pendingRequests.push(command); return { ok: true, result: { lastReadSeq: command.seq === 99 ? 5 : command.seq } }; } } });
  await service.markRead({ conversationId: "clamp-pending", seq: 10 });
  assert.deepEqual(pendingRequests[1], pendingRequests[0], "crash recovery keeps the immutable clamped flight identity");
  assert.equal(pendingRequests[2].seq, 120, "clamped ACK consumes only its old flight and retains the higher pending maximum");
  assert.equal(checkpoint.getReadCheckpoint(store, "clamp-pending").confirmedSeq, 120);
  store.replaceProjectionFromBootstrap({ conversations: [{ id: "clamp-progress", kind: "direct" }] });
  service.stop(); store = open();
  let authoritativeProgress = false;
  const progressRequests = [];
  service = createCollaborationService({ openStore: () => ({ ok: true, store }), deviceId: "device-a", realtimeEnabled: false, client: {
    async submitMessage(command) { progressRequests.push(command); return { ok: true, result: { lastReadSeq: command.seq === 99 && !authoritativeProgress ? 5 : command.seq } }; },
    async bootstrap() { authoritativeProgress = true; return { watermark: 1, conversations: [{ id: "clamp-progress", kind: "direct", projectionSeq: 99, lastReadSeq: 10, unreadCount: 89, mentionCount: 0 }] }; },
    async listMessageHistory() { return { messages: [] }; }, async acknowledgeCursor() {},
  } });
  await service.markRead({ conversationId: "clamp-progress", seq: 99 });
  store.applySyncPage({ fromCursor: 0, toCursor: 1, events: [{ id: "clamped-own-read", conversationId: "clamp-progress", type: "conversation.read", seq: 6, actorUserId: "alice", payload: { lastReadSeq: 5 } }] });
  await service.markRead({ conversationId: "clamp-progress", seq: 99 });
  assert.equal(progressRequests.length, 1, "the old clamped read's own event is not proof that message 99 now exists");
  await service.markRead({ conversationId: "clamp-progress", seq: 10 });
  await service.markRead({ conversationId: "clamp-progress", seq: 99 });
  assert.equal(progressRequests.length, 2);
  await service.bootstrap();
  assert.equal((await service.markRead({ conversationId: "clamp-progress", seq: 99 })).seq, 99, "authorized bootstrap progression releases a previously handled clamp");
  assert.deepEqual(progressRequests.map((r) => r.seq), [99, 10, 99]);
  assert.notEqual(progressRequests[0].clientCommandId, progressRequests[2].clientCommandId);
  for (const source of ["sync", "history"]) {
    const conversationId = `clamp-${source}`;
    store.replaceProjectionFromBootstrap({ conversations: [{ id: conversationId, kind: "direct" }] });
    service.stop(); store = open(); authoritativeProgress = false;
    const arrivals = [];
    const arrivalClient = { async submitMessage(command) { arrivals.push(command); return { ok: true, result: { lastReadSeq: authoritativeProgress ? command.seq : 5 } }; } };
    service = createCollaborationService({ openStore: () => ({ ok: true, store }), deviceId: "device-a", realtimeEnabled: false, client: arrivalClient });
    await service.markRead({ conversationId, seq: 99 });
    if (source === "sync") store.applySyncPage({ fromCursor: 0, toCursor: 1, events: [{ id: "new-99", conversationId, type: "message.created", seq: 99, actorUserId: "bob", payload: { messageId: "new-99", revision: 1 } }] });
    else store.hydrateAuthorizedHistory({ conversationId, messages: [{ id: "new-99", conversationId, createSeq: 99, senderUserId: "bob", revision: 1, bodyText: "new message" }] });
    service.stop(); store = open(); authoritativeProgress = true;
    service = createCollaborationService({ openStore: () => ({ ok: true, store }), deviceId: "device-a", realtimeEnabled: false, client: arrivalClient });
    assert.equal((await service.markRead({ conversationId, seq: 99 })).seq, 99, `${source} proof releases clamping durably, including legacy unknown-count conversations`);
    assert.equal(arrivals.length, 2);
  }
  console.log("collaboration read checkpoint: independent encrypted immutable restart/singleflight passed");
} finally { service?.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
