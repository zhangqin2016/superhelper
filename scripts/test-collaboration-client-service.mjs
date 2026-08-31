#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createCollaborationClient } = require("../src/main/collaboration/client.js");
const { createCollaborationRealtimeClient } = require("../src/main/collaboration/realtime-client.js");
const { createCollaborationService } = require("../src/main/collaboration/service.js");

const seen = [];
let tokenCalls = 0;
const client = createCollaborationClient({
  accountManager: {
    async accessTokenForService() {
      tokenCalls += 1;
      return { ok: true, accessToken: tokenCalls === 1 ? "short-lived-a" : "short-lived-b" };
    },
  },
  signDeviceRequest: async () => ({ "x-lily-device-id": "device-1", "x-lily-device-signature": "signature" }),
  request: async ({ headers }) => {
    seen.push(headers);
    return seen.length === 1 ? { status: 401, ok: false } : { status: 200, ok: true, json: { status: "OK", fromCursor: 0, toCursor: 0, events: [] } };
  },
});
const response = await client.syncAfterCursor({ deviceId: "device-1", afterCursor: 0 });
assert.deepEqual(response, { status: "OK", fromCursor: 0, toCursor: 0, events: [] });
assert.equal(tokenCalls, 2, "a 401 obtains exactly one refreshed token and retries once");
assert.equal(seen[0].authorization, "Bearer short-lived-a");
assert.equal(seen[1].authorization, "Bearer short-lived-b");
assert.equal(Object.values(response).includes("short-lived-b"), false, "client responses never expose an access token to renderer consumers");

let historyRequest = null;
const historyClient = createCollaborationClient({
  accountManager: { async accessTokenForService() { return { ok: true, accessToken: "main-only" }; } }, signDeviceRequest: async () => ({}),
  request: async (request) => { historyRequest = request; return { ok: true, status: 200, json: { ok: true, result: { messages: [{ id: "m1", bodyText: "authorized plaintext" }] } } }; },
});
assert.deepEqual(await historyClient.listMessageHistory({ deviceId: "device-1", conversationId: "c1", limit: 20 }), { messages: [{ id: "m1", bodyText: "authorized plaintext" }] });
assert.equal(historyRequest.path, "/api/collaboration/v1/messages");
assert.equal(historyRequest.body.action, "history");
assert.equal(historyRequest.body.bodyCiphertext, undefined, "history requests use the server-authorized decrypted view, never client ciphertext/key material");

let receiptRequest = null;
const receiptClient = createCollaborationClient({
  accountManager: { async accessTokenForService() { return { ok: true, accessToken: "main-only" }; } }, signDeviceRequest: async () => ({}),
  request: async (request) => { receiptRequest = request; return { ok: true, status: 200, json: { ok: true, state: "completed", committed: true } }; },
});
assert.deepEqual(await receiptClient.lookupCommandReceipt({ deviceId: "device-1", conversationId: "client-untrusted-c1", clientCommandId: "cmd-1" }), { ok: true, state: "completed", committed: true });
assert.deepEqual(receiptRequest.body, { deviceId: "device-1", clientCommandId: "cmd-1", commandType: "message.create", expectedConversationId: "client-untrusted-c1" }, "expected conversation is checked for equality; the server still derives authorization scope from the immutable receipt event");

const ordering = [];
const syncClient = createCollaborationClient({
  accountManager: { async accessTokenForService() { return { ok: true, accessToken: "only-main-process" }; } },
  signDeviceRequest: async () => ({}),
  request: async ({ path }) => {
    ordering.push(path);
    if (path.endsWith("/sync")) return { ok: true, status: 200, json: { status: "OK", fromCursor: 0, toCursor: 0, events: [] } };
    return { ok: true, status: 200, json: { ok: true } };
  },
});
const syncEngine = { applyPage(page) { ordering.push(`commit:${page.toCursor}`); return { cursor: page.toCursor }; } };
await syncClient.syncAndAcknowledge({ deviceId: "device-1", afterCursor: 0, syncEngine });
assert.deepEqual(ordering, ["/api/collaboration/v1/sync", "commit:0", "/api/collaboration/v1/ack"], "ACK only occurs after the local page transaction commits");

