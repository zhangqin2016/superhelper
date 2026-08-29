#!/usr/bin/env node
import assert from "node:assert/strict";

const {
  COLLABORATION_CONTRACT_SCHEMA_VERSION,
  COLLABORATION_CONVERSATION_KINDS,
  COLLABORATION_EVENT_TYPES,
  COLLABORATION_MEMBER_ROLES,
  COLLABORATION_SCOPE_TYPES,
  canonicalDirectPair,
  classifyCollaborationEvent,
  isKnownCollaborationEventType,
} = await import("../server/src/services/collaboration/contracts.js");

assert.equal(COLLABORATION_CONTRACT_SCHEMA_VERSION, 1);
assert.deepEqual(COLLABORATION_SCOPE_TYPES, ["personal", "organization"]);
assert.deepEqual(COLLABORATION_CONVERSATION_KINDS, ["direct", "group", "channel"]);
assert.deepEqual(COLLABORATION_MEMBER_ROLES, ["owner", "admin", "member"]);
assert.ok(COLLABORATION_EVENT_TYPES.includes("message.created"));
assert.ok(COLLABORATION_EVENT_TYPES.includes("message.edited"));
assert.ok(COLLABORATION_EVENT_TYPES.includes("message.revoked"));
assert.ok(Object.isFrozen(COLLABORATION_EVENT_TYPES), "protocol enums must not be mutable at runtime");
assert.deepEqual(canonicalDirectPair("user-b", "user-a"), {
  lowUserId: "user-a",
  highUserId: "user-b",
  key: "user-a:user-b",
});
assert.throws(() => canonicalDirectPair("user-a", "user-a"), /distinct/i);

assert.equal(isKnownCollaborationEventType("message.created"), true);
assert.equal(isKnownCollaborationEventType("message.future_version"), false);
assert.deepEqual(classifyCollaborationEvent({ type: "message.created" }), {
  action: "apply",
  cursorAdvance: true,
});
assert.deepEqual(classifyCollaborationEvent({ type: "message.future_version" }), {
  action: "ignore",
  cursorAdvance: true,
  reason: "UNKNOWN_COLLABORATION_EVENT",
});
assert.deepEqual(classifyCollaborationEvent(null), {
  action: "ignore",
  cursorAdvance: true,
  reason: "UNKNOWN_COLLABORATION_EVENT",
});

console.log("collaboration-contracts: ok");
