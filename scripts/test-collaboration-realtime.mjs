import assert from "node:assert/strict";
import fs from "node:fs";
import { EventEmitter } from "node:events";

const {
  WS_TICKET_TTL_MS,
  createCollaborationWsTicketService,
} = await import("../server/src/services/collaboration/ws-ticket.js");
const {
  createRealtimeDispatcher,
  nextRealtimeRetryAt,
} = await import("../server/src/services/collaboration/realtime-dispatcher.js");
const {
  COLLABORATION_REALTIME_SCHEMA_VERSION,
  createRealtimeConnectionRegistry,
  parseRealtimeClientFrame,
} = await import("../server/src/services/collaboration/realtime-gateway.js");
const { createRealtimeNotifyLifecycle, createRealtimeNotifyListener } = await import("../server/src/services/collaboration/realtime-dispatcher.js");

const appSource = fs.readFileSync(new URL("../server/src/app.js", import.meta.url), "utf8");
const ticketSource = fs.readFileSync(new URL("../server/src/services/collaboration/ws-ticket.js", import.meta.url), "utf8");
assert.match(appSource, /config\.collaborationEnabled && config\.collaborationRealtimeEnabled && !config\.collaborationKillSwitch/,
  "the collaboration websocket upgrade handler is never bound while realtime rollout is disabled or killed");
assert.match(appSource, /activeOrganizationUserIds[\s\S]*filter\(\(memberId\) => activeOrganizationUserIds\.has\(memberId\)\)/,
  "organization conversation ephemeral frames filter every recipient through active organization membership");
assert.match(ticketSource, /async withWriteTransaction\(callback\) \{ return db\.transaction\(\)\.execute\(callback\); \}/,
  "the default Kysely ticket repository must provide the transaction boundary used by ticket issue and CAS consume");
assert.match(appSource, /startDispatcher\(\);\s+const listener = createRealtimeNotifyLifecycle/,
  "the durable outbox dispatcher starts before the optional cross-instance LISTEN bridge");
assert.doesNotMatch(appSource, /onReady:\s*startDispatcher/,
  "a first LISTEN connection failure must not delay local outbox delivery");

const now = new Date("2026-08-29T00:00:00.000Z");
const tickets = new Map();
const ticketRepository = {
  async issueWsTicket(_trx, record) { tickets.set(record.tokenHash, { ...record, consumed: false }); return record; },
  async consumeWsTicket(_trx, tokenHash, at) {
    const ticket = tickets.get(tokenHash);
    if (!ticket || ticket.consumed || ticket.expiresAt <= at || (ticket.deviceStatus && ticket.deviceStatus !== "active")) return null;
    ticket.consumed = true;
    return { userId: ticket.userId, deviceId: ticket.deviceId };
  },
};
const ticketService = createCollaborationWsTicketService({ repository: ticketRepository, now: () => now, createToken: () => "ticket-secret" });
const issued = await ticketService.issue({ userId: "user-1", deviceId: "device-1" });
assert.equal(issued.expiresAt.getTime() - now.getTime(), WS_TICKET_TTL_MS);
assert.equal([...tickets.values()][0].tokenHash.includes("ticket-secret"), false, "only a ticket hash is stored");
assert.deepEqual(await ticketService.consume({ ticket: issued.ticket }), { userId: "user-1", deviceId: "device-1" });
await assert.rejects(() => ticketService.consume({ ticket: issued.ticket }), (error) => error?.code === "COLLAB_WS_TICKET_INVALID", "a ticket is one-time via CAS consumption");
const expired = await ticketService.issue({ userId: "user-1", deviceId: "device-1" });
tickets.get([...tickets.keys()].at(-1)).expiresAt = new Date(now.getTime() - 1);
await assert.rejects(() => ticketService.consume({ ticket: expired.ticket }), (error) => error?.code === "COLLAB_WS_TICKET_INVALID", "expired tickets never authenticate a socket");