const resyncOrdering = [];
const resyncClient = createCollaborationClient({
  accountManager: { async accessTokenForService() { return { ok: true, accessToken: "only-main-process" }; } },
  signDeviceRequest: async () => ({}),
  request: async ({ path, body }) => {
    resyncOrdering.push(path);
    if (path.endsWith("/sync")) return { ok: true, status: 200, json: { status: "FULL_RESYNC_REQUIRED" } };
    if (path.endsWith("/bootstrap")) return { ok: true, status: 200, json: { watermark: 7, bootstrapCompletionToken: "server-issued-completion" } };
    assert.deepEqual(body, { deviceId: "device-1", cursor: 7, bootstrapCompletionToken: "server-issued-completion", clientCommandId: "ack:device-1:7:bootstrap" });
    return { ok: true, status: 200, json: { ok: true } };
  },
});
const bootstrapEngine = { applyBootstrap(snapshot) { resyncOrdering.push(`bootstrap-commit:${snapshot.watermark}`); return { cursor: snapshot.watermark }; } };
const rawResync = await resyncClient.syncAndAcknowledge({ deviceId: "device-1", afterCursor: 1, syncEngine: bootstrapEngine });
assert.equal(rawResync.requiresHydration, true, "a direct client receives a snapshot requiring service-owned hydration");
assert.deepEqual(resyncOrdering, ["/api/collaboration/v1/sync", "/api/collaboration/v1/bootstrap"], "a bare client never consumes a full-resync ACK token before the service hydrates authorized history");

// The client deliberately delegates FULL_RESYNC completion to the service:
// raw bootstrap history is ciphertext and must not be ACKed before that
// service has fetched and stored the authorized plaintext projection.
const serviceResyncOrder = [];
const serviceResyncClient = createCollaborationClient({
  accountManager: { async accessTokenForService() { return { ok: true, accessToken: "only-main-process" }; } },
  signDeviceRequest: async () => ({}),
  request: async ({ path, body }) => {
    serviceResyncOrder.push(path);
    if (path.endsWith("/sync")) return { ok: true, status: 200, json: { status: "FULL_RESYNC_REQUIRED" } };
    if (path.endsWith("/bootstrap")) return { ok: true, status: 200, json: { watermark: 8, bootstrapCompletionToken: "completion-8", conversations: [{ id: "c-history" }], history: [{ body_ciphertext: "never-project-this" }] } };
    if (path.endsWith("/messages")) return { ok: true, status: 200, json: { ok: true, result: { messages: [{ id: "m-history", bodyText: "authorized only" }] } } };
    assert.deepEqual(body, { deviceId: "device-1", cursor: 8, bootstrapCompletionToken: "completion-8", clientCommandId: "ack:device-1:8:bootstrap" });
    return { ok: true, status: 200, json: { ok: true } };
  },
});
const serviceResyncStore = {
  getSyncState() { return { cursor: 2, watermark: 2 }; },
  applySyncPage() { throw new Error("incremental projection is not expected during full resync"); },
  replaceProjectionFromBootstrap(snapshot) {
    serviceResyncOrder.push(`apply:${JSON.stringify(snapshot.history)}`);
    assert.deepEqual(snapshot.history, [], "raw encrypted bootstrap history is not placed in the desktop projection");
    return { cursor: snapshot.watermark };
  },
  hydrateAuthorizedHistory({ messages }) { serviceResyncOrder.push(`hydrate:${messages[0]?.bodyText}`); },
  close() {},
};
const serviceResync = createCollaborationService({ openStore: () => ({ ok: true, store: serviceResyncStore }), client: serviceResyncClient, deviceId: "device-1" });
await serviceResync.realtime.notifyAvailable();
assert.deepEqual(serviceResyncOrder, ["/api/collaboration/v1/sync", "/api/collaboration/v1/bootstrap", "apply:[]", "/api/collaboration/v1/messages", "hydrate:authorized only", "/api/collaboration/v1/ack"], "FULL_RESYNC ACK follows durable bootstrap plus authorized plaintext history hydration");
serviceResync.stop();

