#!/usr/bin/env node

import assert from "node:assert/strict";

const {
  createCollaborationFriendService,
  createFriendRequestRateLimiter,
} = await import("../server/src/services/collaboration/friends.js");

function commandError(code) {
  return Object.assign(new Error(code), { code });
}

function createHarness({ rateLimiter = null } = {}) {
  const state = {
    profiles: new Map([
      ["lily-a", { userId: "user-a", lilyId: "lily-a", displayName: "A", discoverability: "public" }],
      ["lily-b", { userId: "user-b", lilyId: "lily-b", displayName: "B", discoverability: "public" }],
      ["lily-hidden", { userId: "user-hidden", lilyId: "lily-hidden", displayName: "Hidden", discoverability: "hidden" }],
    ]),
    requests: [], friendships: new Map(), blocks: new Set(), directs: new Map(), receipts: new Map(), nextId: 0,
  };
  const pair = (left, right) => [left, right].sort().join(":");
  const repository = {
    async lockPair() {},
    async runCommand({ account, commandType, clientCommandId, input, mutate }) {
      const key = `${account.deviceId}:${commandType}:${clientCommandId}`;
      const prior = state.receipts.get(key);
      const fingerprint = JSON.stringify(input);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw commandError("COLLAB_COMMAND_ID_REUSED");
        return structuredClone(prior.response);
      }
      const response = await mutate({});
      state.receipts.set(key, { fingerprint, response: structuredClone(response) });
      return response;
    },
    async findProfileByLilyId(_trx, lilyId) { return structuredClone(state.profiles.get(lilyId) || null); },
    async findProfileByUserId(_trx, userId) { return structuredClone([...state.profiles.values()].find((profile) => profile.userId === userId) || null); },
    async findRequest(_trx, senderUserId, receiverUserId) {
      return structuredClone(state.requests.find((request) => request.senderUserId === senderUserId && request.receiverUserId === receiverUserId && request.status === "pending") || null);
    },
    async findRequestById(_trx, id) { return structuredClone(state.requests.find((request) => request.id === id) || null); },
    async createRequest(_trx, request) { state.requests.push(structuredClone(request)); return structuredClone(request); },
    async resolveRequest(_trx, id, status) {
      const request = state.requests.find((item) => item.id === id && item.status === "pending");
      if (!request) return null;
      request.status = status;
      return structuredClone(request);
    },
    async isBlocked(_trx, userId, peerUserId) { return state.blocks.has(`${userId}:${peerUserId}`) || state.blocks.has(`${peerUserId}:${userId}`); },
    async friendship(_trx, userId, peerUserId) { return structuredClone(state.friendships.get(pair(userId, peerUserId)) || null); },
    async upsertFriendship(_trx, userId, peerUserId) {
      const key = pair(userId, peerUserId); const row = { userLowId: key.split(":")[0], userHighId: key.split(":")[1], status: "active" };
      state.friendships.set(key, row); return structuredClone(row);
    },
    async removeFriendship(_trx, userId, peerUserId) {
      const row = state.friendships.get(pair(userId, peerUserId));
      if (!row) return null; row.status = "removed"; return structuredClone(row);
    },
    async findOrCreatePersonalDirect(_trx, userId, peerUserId) {
      const key = pair(userId, peerUserId); if (!state.directs.has(key)) state.directs.set(key, { id: `direct-${++state.nextId}`, userIds: key.split(":") });
      return structuredClone(state.directs.get(key));
    },
    async addBlock(_trx, userId, peerUserId) { state.blocks.add(`${userId}:${peerUserId}`); },
    async removeBlock(_trx, userId, peerUserId) { state.blocks.delete(`${userId}:${peerUserId}`); },
  };
  const service = createCollaborationFriendService({ repository, rateLimiter, createId: (prefix) => `${prefix}-${++state.nextId}` });
  return { state, service };
}

const accountA = { userId: "user-a", deviceId: "device-a" };
const accountB = { userId: "user-b", deviceId: "device-b" };

