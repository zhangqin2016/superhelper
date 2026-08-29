#!/usr/bin/env node
// Lock order is a correctness contract: concurrent send/revoke/fanout paths
// must acquire authorization before conversation, entities, then sync cursors.

import assert from "node:assert/strict";

const {
  canonicalFriendshipPair,
  orderCollaborationLocks,
  lockAuthorizationRows,
  lockSyncStates,
} = await import("../server/src/services/collaboration/lock-order.js");

assert.deepEqual(canonicalFriendshipPair("user-z", "user-a"), { lowUserId: "user-a", highUserId: "user-z", key: "user-a:user-z" });
assert.throws(() => canonicalFriendshipPair("user-a", "user-a"), /distinct non-empty/);

const ordered = orderCollaborationLocks({
  organizationIds: ["org-z", "org-a", "org-a"],
  friendshipPairs: [["user-z", "user-a"], ["user-b", "user-c"], ["user-a", "user-z"]],
  blockPairs: [["user-z", "user-a"]],
  conversationId: "conv-4",
  messageIds: ["msg-z", "msg-a", "msg-a"],
  objectIds: ["obj-2", "obj-1"],
  userIds: ["user-z", "user-a", "user-b", "user-a"],
  organizationMemberships: [{ organizationId: "org-z", userId: "user-z" }, { organizationId: "org-a", userId: "user-a" }],
  conversationMemberUserIds: ["user-z", "user-a"],
});
assert.deepEqual(ordered, {
  organizationIds: ["org-a", "org-z"],
  friendshipPairs: [
    { lowUserId: "user-a", highUserId: "user-z", key: "user-a:user-z" },
    { lowUserId: "user-b", highUserId: "user-c", key: "user-b:user-c" },
  ],
  blockPairs: [{ lowUserId: "user-a", highUserId: "user-z", key: "user-a:user-z" }],
  blockUserIds: ["user-a", "user-z"],
  conversationId: "conv-4",
  messageIds: ["msg-a", "msg-z"],
  objectIds: ["obj-1", "obj-2"],
  userIds: ["user-a", "user-b", "user-z"],
  organizationMemberships: [{ organizationId: "org-a", userId: "user-a" }, { organizationId: "org-z", userId: "user-z" }],
  conversationMemberUserIds: ["user-a", "user-z"],
});

function mockTrx() {
  const calls = [];
  return {
    calls,
    selectFrom(table) {
      const call = { table, where: [], orderBy: [], locked: false };
      calls.push(call);
      const query = {
        select(columns) { call.select = columns; return query; },
        selectAll() { call.select = "*"; return query; },
        where(...args) { call.where.push(args); return query; },
        orderBy(...args) { call.orderBy.push(args); return query; },
        forUpdate() { call.locked = true; return query; },
        async execute() { return [{ table }]; },
      };
      return query;
    },
  };
}

{
  const trx = mockTrx();
  const result = await lockAuthorizationRows(trx, {
    organizationIds: ["org-z", "org-a"],
    friendshipPairs: [["user-z", "user-a"]],
    blockPairs: [["user-z", "user-a"]],
    conversationId: "conv-1",
    messageIds: ["msg-z", "msg-a"],
    objectIds: ["obj-z", "obj-a"],
    organizationMemberships: [{ organizationId: "org-a", userId: "user-a" }],
    conversationMemberUserIds: ["user-a"],
  });
  assert.deepEqual(trx.calls.map((call) => call.table), [
    "organizations", "organization_members", "friendships", "users", "user_blocks", "conversations", "conversation_members", "messages", "stored_objects",
  ]);
  assert.ok(trx.calls.every((call) => call.locked), "every authorization row uses FOR UPDATE");
  assert.ok(trx.calls.every((call) => call.orderBy.length > 0), "every multi-row lock query orders rows before FOR UPDATE");
  assert.deepEqual(result.order, ["organization", "organizationMembership", "friendship", "blockUsers", "block", "conversation", "conversationMembership", "message", "object"]);
}

{
  const trx = mockTrx();
  await lockSyncStates(trx, ["user-z", "user-a", "user-a"]);
  assert.equal(trx.calls.length, 1);
  assert.equal(trx.calls[0].table, "user_sync_state");
  assert.equal(trx.calls[0].locked, true);
  assert.deepEqual(trx.calls[0].where[0], ["user_id", "in", ["user-a", "user-z"]]);
}

console.log("collaboration lock order: ok");