const pageHydrationOrder = [];
const pageHydrationClient = createCollaborationClient({
  accountManager: { async accessTokenForService() { return { ok: true, accessToken: "only-main-process" }; } }, signDeviceRequest: async () => ({}),
  request: async ({ path, body }) => {
    pageHydrationOrder.push(path);
    if (path.endsWith("/sync")) return { ok: true, status: 200, json: { status: "OK", fromCursor: 4, toCursor: 5, events: [{ id: "evt-page", cursor: 5, type: "message.created", conversationId: "c-page" }] } };
    if (path.endsWith("/messages")) return { ok: true, status: 200, json: { ok: true, result: { messages: [{ id: "m-page", bodyText: "incremental plaintext" }] } } };
    assert.equal(body.cursor, 5);
    return { ok: true, status: 200, json: { ok: true } };
  },
});
const pageHydrationStore = {
  getSyncState() { return { cursor: 4, watermark: 4 }; },
  applySyncPage({ events }) { pageHydrationOrder.push(`apply:${events[0].id}`); return { cursor: 5 }; },
  replaceProjectionFromBootstrap() { throw new Error("bootstrap is not expected for an incremental page"); },
  hydrateAuthorizedHistory({ messages }) { pageHydrationOrder.push(`hydrate:${messages[0]?.bodyText}`); },
  close() {},
};
const pageHydrationService = createCollaborationService({ openStore: () => ({ ok: true, store: pageHydrationStore }), client: pageHydrationClient, deviceId: "device-1" });
await pageHydrationService.realtime.notifyAvailable();
assert.deepEqual(pageHydrationOrder, ["/api/collaboration/v1/sync", "apply:evt-page", "/api/collaboration/v1/messages", "hydrate:incremental plaintext", "/api/collaboration/v1/ack"], "incremental ACK follows durable page application and authorized history hydration");
pageHydrationService.stop();

const scheduled = [];
const cleared = [];
const wakeListeners = [];
const focusListeners = [];
let syncCount = 0;
const socket = { sent: [], send(value) { this.sent.push(value); }, close() {} };
const realtime = createCollaborationRealtimeClient({
  sync: async () => { syncCount += 1; },
  createSocket: () => socket,
  setIntervalFn: (fn, delay) => { scheduled.push({ fn, delay }); return scheduled.length; },
  clearIntervalFn: (id) => cleared.push(id),
  onWake: (fn) => wakeListeners.push(fn),
  onFocus: (fn) => focusListeners.push(fn),
});
realtime.start();
assert.deepEqual(scheduled.map((entry) => entry.delay).sort((a, b) => a - b), [15_000, 30_000], "foreground polling is 15s and websocket heartbeat is 30s");
await wakeListeners[0](); await focusListeners[0]();
assert.equal(syncCount, 2, "wake and focus immediately reconcile durable cursors");
realtime.setBackground(true);
assert.ok(scheduled.some((entry) => entry.delay === 60_000), "background polling backs off to 60s");
realtime.stop();
assert.ok(cleared.length >= 2, "stop cleans timers without affecting other app services");

const socketHandlers = {};
const reconnectTimers = [];
let hintSyncs = 0;
const reconnecting = createCollaborationRealtimeClient({
  sync: async () => { hintSyncs += 1; },
  createSocket: () => ({ on(event, handler) { socketHandlers[event] = handler; }, send() {}, close() {} }),
  setIntervalFn: () => 1, clearIntervalFn() {},
  setTimeoutFn: (fn, delay) => { reconnectTimers.push({ fn, delay }); return reconnectTimers.length; }, clearTimeoutFn() {}, random: () => 0.5,
});
reconnecting.start();
await socketHandlers.message(JSON.stringify({ type: "sync.available", schemaVersion: 1 }));
assert.equal(hintSyncs, 1, "a realtime sync.available hint triggers durable cursor sync");
socketHandlers.close();
assert.ok(reconnectTimers.length === 1 && reconnectTimers[0].delay > 0 && reconnectTimers[0].delay <= 30_000, "socket close reconnects with bounded jitter no greater than 30 seconds");
reconnecting.stop();

const unavailable = createCollaborationService({ openStore: () => ({ ok: false, code: "COLLABORATION_UNAVAILABLE" }) });
assert.deepEqual(unavailable, { ok: false, code: "COLLABORATION_UNAVAILABLE" }, "cache startup failure remains scoped to collaboration");
let cursorReads = 0;
let syncArgs = null;
const liveStore = { getSyncState() { cursorReads += 1; return { cursor: 42 }; }, applySyncPage() {}, close() {} };
const service = createCollaborationService({
  openStore: () => ({ ok: true, store: liveStore }),
  client: { async syncAndAcknowledge(args) { syncArgs = args; } },
});
await service.realtime.notifyAvailable();
assert.equal(cursorReads, 1, "service reads the latest durable local cursor for every realtime-triggered sync");
assert.equal(syncArgs.afterCursor, 42);

