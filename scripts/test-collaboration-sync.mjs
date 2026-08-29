import assert from "node:assert/strict";
import fs from "node:fs";

const {
  DEFAULT_SYNC_LIMIT,
  MAX_SYNC_LIMIT,
  STALE_DEVICE_AFTER_MS,
  applyDurableSyncPage,
  boundBootstrapHistory,
  buildBootstrapSnapshot,
  computeCompactionWatermark,
  createCollaborationSyncService,
  normalizeSyncLimit,
  paginateSyncEvents,
} = await import("../server/src/services/collaboration/sync-service.js");

const syncServiceSource = fs.readFileSync(new URL("../server/src/services/collaboration/sync-service.js", import.meta.url), "utf8");
const bootstrapMigration = fs.readFileSync(new URL("../server/migrations/035_collaboration_bootstrap_completion.sql", import.meta.url), "utf8");
assert.match(
  syncServiceSource,
  /insertInto\("user_sync_state"\)\.values\(\{ user_id: userId, next_cursor: 1 \}\)/,
  "compaction must materialize a valid next_cursor even on schemas without a database default",
);
assert.match(bootstrapMigration, /create table if not exists collaboration_bootstrap_completions/i);
assert.match(bootstrapMigration, /token_hash text primary key/i);
assert.match(bootstrapMigration, /foreign key \(user_id, device_id\) references user_devices\(user_id, device_id\)/i);
assert.match(syncServiceSource, /row_number\(\) over \(partition by message\.conversation_id order by message\.create_seq desc\)/i,
  "controlled bootstrap history must reserve its cap per conversation, not let one busy conversation starve another");
assert.match(syncServiceSource, /member\.user_id.*member\.status.*message\.create_seq.*member\.joined_seq/is,
  "bootstrap history must be authorized by the current active membership and joined sequence");
assert.match(syncServiceSource, /orderBy\("history_rank", "asc"\)\.orderBy\("conversation_id", "asc"\)/,
  "the global bootstrap history cap must round-robin newest messages across conversations before taking deeper history");

assert.equal(DEFAULT_SYNC_LIMIT, 500);
assert.equal(MAX_SYNC_LIMIT, 2000);
assert.equal(normalizeSyncLimit(), 500);
assert.equal(normalizeSyncLimit(1), 1);
assert.equal(normalizeSyncLimit(9999), 2000);
assert.throws(() => normalizeSyncLimit(0), /positive integer/i);
assert.throws(() => normalizeSyncLimit("17"), /positive integer/i);

const event = (cursor, id, type = "message.created", payload = { messageId: id }) => ({
  cursor,
  id,
  type,
  conversationId: "conv-1",
  payload,
});

const events = [event(11, "evt-11"), event(12, "evt-12"), event(13, "evt-13")];
const bounded = paginateSyncEvents(events, { afterCursor: 10, limit: 2, maxPayloadBytes: 2048 });
assert.deepEqual(bounded.events.map(({ cursor }) => cursor), [11, 12]);
assert.equal(bounded.toCursor, 12);
assert.equal(bounded.hasMore, true);
assert.throws(
  () => paginateSyncEvents([event(11, "evt-huge", "message.created", { text: "x".repeat(1024) })], { afterCursor: 10, limit: 5, maxPayloadBytes: 32 }),
  (error) => error?.code === "COLLAB_SYNC_EVENT_TOO_LARGE",
  "an oversized durable event must fail loudly instead of being silently skipped",
);
assert.throws(
  () => paginateSyncEvents([event(11, "evt-11"), event(13, "evt-13")], { afterCursor: 10 }),
  (error) => error?.code === "COLLAB_SYNC_PAGE_INVALID",
  "the server must never turn a cursor gap into a seemingly successful page",
);

