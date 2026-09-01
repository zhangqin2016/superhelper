import assert from "node:assert/strict";
import { conversationCommandBody, conversationGetBody } from "../server/src/routes/public/collaboration-conversations.js";
import { buildBootstrapSnapshot } from "../server/src/services/collaboration/sync-service.js";

const command = { deviceId: "device", clientCommandId: "command" };
const group = { ...command, action: "create", scopeType: "personal", kind: "group", title: "Group", memberUserIds: ["peer"] };
const channel = { ...command, action: "create", scopeType: "organization", organizationId: "org", kind: "channel", visibility: "private", memberUserIds: ["peer"] };
const member = { ...command, action: "member", conversationId: "conversation", targetUserId: "peer", operation: "add" };
for (const input of [group, channel, { ...channel, visibility: "public", memberUserIds: [] }, { ...command, action: "create", scopeType: "organization", organizationId: "org", kind: "direct", memberUserIds: ["peer"] }, member, { ...member, operation: "remove" }, { ...member, operation: "role", role: "admin" }, { ...member, operation: "role", role: "member" }]) {
  assert.deepEqual(conversationCommandBody.parse(input), input);
}
for (const input of [
  { ...group, actorUserId: "forged" }, { ...group, account: { userId: "forged" } }, { ...group, authorization: { role: "owner" } },
  { ...group, role: "owner" }, { ...group, organizationId: "org" }, { ...group, visibility: "public" },
  { ...group, title: "x".repeat(201) }, { ...group, memberUserIds: Array(201).fill("peer") },
  { ...channel, memberUserIds: Array(501).fill("peer") }, { ...channel, visibility: "public", memberUserIds: ["peer"] },
  { ...member, operation: "role" }, { ...member, operation: "role", role: "owner" }, { ...member, role: "admin" },
  { ...member, operation: "transfer" }, { ...member, targetUserId: "" }, { ...group, deviceId: "x".repeat(121) },
  { ...group, clientCommandId: "x".repeat(201) }, { ...group, memberUserIds: ["unsafe\nidentifier"] },
]) assert.equal(conversationCommandBody.safeParse(input).success, false, JSON.stringify(input));
assert.equal(conversationGetBody.safeParse({ deviceId: "device", conversationId: "private", role: "owner" }).success, false);
assert.equal(conversationGetBody.safeParse({ deviceId: "device", conversationId: "x".repeat(201) }).success, false);
assert.equal(conversationGetBody.safeParse({ deviceId: "device", conversationId: "private" }).success, true);
const teamMembers = [{ organization_id: "org", user_id: "peer", lily_id: "lily-peer", display_name: "Peer", avatar_object_id: null }];
const snapshot = buildBootstrapSnapshot({ teamMembers, watermark: 5, conversations: [{ id: "public", scope_type: "organization", organization_id: "org", kind: "channel", visibility: "public" }] });
assert.deepEqual(snapshot.teamMembers, teamMembers);
assert.equal(snapshot.conversations[0].scopeId, "team:org");
assert.equal(snapshot.conversations[0].visibility, "public");
assert.equal(snapshot.watermark, 5);
assert.deepEqual(buildBootstrapSnapshot().teamMembers, []);
console.log("collaboration conversation routes: closed payload variants, bounds and Team projection passed");