let httpOnlySyncs = 0;
const httpOnlyStore = { getSyncState() { return { cursor: 9, watermark: 9 }; }, applySyncPage() {}, close() {} };
const httpOnlyService = createCollaborationService({
  openStore: () => ({ ok: true, store: httpOnlyStore }), realtimeEnabled: false,
  client: { async syncAndAcknowledge() { httpOnlySyncs += 1; } },
});
assert.equal(httpOnlyService.realtime, null, "signed realtime:false creates no websocket client");
httpOnlyService.start();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(httpOnlySyncs, 1, "realtime:false retains the initial durable HTTP cursor sync");
httpOnlyService.stop();

const recoveryOrder = [];
const recoveryStore = {
  getSyncState() { return { cursor: 6, watermark: 6 }; },
  listPendingHistoryHydration() { return ["c-crash"]; },
  hydrateAuthorizedHistory() { recoveryOrder.push("hydrate"); },
  applySyncPage() { recoveryOrder.push("apply"); return { cursor: 6 }; },
  close() {},
};
const recoveryService = createCollaborationService({
  openStore: () => ({ ok: true, store: recoveryStore }), realtimeEnabled: false, deviceId: "device-1",
  client: {
    async listMessageHistory() { recoveryOrder.push("history"); return { messages: [] }; },
    async syncAndAcknowledge({ onIncrementalPage }) {
      recoveryOrder.push("sync");
      return onIncrementalPage({ page: { fromCursor: 6, toCursor: 6, events: [] }, acknowledge: async () => { recoveryOrder.push("ack"); } });
    },
  },
});
recoveryService.start();
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(recoveryOrder, ["history", "hydrate", "sync", "apply", "ack"], "startup completes a crash-surviving hydration checkpoint before the next cursor ACK");
recoveryService.stop();

let retryPending = true;
const retryRecoveryOrder = [];
const retryRecoveryStore = {
  getSyncState() { return { cursor: 11, watermark: 11 }; },
  listPendingHistoryHydration() { return retryPending ? ["c-retry"] : []; },
  hydrateAuthorizedHistory() { retryPending = false; retryRecoveryOrder.push("hydrate"); },
  applySyncPage() { retryRecoveryOrder.push("apply"); return { cursor: 11 }; },
  close() {},
};
const retryRecoveryService = createCollaborationService({
  openStore: () => ({ ok: true, store: retryRecoveryStore }), deviceId: "device-1",
  client: {
    async listMessageHistory() {
      retryRecoveryOrder.push("history");
      if (retryRecoveryOrder.filter((value) => value === "history").length === 1) throw new Error("temporary history failure");
      return { messages: [] };
    },
    async syncAndAcknowledge({ onIncrementalPage }) {
      retryRecoveryOrder.push("sync");
      return onIncrementalPage({ page: { fromCursor: 11, toCursor: 11, events: [] }, acknowledge: async () => { retryRecoveryOrder.push("ack"); } });
    },
  },
});
retryRecoveryService.start();
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(retryRecoveryOrder, ["history"], "a failed pending-history recovery aborts the entire sync/ACK attempt");
await retryRecoveryService.realtime.notifyAvailable();
assert.deepEqual(retryRecoveryOrder, ["history", "history", "hydrate", "sync", "apply", "ack"], "the next serialized trigger repairs pending history before any later page ACK");
retryRecoveryService.stop();

let drainCalls = 0;
const reconnectHandlers = {};
const drainStore = {
  getSyncState() { return { cursor: 0 }; }, applySyncPage() {}, close() {},
  listOutbox() { drainCalls += 1; return []; }, getOutbox() { return null; }, setOutboxState() { return false; },
};
const drainingService = createCollaborationService({
  openStore: () => ({ ok: true, store: drainStore }),
  client: { async syncAndAcknowledge() {} }, transport: { async submit() {} },
  realtimeOptions: {
    createSocket: () => ({ on(event, handler) { reconnectHandlers[event] = handler; }, send() {}, close() {} }),
    setIntervalFn: () => 1, clearIntervalFn() {}, setTimeoutFn: () => 1, clearTimeoutFn() {},
  },
});
drainingService.start();
await Promise.resolve();
assert.equal(drainCalls, 1, "service startup drains durable queued outbox work");
reconnectHandlers.open();
await Promise.resolve();
assert.equal(drainCalls, 2, "realtime reconnect drains queued durable outbox work again");
drainingService.stop();
console.log("collaboration client/service: ok");