let applied = [];
const firstPage = applyDurableSyncPage({ cursor: 10, appliedEventIds: [] }, {
  status: "OK", fromCursor: 10, toCursor: 12,
  events: [event(11, "evt-known"), event(12, "evt-future", "future.v2")],
}, (row) => applied.push(row.id));
assert.deepEqual(applied, ["evt-known"], "known durable events are applied");
assert.equal(firstPage.cursor, 12, "an unknown durable event must still advance the cursor");
assert.deepEqual(firstPage.ignoredEventIds, ["evt-future"]);
const replay = applyDurableSyncPage(firstPage, {
  status: "OK", fromCursor: 12, toCursor: 13,
  events: [event(13, "evt-known")],
}, (row) => applied.push(row.id));
assert.equal(replay.cursor, 13);
assert.deepEqual(applied, ["evt-known"], "replayed durable event ids cannot duplicate local projection");
assert.throws(
  () => applyDurableSyncPage({ cursor: 10 }, { status: "OK", fromCursor: 9, toCursor: 10, events: [event(10, "evt-old")] }),
  (error) => error?.code === "COLLAB_SYNC_PAGE_INVALID",
  "a page for a different local cursor must be rejected",
);
assert.throws(
  () => applyDurableSyncPage({ cursor: 10 }, { status: "OK", fromCursor: 10, toCursor: 13, events: [event(11, "evt-11"), event(13, "evt-13")] }),
  (error) => error?.code === "COLLAB_SYNC_PAGE_INVALID",
  "the client must reject a gap before advancing its durable cursor",
);

const snapshot = buildBootstrapSnapshot({
  profile: { user_id: "user-1", lily_id: "alice" },
  relationships: [{ userId: "user-2" }], teams: [{ id: "team-1" }],
  conversations: [{ id: "conv-1" }], watermark: 18,
});
assert.equal(snapshot.watermark, 18);
assert.equal(snapshot.fromCursor, 18, "bootstrap returns the snapshot watermark, not wall-clock time");
assert.deepEqual(snapshot.profile, {
  userId: "user-1", lilyId: "alice", displayName: "", avatarObjectId: null, discoverability: null,
});
const boundedHistory = boundBootstrapHistory([
  { id: "history-1", conversation_id: "conv-1", body: "x".repeat(30) },
  { id: "history-2", conversation_id: "conv-2", body: "x".repeat(30) },
], { conversationIds: ["conv-1", "conv-2", "conv-3"], totalLimit: 2, maxBytes: 130 });
assert.equal(boundedHistory.history.length, 1, "a bootstrap history byte budget caps the global response even below its item limit");
assert.equal(boundedHistory.hydration.truncated, true);
assert.deepEqual(boundedHistory.hydration.omittedConversationIds, ["conv-2", "conv-3"], "omitted histories are explicit so they can be recovered through authorized paging");
assert.equal(boundedHistory.hydration.historyComplete, false, "bootstrap hydration is never represented as a complete archive");
assert.deepEqual(boundedHistory.hydration.continuationRequiredConversationIds, ["conv-1", "conv-2", "conv-3"], "every conversation remains eligible for authorized history continuation");

const now = new Date("2026-08-29T00:00:00.000Z");
const staleAt = new Date(now.getTime() - STALE_DEVICE_AFTER_MS - 1).toISOString();
const activeAt = new Date(now.getTime() - 60_000).toISOString();
const compaction = computeCompactionWatermark({
  deviceStates: [
    { device_id: "slow-active", last_acked_cursor: 7, last_seen_at: activeAt, requires_full_resync: false },
    { device_id: "fast-active", last_acked_cursor: 19, last_seen_at: activeAt, requires_full_resync: false },
    { device_id: "stale", last_acked_cursor: 2, last_seen_at: staleAt, requires_full_resync: false },
    { device_id: "revoked", status: "revoked", last_acked_cursor: 0, last_seen_at: activeAt, requires_full_resync: false },
  ],
  retentionFloorCursor: 15,
  now,
});
assert.equal(compaction.compactedBeforeCursor, 7, "the slow active device remains eligible for incrementals");
assert.deepEqual(compaction.staleDeviceIds, ["stale"]);
const unacknowledgedDeviceCompaction = computeCompactionWatermark({
  deviceStates: [
    { device_id: "fast", status: "active", last_acked_cursor: 19, last_seen_at: activeAt, requires_full_resync: false },
    { device_id: "new-device", status: "active", last_acked_cursor: null, last_seen_at: activeAt, requires_full_resync: false },
  ], retentionFloorCursor: 15, now,
});
assert.equal(unacknowledgedDeviceCompaction.compactedBeforeCursor, 0, "a newly bound, unacknowledged active device blocks compaction until bootstrap completes");

