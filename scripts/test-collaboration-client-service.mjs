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
await resyncClient.syncAndAcknowledge({ deviceId: "device-1", afterCursor: 1, syncEngine: bootstrapEngine });
assert.deepEqual(resyncOrdering, ["/api/collaboration/v1/sync", "/api/collaboration/v1/bootstrap", "bootstrap-commit:7", "/api/collaboration/v1/ack"], "full resync ACK follows only a committed bootstrap projection and uses the server completion token");

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
