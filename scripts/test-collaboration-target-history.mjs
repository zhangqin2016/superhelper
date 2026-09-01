import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
const require = createRequire(import.meta.url);
const { CollaborationStore } = require("../src/main/collaboration/collaboration-store.js");
const { LocalCollaborationKeyring } = require("../src/main/collaboration/local-keyring.js");
const { createCollaborationClient } = require("../src/main/collaboration/client.js");
const { createCollaborationService } = require("../src/main/collaboration/service.js");
const { createCollaborationSyncEngine } = require("../src/main/collaboration/sync-engine.js");
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-target-history-"));
  const keyring = new LocalCollaborationKeyring({ filePath: path.join(dir, "keys.json"), safeStorage: {
    isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString(),
  } });
  let store;
  const reopen = () => store = new CollaborationStore({ dbPath: path.join(dir, "cache.db"), accountId: "alice", keyring });
  reopen();
  t.after(() => { try { store.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  store.replaceProjectionFromBootstrap({ conversations: [{ id: "c", kind: "direct" }] });
  store.hydrateAuthorizedHistory({ conversationId: "c", messages: Array.from({ length: 451 }, (_, i) => ({ id: `m${i + 1}`, seq: i + 1, bodyText: "old", revision: 1 })) });
  return { get store() { return store; }, reopen };
}
const changed = (cursor, messageId = "m1") => ({ id: `e${cursor}`, type: "message.revoked", cursor, seq: 451 + cursor, conversationId: "c", payload: { messageId, revision: 2 } });
function network(handler) {
  return createCollaborationClient({ accountManager: { accessTokenForService: async () => ({ ok: true, accessToken: "test" }) }, signDeviceRequest: async () => ({}),
    request: async (input) => ({ ok: true, status: 200, json: await handler(input) }),
  });
}
test("a revoke older than the latest 200 is hydrated by event target before ACK", async (t) => {
  const f = fixture(t), calls = [];
  const client = network(async ({ path: route, body }) => {
    if (route.endsWith("/sync")) return { fromCursor: 0, toCursor: 1, events: [changed(1)] };
    if (route.endsWith("/messages")) {
      calls.push(body.messageIds);
      return { result: body.messageIds ? [{ id: "m1", conversationId: "c", createSeq: 1, bodyText: null, revision: 2, revokedAt: "2026-08-31" }] : [] };
    }
    calls.push(["ack", f.store.getMessage({ conversationId: "c", messageId: "m1" }).revokedAt]);
    return {};
  });
  const service = createCollaborationService({ openStore: () => ({ ok: true, store: f.store }), client, deviceId: "d" });
  await service.realtime.notifyAvailable();
  assert.deepEqual(calls, [["m1"], ["ack", "2026-08-31"]], "ACK follows old-message tombstone persistence");
  assert.deepEqual(f.store.listPendingHistoryHydration(), []);
  service.stop();
});
test("target checkpoint survives restart and a latest-page read cannot clear it", async (t) => {
  const f = fixture(t);
  createCollaborationSyncEngine({ store: f.store }).applyPage({ fromCursor: 0, toCursor: 1, events: [changed(1)] });
  f.store.close(); f.reopen();
  const calls = [];
  const client = network(async ({ path: route, body }) => {
    if (route.endsWith("/messages")) { calls.push(body.messageIds || "latest"); return { result: body.messageIds ? [{ id: "m1", conversationId: "c", seq: 1, revision: 2, bodyText: "edited" }] : [] }; }
    if (route.endsWith("/sync")) { calls.push("sync"); return { fromCursor: 1, toCursor: 1, events: [] }; }
    calls.push("ack"); return {};
  });
  const service = createCollaborationService({ openStore: () => ({ ok: true, store: f.store }), client, deviceId: "d" });
  await service.open({ conversationId: "c" });
  assert.deepEqual(f.store.listPendingHistoryHydration(), ["c"], "latest history is not proof that an old target was hydrated");
  await service.realtime.notifyAvailable();
  assert.deepEqual(calls, ["latest", ["m1"], "sync", "ack"]);
  assert.equal(f.store.getMessage({ conversationId: "c", messageId: "m1" }).bodyText, "edited");
  service.stop();
});
test("missing target fails closed and retries without acknowledging or losing checkpoint", async (t) => {
  const f = fixture(t), calls = [];
  createCollaborationSyncEngine({ store: f.store }).applyPage({ fromCursor: 0, toCursor: 1, events: [changed(1)] });
  const client = network(async ({ path: route }) => { calls.push(route); return { result: [] }; });
  const service = createCollaborationService({ openStore: () => ({ ok: true, store: f.store }), client, deviceId: "d" });
  await service.realtime.notifyAvailable();
  assert.deepEqual(f.store.listPendingHistoryHydration(), ["c"]);
  assert.equal(calls.length, 1);
  await service.realtime.notifyAvailable();
  assert.equal(calls.length, 2, "the hint channel retries history, never proceeds to sync/ACK");
  assert.ok(calls.every((route) => route.endsWith("/messages")));
  service.stop();
});
test("bootstrap failure leaves every unhydrated conversation durable across restart", async (t) => {
  const f = fixture(t);
  const client = network(async ({ path: route }) => {
    if (route.endsWith("/bootstrap")) return { watermark: 2, conversations: [{ id: "c" }, { id: "other" }] };
    throw Object.assign(new Error("offline"), { code: "ECONNRESET" });
  });
  const service = createCollaborationService({ openStore: () => ({ ok: true, store: f.store }), client, deviceId: "d" });
  await assert.rejects(service.bootstrap()); service.stop(); f.reopen();
  assert.deepEqual(f.store.listPendingHistoryHydration(), ["c", "other"]);
});

test("over 200 targets use bounded batches and retry a partial failure before ACK", async (t) => {
  const f = fixture(t), events = Array.from({ length: 201 }, (_, i) => changed(i + 1, `m${i + 1}`));
  createCollaborationSyncEngine({ store: f.store }).applyPage({ fromCursor: 0, toCursor: 201, events });
  const batches = []; let fail = true, acknowledgements = 0;
  const client = network(async ({ path: route, body }) => {
    if (route.endsWith("/messages")) {
      batches.push(body.messageIds);
      if (batches.length === 2 && fail) throw new Error("connection lost");
      return { result: body.messageIds.map((id) => ({ id, conversationId: "c", seq: Number(id.slice(1)), bodyText: "updated", revision: 2 })) };
    }
    if (route.endsWith("/sync")) return { fromCursor: 201, toCursor: 201, events: [] };
    acknowledgements++; return {};
  });
  const service = createCollaborationService({ openStore: () => ({ ok: true, store: f.store }), client, deviceId: "d" });
  await service.realtime.notifyAvailable();
  assert.deepEqual(batches.map((b) => b.length), [200, 1]); assert.equal(acknowledgements, 0);
  assert.equal(f.store.listHistoryTargets({ conversationId: "c" }).length, 201);
  fail = false; await service.realtime.notifyAvailable();
  assert.equal(acknowledgements, 1); assert.deepEqual(f.store.listPendingHistoryHydration(), []);
  assert.equal(f.store.getMessage({ conversationId: "c", messageId: "m201" }).revision, 2);
  service.stop();
});

for (const bad of [
  [{ id: "m1", seq: 1, revision: 2 }],
  [{ id: "other", seq: 1, revision: 2 }],
  [{ id: "m1", seq: 1, revision: 1 }],
  [{ id: "m1", seq: 0, revision: 2 }],
  [{ id: "m1", seq: 1, revision: 2, conversationId: "wrong" }],
]) test(`invalid target page never clears checkpoint: ${JSON.stringify(bad)}`, async (t) => {
  const f = fixture(t); let requests = 0;
  createCollaborationSyncEngine({ store: f.store }).applyPage({ fromCursor: 0, toCursor: 1, events: [changed(1)] });
  const client = network(async () => { requests++; return { result: bad }; });
  const service = createCollaborationService({ openStore: () => ({ ok: true, store: f.store }), client, deviceId: "d" });
  await service.realtime.notifyAvailable();
  assert.equal(requests, 1); assert.deepEqual(f.store.listPendingHistoryHydration(), ["c"]);
  assert.equal(f.store.getMessage({ conversationId: "c", messageId: "m1" }).bodyText, "old");
  service.stop();
});

test("explicit unavailable proof removes an invisible old target and permits subsequent sync", async (t) => {
  const f = fixture(t), calls = [];
  createCollaborationSyncEngine({ store: f.store }).applyPage({ fromCursor: 0, toCursor: 1, events: [changed(1)] });
  const client = network(async ({ path: route }) => {
    calls.push(route.split("/").at(-1));
    if (route.endsWith("/messages")) return { result: { messages: [], unavailableMessageIds: ["m1"] } };
    if (route.endsWith("/sync")) return { fromCursor: 1, toCursor: 1, events: [] };
    return {};
  });
  const service = createCollaborationService({ openStore: () => ({ ok: true, store: f.store }), client, deviceId: "d" });
  await service.realtime.notifyAvailable();
  assert.deepEqual(calls, ["messages", "sync", "ack"]);
  assert.equal(f.store.getMessage({ conversationId: "c", messageId: "m1" }), null);
  assert.deepEqual(f.store.listPendingHistoryHydration(), []);
  service.stop();
});

for (const revision of [undefined, 0, 1, 1.5, "bad"]) test(`malformed revoke revision rolls back the whole sync page: ${revision}`, (t) => {
  const f = fixture(t);
  const event = changed(1); event.payload.revision = revision;
  assert.throws(() => createCollaborationSyncEngine({ store: f.store }).applyPage({ fromCursor: 0, toCursor: 1, events: [event] }), (e) => e.code === "COLLAB_HISTORY_INVALID");
  assert.equal(f.store.getSyncState().cursor, 0); assert.equal(f.store.countAppliedEvents(), 0);
});