const state = {
  syncState: { compacted_before_cursor: 6, next_cursor: 20 },
  device: { user_id: "user-1", device_id: "device-1", sync_device_id: "device-1", status: "active", last_acked_cursor: 4, requires_full_resync: false },
  events,
  bootstrap: {
    profile: { user_id: "user-1", lily_id: "alice" },
    relationships: [], teams: [], conversations: [{ id: "conv-1" }],
  },
  bootstrapCompletions: new Map(),
};
const repository = {
  async withReadSnapshot(callback) { return callback(this); },
  async getSyncState() { return state.syncState; },
  async getDeviceState(_trx, userId, deviceId) {
    return state.device.user_id === userId && state.device.device_id === deviceId ? state.device : null;
  },
  async listSyncEvents(_trx, _userId, afterCursor) { return state.events.filter((row) => row.cursor > afterCursor); },
  async getBootstrapProfile() { return state.bootstrap.profile; },
  async listBootstrapRelationships() { return state.bootstrap.relationships; },
  async listBootstrapTeams() { return state.bootstrap.teams; },
  async listBootstrapConversations() { return state.bootstrap.conversations; },
  async listBootstrapConversationMembers() { return [{ conversation_id: "conv-1", user_id: "user-1", role: "owner", status: "active" }]; },
  async listBootstrapProfiles() { return [{ user_id: "user-1", lily_id: "alice", display_name: "Alice" }]; },
  async listBootstrapHistory() { return [{ id: "message-1", conversation_id: "conv-1", create_seq: 1 }]; },
  async issueBootstrapCompletion(_trx, completion) {
    state.bootstrapCompletions.set(completion.tokenHash, { ...completion, consumed: false });
    return { watermark: completion.watermark };
  },
  async consumeBootstrapCompletion(_trx, completion) {
    const issued = state.bootstrapCompletions.get(completion.tokenHash);
    if (!issued || issued.consumed || issued.userId !== completion.userId || issued.deviceId !== completion.deviceId || issued.watermark !== completion.watermark) return null;
    issued.consumed = true;
    return { watermark: issued.watermark };
  },
  async acknowledgeDeviceCursor(_trx, { userId, deviceId, cursor, completeFullResync }) {
    assert.equal(userId, "user-1");
    assert.equal(deviceId, "device-1");
    state.device.last_acked_cursor = Math.max(state.device.last_acked_cursor, cursor);
    if (completeFullResync) state.device.requires_full_resync = false;
    return { ...state.device };
  },
  async listDeviceStates() {
    return [
      { user_id: "user-1", device_id: "slow-active", status: "active", last_acked_cursor: 7, last_seen_at: activeAt, requires_full_resync: false },
      { user_id: "user-1", device_id: "stale", status: "active", last_acked_cursor: 2, last_seen_at: staleAt, requires_full_resync: false },
      { user_id: "user-1", device_id: "revoked", status: "revoked", last_acked_cursor: 0, last_seen_at: activeAt, requires_full_resync: false },
    ];
  },
  async markDevicesRequireFullResync(_trx, _userId, deviceIds) {
    state.markedStaleDevices = deviceIds;
  },
  async advanceCompactedBeforeCursor(_trx, _userId, cursor) {
    state.syncState.compacted_before_cursor = Math.max(state.syncState.compacted_before_cursor, cursor);
    return state.syncState;
  },
};
const service = createCollaborationSyncService({ repository, now: () => now, maxPayloadBytes: 2048, createBootstrapToken: () => "issued-bootstrap-token" });
const incremental = await service.syncAfterCursor({ userId: "user-1", deviceId: "device-1", afterCursor: 10, limit: 2 });
assert.deepEqual(incremental.events.map(({ cursor }) => cursor), [11, 12]);
assert.deepEqual({ from: incremental.fromCursor, to: incremental.toCursor, watermark: incremental.watermark, hasMore: incremental.hasMore }, { from: 10, to: 12, watermark: 19, hasMore: true });
const resync = await service.syncAfterCursor({ userId: "user-1", deviceId: "device-1", afterCursor: 5 });
assert.deepEqual(resync, { status: "FULL_RESYNC_REQUIRED", code: "FULL_RESYNC_REQUIRED", fromCursor: 5, compactedBeforeCursor: 6, watermark: 19 }, "a compacted cursor cannot look like a successful empty page");