{
  const { state, service } = createHarness();
  const first = await service.requestFriend({ account: accountA, clientCommandId: "request-1", lilyId: "LILY-B" });
  assert.equal(first.status, "pending");
  const replay = await service.requestFriend({ account: accountA, clientCommandId: "request-1", lilyId: "lily-b" });
  assert.deepEqual(replay, first, "a dropped response replay does not create a second request");
  assert.equal(state.requests.length, 1);
  const crossed = await service.requestFriend({ account: accountB, clientCommandId: "request-2", lilyId: "lily-a" });
  assert.equal(crossed.status, "active", "a reciprocal request accepts the existing request instead of creating a crossing pending pair");
  assert.equal(state.requests.filter((request) => request.status === "accepted").length, 1);
  assert.equal(state.friendships.size, 1);
  assert.equal(state.directs.size, 1);
}

{
  const { state, service } = createHarness();
  const pending = await service.requestFriend({ account: accountA, clientCommandId: "request-3", lilyId: "lily-b" });
  const declined = await service.respondToFriendRequest({ account: accountB, clientCommandId: "decline-1", requestId: pending.requestId, accept: false });
  assert.equal(declined.status, "declined");
  const repeated = await service.requestFriend({ account: accountA, clientCommandId: "request-4", lilyId: "lily-b" });
  const accepted = await service.respondToFriendRequest({ account: accountB, clientCommandId: "accept-1", requestId: repeated.requestId, accept: true });
  const oldConversationId = accepted.conversationId;
  await service.removeFriend({ account: accountA, clientCommandId: "remove-1", peerUserId: "user-b" });
  const readded = await service.requestFriend({ account: accountA, clientCommandId: "request-5", lilyId: "lily-b" });
  const reaccepted = await service.respondToFriendRequest({ account: accountB, clientCommandId: "accept-2", requestId: readded.requestId, accept: true });
  assert.equal(reaccepted.conversationId, oldConversationId, "re-adding a removed friend reuses the personal direct history");
  assert.equal(state.directs.size, 1);
}

{
  const { service } = createHarness();
  await service.blockUser({ account: accountB, clientCommandId: "block-1", peerUserId: "user-a" });
  await assert.rejects(() => service.requestFriend({ account: accountA, clientCommandId: "request-blocked", lilyId: "lily-b" }), (error) => error?.code === "COLLAB_FRIEND_TARGET_UNAVAILABLE", "a block wins over friend requests without exposing which rule hid the target");
  await assert.rejects(() => service.lookupLilyId({ account: accountA, lilyId: "lily-hidden" }), (error) => error?.code === "COLLAB_FRIEND_TARGET_UNAVAILABLE", "hidden and unknown Lily IDs share the anti-enumeration response");
  await assert.rejects(() => service.lookupLilyId({ account: accountA, lilyId: "does-not-exist" }), (error) => error?.code === "COLLAB_FRIEND_TARGET_UNAVAILABLE");
}

{
  const limiter = createFriendRequestRateLimiter({ limit: 1, windowMs: 60_000, now: () => 1_000 });
  assert.equal(limiter.consume({ senderUserId: "user-a", receiverUserId: "user-b", deviceId: "device-a", ip: "127.0.0.1" }).ok, true);
  assert.equal(limiter.consume({ senderUserId: "user-a", receiverUserId: "user-c", deviceId: "device-a", ip: "127.0.0.1" }).ok, false, "sender/device/IP dimensions cap bulk probes even when the target changes");
}

{
  const limiter = createFriendRequestRateLimiter({ limit: 1, now: () => 1_000 });
  const { service } = createHarness({ rateLimiter: limiter });
  await service.lookupLilyId({ account: accountA, lilyId: "does-not-exist", ip: "127.0.0.1" }).catch((error) => assert.equal(error.code, "COLLAB_FRIEND_TARGET_UNAVAILABLE"));
  await assert.rejects(() => service.lookupLilyId({ account: accountA, lilyId: "lily-b", ip: "127.0.0.1" }), (error) => error?.code === "COLLAB_FRIEND_RATE_LIMITED", "unknown and known Lily lookups consume the same sender/device/IP anti-enumeration budget");
}

console.log("collaboration friends: ok");
