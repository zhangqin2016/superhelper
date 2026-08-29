#!/usr/bin/env node
// Authorization is deliberately a pure, server-derived decision. These cases
// cover the v1 matrix without trusting a role claimed by a desktop client.

import assert from "node:assert/strict";

const {
  authorizeCollaborationAction,
  mapCollaborationTransactionError,
} = await import("../server/src/services/collaboration/authorization.js");

function personal({ kind, membership = "active", friendship = "active", blocked = false, role = "member" } = {}) {
  return {
    actorUserId: "user-a",
    conversation: { scopeType: "personal", kind },
    authorization: {
      conversationMembership: { userId: "user-a", status: membership, role },
      friendshipStatus: friendship,
      blocked,
      objectStatus: "completed",
    },
    // A desktop can claim this freely. It must not affect the decision.
    clientRole: "owner",
  };
}

function organization({ kind, visibility = "public", orgStatus = "active", orgMembership = "active", conversationMembership = "active", role = "member", peerOrgMembership = "active", blocked = false } = {}) {
  return {
    actorUserId: "user-a",
    conversation: { scopeType: "organization", kind, visibility },
    authorization: {
      organizationStatus: orgStatus,
      organizationMembership: { userId: "user-a", status: orgMembership, role },
      conversationMembership: { userId: "user-a", status: conversationMembership, role },
      peerOrganizationMembershipStatus: peerOrgMembership,
      blocked,
      objectStatus: "completed",
    },
    clientRole: "owner",
  };
}

function expectAllowed(context, action) {
  const result = authorizeCollaborationAction(context, action);
  assert.deepEqual(result, { ok: true, code: "COLLAB_AUTHORIZED", auditReason: "authorized" }, `${context.conversation.scopeType}/${context.conversation.kind} ${action}`);
}

function expectDenied(context, action, code) {
  const result = authorizeCollaborationAction(context, action);
  assert.equal(result.ok, false, `${context.conversation.scopeType}/${context.conversation.kind} ${action} is denied`);
  assert.equal(result.code, code);
  assert.equal(result.retryable, false, "authorization failures are never retryable");
  assert.ok(result.auditReason, "denials contain a stable audit reason");
}

// Personal direct: history needs an active membership; sending also needs an
// active friendship and no block. A client-claimed owner role has no effect.
expectAllowed(personal({ kind: "direct" }), "read");
expectAllowed(personal({ kind: "direct" }), "send");
expectAllowed(personal({ kind: "direct" }), "download");
expectDenied(personal({ kind: "direct" }), "invite", "COLLAB_ACTION_NOT_AVAILABLE");
expectDenied(personal({ kind: "direct", friendship: "removed" }), "send", "COLLAB_FRIENDSHIP_REQUIRED");
expectDenied(personal({ kind: "direct", blocked: true }), "send", "COLLAB_BLOCKED");
expectDenied(personal({ kind: "direct", blocked: true }), "download", "COLLAB_BLOCKED");

// Personal group: a current member reads/sends/downloads; only the persisted
// owner/admin role may invite. The untrusted clientRole above must not grant it.
expectAllowed(personal({ kind: "group" }), "read");
expectAllowed(personal({ kind: "group" }), "send");
expectAllowed(personal({ kind: "group" }), "download");
expectDenied(personal({ kind: "group", role: "member" }), "invite", "COLLAB_INVITE_FORBIDDEN");
expectAllowed(personal({ kind: "group", role: "admin" }), "invite");
expectDenied(personal({ kind: "group", membership: "removed" }), "read", "COLLAB_MEMBERSHIP_INACTIVE");
expectDenied({
  ...personal({ kind: "group" }),
  authorization: { ...personal({ kind: "group" }).authorization, conversationMembership: { status: "active", role: "owner" } },
}, "send", "COLLAB_MEMBERSHIP_INACTIVE");
expectAllowed({
  ...personal({ kind: "group" }),
  authorization: { ...personal({ kind: "group" }).authorization, conversationMembership: { user_id: "user-a", status: "active", role: "member" } },
}, "send");
expectAllowed(personal({ kind: "group", role: "owner" }), "audit");
expectDenied(personal({ kind: "group", role: "member" }), "audit", "COLLAB_AUDIT_FORBIDDEN");