state.events = [event(11, "evt-11"), event(13, "evt-13")];
await assert.rejects(
  () => service.syncAfterCursor({ userId: "user-1", deviceId: "device-1", afterCursor: 10 }),
  (error) => error?.code === "COLLAB_SYNC_PAGE_INVALID",
  "a database cursor hole must fail loudly rather than lose event 12",
);
state.events = events;

const firstAck = await service.ackDeviceCursor({ userId: "user-1", deviceId: "device-1", cursor: 14 });
assert.equal(firstAck.lastAckedCursor, 14);
const oldAck = await service.ackDeviceCursor({ userId: "user-1", deviceId: "device-1", cursor: 9 });
assert.equal(oldAck.lastAckedCursor, 14, "an old device ACK cannot move the durable cursor backwards");

state.device.requires_full_resync = true;
await assert.rejects(
  () => service.ackDeviceCursor({ userId: "user-1", deviceId: "device-1", cursor: 19 }),
  (error) => error?.code === "FULL_RESYNC_REQUIRED",
  "a stale device must bootstrap before it can acknowledge again",
);
await assert.rejects(
  () => service.ackDeviceCursor({ userId: "user-1", deviceId: "device-1", cursor: 19, fullResync: true }),
  (error) => error?.code === "FULL_RESYNC_REQUIRED",
  "a client-provided fullResync boolean cannot clear the server resync flag",
);
const fullBootstrap = await service.bootstrapCollaboration({ userId: "user-1", deviceId: "device-1" });
assert.equal(fullBootstrap.watermark, 19);
assert.deepEqual(fullBootstrap.members, [{ conversation_id: "conv-1", user_id: "user-1", role: "owner", status: "active" }]);
assert.deepEqual(fullBootstrap.profiles, [{ user_id: "user-1", lily_id: "alice", display_name: "Alice" }]);
assert.deepEqual(fullBootstrap.history, [{ id: "message-1", conversation_id: "conv-1", create_seq: 1 }], "full bootstrap contains controlled history hydration for a compacted local store");
const repairedAck = await service.ackDeviceCursor({ userId: "user-1", deviceId: "device-1", cursor: 19, bootstrapCompletionToken: fullBootstrap.bootstrapCompletionToken });
assert.deepEqual(repairedAck, { lastAckedCursor: 19, requiresFullResync: false }, "the post-bootstrap ACK clears only this device's resync flag");
state.device.requires_full_resync = true;
await assert.rejects(
  () => service.ackDeviceCursor({ userId: "user-1", deviceId: "device-1", cursor: 19, bootstrapCompletionToken: fullBootstrap.bootstrapCompletionToken }),
  (error) => error?.code === "COLLAB_BOOTSTRAP_COMPLETION_INVALID",
  "a bootstrap completion token is single-use and cannot be replayed",
);
state.device.requires_full_resync = false;

state.device.status = "revoked";
await assert.rejects(
  () => service.syncAfterCursor({ userId: "user-1", deviceId: "device-1", afterCursor: 19 }),
  (error) => error?.code === "COLLAB_DEVICE_REVOKED",
  "a revoked device cannot read sync pages",
);
await assert.rejects(
  () => service.ackDeviceCursor({ userId: "user-1", deviceId: "device-1", cursor: 19 }),
  (error) => error?.code === "COLLAB_DEVICE_REVOKED",
  "a revoked device cannot advance a durable ACK",
);
state.device.status = "active";

const compacted = await service.compactUserSync({ userId: "user-1", retentionFloorCursor: 15 });
assert.deepEqual(compacted.staleDeviceIds, ["stale"], "a device unseen for 30 days is marked for full resync");
assert.deepEqual(state.markedStaleDevices, ["stale"]);
assert.equal(compacted.compactedBeforeCursor, 7, "compaction cannot pass the slow active device ACK");
assert.equal(state.syncState.compacted_before_cursor, 7);

console.log("collaboration sync: ok");
