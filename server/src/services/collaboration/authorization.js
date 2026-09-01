// Collaboration authorization has no database access. Its input is the
// server-locked authorization snapshot assembled by the command layer; client
// supplied roles, membership flags, and timestamps are intentionally ignored.

import { roleAtLeast } from "../enterprise.js";

const ACTIONS = new Set(["read", "send", "invite", "download", "audit"]);

function deny(code, auditReason) {
  return { ok: false, code, auditReason, retryable: false };
}

function allow() {
  return { ok: true, code: "COLLAB_AUTHORIZED", auditReason: "authorized" };
}

function activeMembership(membership, actorUserId) {
  if (!membership || membership.status !== "active") return false;
  return (membership.userId ?? membership.user_id) === actorUserId;
}

function trustedRole(membership) {
  return membership?.role || "";
}

function isBlocked(authorization) {
  return authorization?.blocked === true || authorization?.blockStatus === "active";
}

function requireConversationMember(context) {
  return activeMembership(context.authorization?.conversationMembership, context.actorUserId)
    ? null
    : deny("COLLAB_MEMBERSHIP_INACTIVE", "conversation-membership-inactive");
}

function requireOrganizationMember(context) {
  const authorization = context.authorization || {};
  if (authorization.organizationStatus !== "active") {
    return deny("COLLAB_ORGANIZATION_ACCESS_REVOKED", "organization-inactive");
  }
  if (!activeMembership(authorization.organizationMembership, context.actorUserId)) {
    return deny("COLLAB_ORGANIZATION_ACCESS_REVOKED", "organization-membership-inactive");
  }
  return null;
}

function requireCompletedObject(context) {
  return context.authorization?.objectStatus === "completed"
    ? null
    : deny("COLLAB_OBJECT_UNAVAILABLE", "object-not-completed");
}

function authorizePersonal(context, action) {
  const { conversation, authorization = {} } = context;
  const memberError = requireConversationMember(context);
  if (memberError) return memberError;

  if (action === "audit") {
    if (conversation.kind === "direct") {
      return authorization.ownSecurityEvent === true
        ? allow()
        : deny("COLLAB_AUDIT_FORBIDDEN", "personal-direct-audit-forbidden");
    }
    if (conversation.kind === "group") {
      return roleAtLeast(trustedRole(authorization.conversationMembership), "admin")
        ? allow()
        : deny("COLLAB_AUDIT_FORBIDDEN", "personal-group-audit-role-insufficient");
    }
    return deny("COLLAB_CONVERSATION_INVALID", "personal-conversation-kind-invalid");
  }

  if (conversation.kind === "direct") {
    if (action === "invite") return deny("COLLAB_ACTION_NOT_AVAILABLE", "direct-invite-not-applicable");
    if ((action === "send" || action === "download") && isBlocked(authorization)) {
      return deny("COLLAB_BLOCKED", "blocked-relationship");
    }
    if (action === "send" && authorization.friendshipStatus !== "active") {
      return deny("COLLAB_FRIENDSHIP_REQUIRED", "friendship-inactive");
    }
    if (action === "download") {
      const objectError = requireCompletedObject(context);
      if (objectError) return objectError;
    }
    return allow();
  }

  if (conversation.kind !== "group") return deny("COLLAB_CONVERSATION_INVALID", "personal-conversation-kind-invalid");
  if (action === "invite") {
    return roleAtLeast(trustedRole(authorization.conversationMembership), "admin")
      ? allow()
      : deny("COLLAB_INVITE_FORBIDDEN", "group-invite-role-insufficient");
  }
  if (action === "download") {
    const objectError = requireCompletedObject(context);
    if (objectError) return objectError;
  }
  return allow();
}

function authorizeOrganization(context, action) {
  const { conversation, authorization = {} } = context;
  const organizationError = requireOrganizationMember(context);
  if (organizationError) return organizationError;

  if (action === "audit") {
    return roleAtLeast(trustedRole(authorization.organizationMembership), "admin")
      ? allow()
      : deny("COLLAB_AUDIT_FORBIDDEN", "organization-audit-role-insufficient");
  }

  if (conversation.kind === "direct") {
    const memberError = requireConversationMember(context);
    if (memberError) return memberError;
    if (action === "invite") return deny("COLLAB_ACTION_NOT_AVAILABLE", "team-direct-invite-not-applicable");
    if ((action === "send" || action === "download") && isBlocked(authorization)) {
      return deny("COLLAB_BLOCKED", "blocked-relationship");
    }
    if (action === "send" && authorization.peerOrganizationMembershipStatus !== "active") {
      return deny("COLLAB_PEER_MEMBERSHIP_INACTIVE", "team-direct-peer-membership-inactive");
    }
    if (action === "download") {
      const objectError = requireCompletedObject(context);
      if (objectError) return objectError;
    }
    return allow();
  }

  if (conversation.kind !== "channel") return deny("COLLAB_CONVERSATION_INVALID", "organization-conversation-kind-invalid");
  const privateChannel = conversation.visibility === "private";
  if (privateChannel) {
    const memberError = requireConversationMember(context);
    if (memberError) return memberError;
  } else if (conversation.visibility !== "public") {
    return deny("COLLAB_CONVERSATION_INVALID", "channel-visibility-invalid");
  }

  if (action === "invite") {
    const roleSource = privateChannel ? authorization.conversationMembership : authorization.organizationMembership;
    return roleAtLeast(trustedRole(roleSource), "admin")
      ? allow()
      : deny("COLLAB_INVITE_FORBIDDEN", privateChannel ? "private-channel-invite-role-insufficient" : "public-channel-management-role-insufficient");
  }
  if (action === "download") {
    const objectError = requireCompletedObject(context);
    if (objectError) return objectError;
  }
  return allow();
}

/**
 * Authorize a collaboration operation from server-locked facts only. This
 * function is intentionally pure: callers must fetch and lock all referenced
 * rows through lock-order.js before constructing `context`.
 */
export function authorizeCollaborationAction(context, action) {
  if (!ACTIONS.has(action)) return deny("COLLAB_ACTION_INVALID", "action-invalid");
  if (!context?.actorUserId || !context?.conversation || !context.authorization) {
    return deny("COLLAB_AUTHORIZATION_CONTEXT_INVALID", "authorization-context-invalid");
  }
  if (context.conversation.scopeType === "personal") return authorizePersonal(context, action);
  if (context.conversation.scopeType === "organization") return authorizeOrganization(context, action);
  return deny("COLLAB_CONVERSATION_INVALID", "conversation-scope-invalid");
}

/** Normalize PostgreSQL retryable transaction failures for every collab route. */
export function mapCollaborationTransactionError(error) {
  if (error?.code === "40P01" || error?.code === "40001") {
    return { retryable: true, code: "COLLAB_TRANSACTION_RETRY", auditReason: "database-contention" };
  }
  return { retryable: false, code: "COLLAB_TRANSACTION_FAILED", auditReason: "database-error" };
}