assert.equal(nextRealtimeRetryAt(0, now).getTime(), now.getTime() + 1000);
assert.equal(nextRealtimeRetryAt(5, now).getTime(), now.getTime() + 30_000, "retry backoff is bounded");
const outbox = [{ id: 1, userId: "user-1", maxCursor: 8 }];
const delivered = [];
const dispatcher = createRealtimeDispatcher({
  repository: {
    async claimRealtimeOutbox() { return outbox.splice(0); },
    async markRealtimeOutboxDelivered(_trx, id) { delivered.push(id); },
    async rescheduleRealtimeOutbox(_trx, id, details) { delivered.push(`retry:${id}:${details.attempts}`); },
  },
  notify: async (row) => { assert.deepEqual(row, { id: 1, userId: "user-1", maxCursor: 8 }); }, now: () => now,
});
assert.deepEqual(await dispatcher.dispatchOnce({ workerId: "worker-1" }), { claimed: 1, delivered: 1, retried: 0 });
assert.deepEqual(delivered, [1]);
const failureDispatcher = createRealtimeDispatcher({
  repository: {
    async claimRealtimeOutbox() { return [{ id: 2, userId: "user-1", maxCursor: 9, attempts: 1 }]; },
    async markRealtimeOutboxDelivered() { throw new Error("must not mark delivered after notify failure"); },
    async rescheduleRealtimeOutbox(_trx, id, details) { delivered.push({ id, ...details }); },
  },
  notify: async () => { throw new Error("notify failed"); }, now: () => now,
});
assert.deepEqual(await failureDispatcher.dispatchOnce({ workerId: "worker-1" }), { claimed: 1, delivered: 0, retried: 1 });
assert.equal(delivered.at(-1).attempts, 2, "a failed hint is leased again later; durable sync is never deleted");
const staleWorkerDispatcher = createRealtimeDispatcher({
  repository: {
    async claimRealtimeOutbox() { return [{ id: 3, userId: "user-1", maxCursor: 10, attempts: 1 }]; },
    async markRealtimeOutboxDelivered() { return false; },
    async rescheduleRealtimeOutbox() { throw new Error("a stale worker may not overwrite a new lease"); },
  }, notify: async () => {}, now: () => now,
});
assert.deepEqual(await staleWorkerDispatcher.dispatchOnce({ workerId: "stale-worker" }), { claimed: 1, delivered: 0, retried: 0 }, "a worker that lost its lease cannot mark a newer lease delivered");
const staleFailureDispatcher = createRealtimeDispatcher({
  repository: {
    async claimRealtimeOutbox() { return [{ id: 4, userId: "user-1", maxCursor: 11, attempts: 1 }]; },
    async markRealtimeOutbox() { throw new Error("not reached"); },
    async rescheduleRealtimeOutbox(_trx, _id, details) { assert.equal(details.workerId, "stale-worker"); return false; },
  }, notify: async () => { throw new Error("a stale worker's hint failed"); }, now: () => now,
});
assert.deepEqual(await staleFailureDispatcher.dispatchOnce({ workerId: "stale-worker" }), { claimed: 1, delivered: 0, retried: 0 }, "a stale worker cannot reschedule a newer lease after its hint fails");

