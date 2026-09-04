#!/usr/bin/env node
import assert from "node:assert/strict";
import { authorizeConversationCreation, authorizeConversationMemberMutation, authorizeTeamMemberRevocation } from "../server/src/services/collaboration/team-scopes.js";

const actor = { user_id: "a", status: "active", role: "member" };
const creation = (overrides = {}) => ({ actorUserId: "a", scopeType: "organization", kind: "channel", visibility: "private", memberUserIds: ["a", "b"], organization: { status: "active" }, organizationMembers: [actor, { user_id: "b", status: "active", role: "member" }], ...overrides });
assert.equal(authorizeConversationCreation(creation()).ok, true, "ordinary active Team member can create private channel");
assert.equal(authorizeConversationCreation(creation({ visibility: "public", memberUserIds: [] })).ok, false);
assert.equal(authorizeConversationCreation(creation({ visibility: "public", memberUserIds: [], organizationMembers: [{ ...actor, role: "admin" }] })).ok, true);
assert.equal(authorizeConversationCreation(creation({ organization: { status: "disabled" } })).ok, false);
assert.equal(authorizeConversationCreation(creation({ organizationMembers: [actor] })).ok, false, "private invitee must be active Team member");
assert.equal(authorizeConversationCreation(creation({ kind: "direct", visibility: null })).ok, true, "Team direct does not require personal friendship");
assert.equal(authorizeConversationCreation(creation({ kind: "direct", visibility: null, memberUserIds: ["a", "b", "c"] })).ok, false);
assert.equal(authorizeConversationCreation(creation({ scopeType: "personal", kind: "group", visibility: null, organization: null, organizationMembers: [] })).ok, true);
assert.equal(authorizeConversationCreation(creation({ scopeType: "personal", kind: "channel" })).ok, false);
assert.equal(authorizeConversationCreation(creation({ scopeType: "personal", kind: "group", visibility: null, memberUserIds: Array.from({ length: 201 }, (_, i) => i === 0 ? "a" : `u${i}`) })).ok, false);
assert.equal(authorizeConversationCreation(creation({ memberUserIds: Array.from({ length: 501 }, (_, i) => `u${i}`) })).ok, false);

const memberChange = (overrides = {}) => ({ actorUserId: "a", conversation: { scopeType: "personal", kind: "group", status: "active" }, authorization: { conversationMembership: { ...actor, role: "admin" } }, operation: "remove", targetUserId: "b", targetMembership: { user_id: "b", role: "member", status: "active" }, activeMemberCount: 2, ...overrides });
assert.equal(authorizeConversationMemberMutation(memberChange()).ok, true);
assert.equal(authorizeConversationMemberMutation(memberChange({ targetMembership: { user_id: "b", role: "owner", status: "active" } })).ok, false);
assert.equal(authorizeConversationMemberMutation(memberChange({ operation: "role", role: "owner" })).ok, false, "owner transfer is not silently implemented as promotion");
assert.equal(authorizeConversationMemberMutation(memberChange({ conversation: { scopeType: "personal", kind: "direct" } })).ok, false);
assert.equal(authorizeConversationMemberMutation(memberChange({ operation: "add", activeMemberCount: 200, targetMembership: null })).ok, false);
// Leaving: a member may always remove THEMSELVES without invite rights; an
// owner may not silently leave (must transfer or dissolve).
const selfLeave = (overrides = {}) => memberChange({ actorUserId: "b", targetUserId: "b", authorization: { conversationMembership: { user_id: "b", role: "member", status: "active" } }, targetMembership: { user_id: "b", role: "member", status: "active" }, ...overrides });
assert.equal(authorizeConversationMemberMutation(selfLeave()).ok, true, "a plain member can leave (remove self) without invite rights");
assert.equal(authorizeConversationMemberMutation(selfLeave({ targetMembership: { user_id: "b", role: "owner", status: "active" } })).ok, false, "an owner cannot silently leave");
assert.equal(authorizeConversationMemberMutation(selfLeave({ targetMembership: { user_id: "b", role: "owner", status: "active" } })).code, "COLLAB_OWNER_MUST_TRANSFER", "owner leave is rejected with a transfer-required code");
assert.equal(authorizeConversationMemberMutation(memberChange({ actorUserId: "c", targetUserId: "b", authorization: { conversationMembership: { user_id: "c", role: "member", status: "active" } } })).ok, false, "a plain member still cannot remove someone else without invite rights");

assert.equal(authorizeConversationMemberMutation(memberChange({ operation: "add", targetUserId: "b", targetMembership: { user_id: "b", status: "active", role: "owner" } })).ok, true, "repeat add is a no-op, never resets existing role");
assert.equal(authorizeTeamMemberRevocation({ actorUserId: "a", targetUserId: "b", organization: { status: "active" }, organizationMembers: [{ ...actor, role: "admin" }, { user_id: "b", status: "active", role: "owner" }] }).ok, false);
assert.equal(authorizeTeamMemberRevocation({ actorUserId: "a", targetUserId: "b", organization: { status: "active" }, organizationMembers: [{ ...actor, role: "owner" }, { user_id: "b", status: "active", role: "member" }] }).ok, true);
assert.equal(authorizeTeamMemberRevocation({ actorUserId: "a", targetUserId: "a", organization: { status: "active" }, organizationMembers: [{ ...actor, role: "owner" }] }).ok, false);
console.log("collaboration Team permissions: 20 assertions passed");
