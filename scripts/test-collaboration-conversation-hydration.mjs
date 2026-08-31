import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
const require = createRequire(import.meta.url);
const { CollaborationStore } = require("../src/main/collaboration/collaboration-store");
const { LocalCollaborationKeyring } = require("../src/main/collaboration/local-keyring");
const { createCollaborationService } = require("../src/main/collaboration/service");
const { createCollaborationClient } = require("../src/main/collaboration/client");
const { createCollaborationSyncEngine } = require("../src/main/collaboration/sync-engine");
function fixture(t, { legacy = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-conv-hydration-"));
  const keyring = new LocalCollaborationKeyring({ filePath: path.join(dir, "keys"), safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() } });
  const options = { dbPath: path.join(dir, "cache"), accountId: "alice", keyring };
  if (legacy) {
    const { openDatabase } = require("../src/main/store/sqlite-db");
    const { COLLABORATION_MIGRATIONS } = require("../src/main/collaboration/schema");
    const db = openDatabase(options.dbPath);
    db.migrate(COLLABORATION_MIGRATIONS.slice(0, 9));
    db.run("INSERT INTO history_hydration VALUES ('alice','c',1)");
    db.run("INSERT INTO history_hydration_targets VALUES ('alice','c','m',1)");
    db.run("INSERT INTO sync_state VALUES ('alice',1,1,1)");
    db.close();
  }
  let store = new CollaborationStore(options), service;
  t.after(() => { try { service?.stop(); store.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  return { get store() { return store; }, reopen() { store.close(); store = new CollaborationStore(options); }, create(client) { service = createCollaborationService({ openStore: () => ({ ok: true, store }), client, deviceId: "device" }); return service; } };
}
const joined = (cursor, type = "member.joined") => ({ id: `evt-${cursor}`, cursor, seq: cursor, conversationId: "c", actorUserId: "owner", type, payload: { userId: "alice" } });
const projection = () => ({ conversation: { id: "c", kind: "channel", scope_type: "organization", organization_id: "org", scopeId: "team:org", visibility: "private", title: "Team channel" }, members: [{ conversation_id: "c", user_id: "alice", status: "active", role: "member", joined_seq: 2 }], profiles: [{ user_id: "alice", lily_id: "alice", display_name: "Alice" }] });
function clientFor(handler) { return createCollaborationClient({ accountManager: { accessTokenForService: async () => ({ ok: true, accessToken: "test" }) }, signDeviceRequest: async () => ({}), request: async (input) => ({ ok: true, status: 200, json: await handler(input) }) }); }

test("v9 pending unknown history upgrades to durable metadata discovery before any ACK", async (t) => {
  const f = fixture(t, { legacy: true }), calls = [];
  f.reopen(); // Recovery must not depend on keeping the migrating process alive.
  const service = f.create(clientFor(async ({ path: route, body }) => {
    calls.push(route.split("/").at(-1));
    if (route.endsWith("/conversations/get")) return { result: projection() };
    if (route.endsWith("/messages")) return { result: { messages: [{ id: "m", conversationId: "c", seq: 3, bodyText: "legacy pending", revision: 1 }], unavailableMessageIds: [] } };
    if (route.endsWith("/sync")) return { fromCursor: body.afterCursor, toCursor: body.afterCursor, events: [] };
    if (route.endsWith("/ack")) { assert.equal(f.store.getMessage({ conversationId: "c", messageId: "m" })?.bodyText, "legacy pending"); return { ok: true }; }
    throw new Error(`unexpected ${route}`);
  }));
  await service.realtime.notifyAvailable();
  assert.deepEqual(calls, ["get", "messages", "sync", "ack"]);
  assert.equal(f.store.getConversation({ conversationId: "c" })?.scopeId, "team:org");
  assert.deepEqual(f.store.listPendingHistoryHydration(), []);
});

test("unknown joined conversation hydrates authorized metadata and history before ACK", async (t) => {
  const f = fixture(t), calls = [];
  const client = clientFor(async ({ path: route, body }) => {
    calls.push(route.split("/").at(-1));
    if (route.endsWith("/sync")) return { fromCursor: 0, toCursor: 1, events: [joined(1)] };
    if (route.endsWith("/conversations/get")) return { result: projection() };
    if (route.endsWith("/messages")) return { result: [{ id: "m", conversationId: "c", seq: 3, bodyText: "new grant", revision: 1 }] };
    if (route.endsWith("/ack")) { assert.equal(f.store.getMessage({ conversationId: "c", messageId: "m" }).bodyText, "new grant"); return { ok: true }; }
    throw new Error(`unexpected ${route}`);
  });
  await f.create(client).realtime.notifyAvailable();
  assert.deepEqual(calls, ["sync", "get", "messages", "ack"]);
  assert.equal(f.store.getConversation({ conversationId: "c" }).scopeId, "team:org");
  assert.equal(f.store.listConversationMembers({ conversationId: "c" })[0].joinedSeq, 2);
});

test("metadata checkpoint survives restart and blocks newer sync until recovered", async (t) => {
  const f = fixture(t);
  createCollaborationSyncEngine({ store: f.store }).applyPage({ fromCursor: 0, toCursor: 1, events: [joined(1, "conversation.created")] });
  f.reopen(); let fail = true, syncs = 0, acks = 0;
  const client = {
    async getConversationProjection() { if (fail) throw new Error("offline"); return projection(); },
    async listMessageHistory() { return []; },
    async syncAndAcknowledge({ afterCursor, onIncrementalPage }) { syncs++; return onIncrementalPage({ page: { fromCursor: afterCursor, toCursor: afterCursor, events: [] }, acknowledge: async () => { acks++; } }); },
  };
  const service = f.create(client);
  await service.realtime.notifyAvailable(); assert.equal(syncs, 0);
  assert.equal(f.store.db.get("SELECT COUNT(*) AS n FROM conversation_hydration").n, 1);
  fail = false; await service.realtime.notifyAvailable(); assert.equal(acks, 1);
  assert.equal(f.store.db.get("SELECT COUNT(*) AS n FROM conversation_hydration").n, 0);
});

test("same-page revoked then rejoined scope only reopens after fresh authorized get", async (t) => {
  const f = fixture(t);
  f.store.replaceProjectionFromBootstrap({ conversations: [{ id: "c", scopeId: "team:org" }] });
  f.store.hydrateAuthorizedHistory({ conversationId: "c", messages: [{ id: "old", seq: 1, bodyText: "old grant" }] });
  const events = [{ id: "revoked", cursor: 1, type: "scope.revoked", payload: { scopeType: "organization", organizationId: "org", userId: "alice" } }, joined(2)];
  let ack = false;
  await f.create({ getConversationProjection: async () => projection(), listMessageHistory: async () => [{ id: "new", seq: 3, bodyText: "fresh grant" }],
    syncAndAcknowledge: ({ onIncrementalPage }) => onIncrementalPage({ page: { fromCursor: 0, toCursor: 2, events }, acknowledge: async () => { ack = true; } }),
  }).realtime.notifyAvailable();
  assert.equal(ack, true);
  assert.equal(f.store.getMessage({ conversationId: "c", messageId: "old" }), null);
  assert.equal(f.store.getMessage({ conversationId: "c", messageId: "new" }).bodyText, "fresh grant");
});

for (const variant of ["other-conversation", "wrong-scope", "missing-self", "missing-members"]) test(`malformed get fails closed without ACK: ${variant}`, async (t) => {
  const f = fixture(t), value = projection(); let ack = false;
  if (variant === "other-conversation") value.conversation.id = "other";
  if (variant === "wrong-scope") value.conversation.scopeId = "team:another";
  if (variant === "missing-self") value.members[0].user_id = "other";
  if (variant === "missing-members") delete value.members;
  await f.create({ getConversationProjection: async () => value, listMessageHistory: async () => [], syncAndAcknowledge: ({ onIncrementalPage }) => onIncrementalPage({ page: { fromCursor: 0, toCursor: 1, events: [joined(1)] }, acknowledge: async () => { ack = true; } }) }).realtime.notifyAvailable();
  assert.equal(ack, false); assert.equal(f.store.getConversation({ conversationId: "c" }), null);
});

test("joined but already removed on server clears the checkpoint without granting access", async (t) => {
  const f = fixture(t); let ack = false;
  await f.create({ getConversationProjection: async () => { throw Object.assign(new Error("unavailable"), { code: "COLLAB_CONVERSATION_UNAVAILABLE" }); }, listMessageHistory: async () => [], syncAndAcknowledge: ({ onIncrementalPage }) => onIncrementalPage({ page: { fromCursor: 0, toCursor: 1, events: [joined(1)] }, acknowledge: async () => { ack = true; } }) }).realtime.notifyAvailable();
  assert.equal(ack, true);
  assert.equal(f.store.getConversation({ conversationId: "c" }), null);
  assert.equal(f.store.db.get("SELECT COUNT(*) AS n FROM conversation_hydration").n, 0);
});

test("stop during authorized get prevents late cache writes, history and ACK", async (t) => {
  const f = fixture(t), entered = Promise.withResolvers(), pending = Promise.withResolvers();
  let history = 0, acks = 0;
  const service = f.create({ getConversationProjection: async () => { entered.resolve(); return pending.promise; }, listMessageHistory: async () => { history++; return []; },
    syncAndAcknowledge: ({ onIncrementalPage }) => onIncrementalPage({ page: { fromCursor: 0, toCursor: 1, events: [joined(1)] }, acknowledge: async () => { acks++; } }),
  });
  const sync = service.realtime.notifyAvailable(); await entered.promise;
  service.stop(); pending.resolve(projection()); await sync;
  assert.equal(history, 0); assert.equal(acks, 0);
});