assert.equal(COLLABORATION_REALTIME_SCHEMA_VERSION, 1);
assert.deepEqual(parseRealtimeClientFrame('{"type":"typing","schemaVersion":1,"conversationId":"conv-1","ttlMs":3000}'), { type: "typing", schemaVersion: 1, conversationId: "conv-1", ttlMs: 3000 });
assert.equal(parseRealtimeClientFrame('{"type":"typing"}'), null, "missing TTL is never promoted to a valid ephemeral frame");
assert.equal(parseRealtimeClientFrame('{"type":"typing","ttlMs":0}'), null);
assert.equal(parseRealtimeClientFrame('{"type":"presence","ttlMs":-1}'), null);
assert.equal(parseRealtimeClientFrame('{"type":"typing","schemaVersion":1,"ttlMs":3000}'), null, "a supported ephemeral frame must name its conversation");
assert.equal(parseRealtimeClientFrame('{"type":"typing","schemaVersion":2,"conversationId":"conv-1","ttlMs":3000}'), null, "unknown realtime schema is rejected explicitly by the gateway");
assert.deepEqual(parseRealtimeClientFrame('{"type":"presence","schemaVersion":1,"conversationId":"conv-1","ttlMs":999999}'), { type: "presence", schemaVersion: 1, conversationId: "conv-1", ttlMs: 30_000 }, "a valid positive TTL is bounded to the server maximum");
assert.equal(parseRealtimeClientFrame('{"type":"message.created"}'), null, "sockets never accept durable write commands");
const registry = createRealtimeConnectionRegistry();
const first = registry.add({ connectionId: "one", userId: "user-1", deviceId: "device-1" });
const second = registry.add({ connectionId: "two", userId: "user-1", deviceId: "device-1" });
assert.equal(first.replacedConnectionId, null);
assert.equal(second.replacedConnectionId, "one", "a reconnect replaces only the stale connection on that device");
assert.deepEqual(registry.syncAvailable("user-1", 9), [{ connectionId: "two", frame: { type: "sync.available", schemaVersion: 1, cursor: 9 } }]);
registry.add({ connectionId: "three", userId: "user-2", deviceId: "device-2" });
assert.deepEqual(registry.ephemeralRecipients({ originConnectionId: "two", recipientUserIds: ["user-1", "user-2"] }).map(({ connectionId }) => connectionId), ["three"], "typing/presence only targets other authorized conversation members");

const listenerClient = new EventEmitter();
listenerClient.queries = [];
listenerClient.query = async (query) => listenerClient.queries.push(query);
const receivedHints = [];
const listener = createRealtimeNotifyListener({ client: listenerClient, onHint: (hint) => receivedHints.push(hint) });
await listener.start();
listenerClient.emit("notification", { channel: "collaboration_sync_available", payload: '{"userId":"user-1","cursor":11}' });
listenerClient.emit("notification", { channel: "collaboration_sync_available", payload: '{"userId":"","cursor":0}' });
assert.deepEqual(receivedHints, [{ userId: "user-1", cursor: 11 }]);
await listener.stop();
const lifecycleClient = new EventEmitter();
lifecycleClient.connectCalls = 0;
lifecycleClient.endCalls = 0;
lifecycleClient.query = async () => {};
lifecycleClient.connect = async () => { lifecycleClient.connectCalls += 1; };
lifecycleClient.end = async () => { lifecycleClient.endCalls += 1; };
const lifecycle = createRealtimeNotifyLifecycle({ createClient: () => lifecycleClient, onHint: () => {} });
await lifecycle.start();
await lifecycle.stop();
assert.deepEqual({ connect: lifecycleClient.connectCalls, end: lifecycleClient.endCalls }, { connect: 1, end: 1 }, "LISTEN lifecycle connects before querying and closes its dedicated client");
const reconnectClients = [new EventEmitter(), new EventEmitter()];
for (const client of reconnectClients) {
  client.query = async () => {};
  client.connect = async () => { client.connected = (client.connected || 0) + 1; };
  client.end = async () => { client.ended = (client.ended || 0) + 1; };
}
let scheduledReconnect = null;
let readyCount = 0;
const firstReconnectClient = reconnectClients[0];
const reconnectingLifecycle = createRealtimeNotifyLifecycle({
  createClient: () => reconnectClients.shift(), onHint: () => {}, onReady: () => { readyCount += 1; },
  schedule: (callback) => { scheduledReconnect = callback; return 1; }, cancel: () => {},
});
await reconnectingLifecycle.start();
firstReconnectClient.emit("end");
await new Promise((resolve) => setImmediate(resolve));
assert.equal(typeof scheduledReconnect, "function", "a dropped LISTEN connection schedules a bounded reconnect");
await scheduledReconnect();
assert.equal(readyCount, 2, "dispatcher readiness is restored only after the replacement LISTEN client is ready");
await reconnectingLifecycle.stop();

console.log("collaboration realtime: ok");
