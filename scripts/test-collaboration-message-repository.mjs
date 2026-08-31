import assert from "node:assert/strict";
import { createKyselyMessageRepository, createLockedMessageAuthorizer } from "../server/src/services/collaboration/message-repository.js";

// Exercise the shipped delegation rather than requiring methods/locks to live
// in one source file. Real lock contention is tested by Team PG integration.
const rows = {
  user_devices: [{ device_id: "device" }],
  organizations: [{ id: "org", status: "active" }],
  organization_members: [{ user_id: "alice", status: "active" }, { user_id: "bob", status: "active" }],
  conversations: [{ id: "c", scope_type: "organization", organization_id: "org", kind: "direct", status: "active", direct_user_low_id: "alice", direct_user_high_id: "bob", next_seq: 12 }],
  conversation_members: [{ user_id: "alice", status: "active", joined_seq: 4, last_read_seq: 5 }, { user_id: "bob", status: "active", joined_seq: 0 }],
  user_blocks: [], users: [{ id: "alice" }, { id: "bob" }],
};
const locks = [];
const database = {
  transaction() {},
  selectFrom(table) {
    let locked = false;
    const result = () => { if (locked) locks.push(table); return rows[table] || []; };
    const query = { select() { return query; }, selectAll() { return query; }, where() { return query; }, orderBy() { return query; },
      forUpdate() { locked = true; return query; }, async execute() { return result(); }, async executeTakeFirst() { return result()[0]; }, async executeTakeFirstOrThrow() { return result()[0]; } };
    return query;
  },
};
const repository = createKyselyMessageRepository(database);
for (const name of ["activeConversationMemberIds", "findReplyTarget", "findAttachments", "insertMessage", "findMessageForUpdate", "compareAndSwapMessage", "insertMessageRevision", "resolveLastReadSeq", "advanceLastReadSeq", "listHistory"]) assert.equal(typeof repository[name], "function");
const authorize = createLockedMessageAuthorizer();
const input = { trx: database, account: { userId: "alice", deviceId: "device" }, input: { conversationId: "c" }, action: "read" };
assert.equal((await authorize(input)).visibleAfterSeq, 4, "direct membership boundary survives repository delegation");
assert.ok(locks.indexOf("organizations") < locks.indexOf("conversations"), "default authorizer locks org before conversation");
rows.organizations[0].status = "disabled";
assert.equal((await authorize(input)).code, "COLLAB_ORGANIZATION_ACCESS_REVOKED");
rows.organizations[0].status = "active";
rows.user_blocks.push({ blocker_user_id: "bob", blocked_user_id: "alice" });
assert.equal((await authorize({ ...input, action: "send" })).code, "COLLAB_BLOCKED");
rows.user_devices = [];
assert.equal((await authorize(input)).code, "COLLAB_DEVICE_REVOKED");
assert.equal(await repository.resolveLastReadSeq(database, { conversationId: "c", userId: "alice", submittedSeq: Number.MAX_SAFE_INTEGER }), 11);
assert.equal(await repository.resolveLastReadSeq(database, { conversationId: "c", userId: "alice", submittedSeq: 1 }), 5);
console.log("collaboration message repository: delegation, lock order, access and read bounds passed");