// Team direct requires the actor's active organization + conversation
// membership; sending also verifies the peer's current organization status.
expectAllowed(organization({ kind: "direct" }), "read");
expectAllowed(organization({ kind: "direct" }), "send");
expectAllowed(organization({ kind: "direct" }), "download");
expectDenied(organization({ kind: "direct", peerOrgMembership: "disabled" }), "send", "COLLAB_PEER_MEMBERSHIP_INACTIVE");
expectDenied(organization({ kind: "direct", blocked: true }), "send", "COLLAB_BLOCKED");
expectDenied(organization({ kind: "direct", blocked: true }), "download", "COLLAB_BLOCKED");
expectDenied(organization({ kind: "direct", orgMembership: "disabled" }), "read", "COLLAB_ORGANIZATION_ACCESS_REVOKED");
expectDenied({
  ...organization({ kind: "direct" }),
  authorization: { ...organization({ kind: "direct" }).authorization, organizationMembership: { status: "active", role: "owner" } },
}, "read", "COLLAB_ORGANIZATION_ACCESS_REVOKED");

// Public channels derive read/send/download access from organization membership;
// management belongs to a persisted organization admin/owner.
expectAllowed(organization({ kind: "channel", visibility: "public" }), "read");
expectAllowed(organization({ kind: "channel", visibility: "public" }), "send");
expectAllowed(organization({ kind: "channel", visibility: "public" }), "download");
expectDenied(organization({ kind: "channel", visibility: "public", role: "member" }), "invite", "COLLAB_INVITE_FORBIDDEN");
expectAllowed(organization({ kind: "channel", visibility: "public", role: "admin" }), "invite");

// Private channels additionally require a current channel membership on every
// action; a disabled organization immediately revokes all new access.
expectAllowed(organization({ kind: "channel", visibility: "private", role: "admin" }), "read");
expectAllowed(organization({ kind: "channel", visibility: "private", role: "admin" }), "invite");
expectDenied(organization({ kind: "channel", visibility: "private", conversationMembership: "removed" }), "read", "COLLAB_MEMBERSHIP_INACTIVE");
expectDenied(organization({ kind: "channel", visibility: "private", orgStatus: "disabled" }), "download", "COLLAB_ORGANIZATION_ACCESS_REVOKED");

// Audit is intentionally separate from ordinary membership: Team audit needs
// a persisted org owner/admin and personal audit only exposes one's own event.
expectAllowed({ ...personal({ kind: "direct" }), authorization: { ...personal({ kind: "direct" }).authorization, ownSecurityEvent: true } }, "audit");
expectDenied(personal({ kind: "direct" }), "audit", "COLLAB_AUDIT_FORBIDDEN");
expectAllowed(organization({ kind: "channel", role: "owner" }), "audit");
expectDenied(organization({ kind: "channel", role: "member" }), "audit", "COLLAB_AUDIT_FORBIDDEN");

expectDenied({ actorUserId: "user-a", conversation: { scopeType: "personal", kind: "group" }, authorization: {} }, "read", "COLLAB_MEMBERSHIP_INACTIVE");
expectDenied(personal({ kind: "group" }), "delete-everything", "COLLAB_ACTION_INVALID");

assert.deepEqual(
  mapCollaborationTransactionError({ code: "40P01" }),
  { retryable: true, code: "COLLAB_TRANSACTION_RETRY", auditReason: "database-contention" },
);
assert.deepEqual(
  mapCollaborationTransactionError({ code: "40001" }),
  { retryable: true, code: "COLLAB_TRANSACTION_RETRY", auditReason: "database-contention" },
);
assert.deepEqual(
  mapCollaborationTransactionError({ code: "42501" }),
  { retryable: false, code: "COLLAB_TRANSACTION_FAILED", auditReason: "database-error" },
);

console.log("collaboration authorization: ok");
