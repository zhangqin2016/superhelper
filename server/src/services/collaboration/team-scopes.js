import { randomUUID } from "node:crypto";
import { canManageMember, roleAtLeast } from "../enterprise.js";
import { authorizeCollaborationAction } from "./authorization.js";
import { runCollaborationCommand } from "./command-runner.js";

const allowed = () => ({ ok: true });
const denied = (code) => ({ ok: false, code, auditReason: code.toLowerCase(), retryable: false });
const member = (rows, userId) => rows?.find((row) => (row.user_id ?? row.userId) === userId);
const active = (row) => row?.status === "active";

/** Inputs here are server-locked facts, never a role supplied by a client. */
export function authorizeConversationCreation({ actorUserId, scopeType, kind, visibility, memberUserIds = [], organization, organizationMembers = [] } = {}) {
  if (scopeType === "personal") {
    if (kind !== "group" || visibility != null) return denied("COLLAB_CONVERSATION_INVALID");
    return memberUserIds.includes(actorUserId) && memberUserIds.length <= 200 ? allowed() : denied("COLLAB_MEMBER_LIMIT");
  }
  if (scopeType !== "organization" || !["direct", "channel"].includes(kind)) return denied("COLLAB_CONVERSATION_INVALID");
  const actor = member(organizationMembers, actorUserId);
  if (organization?.status !== "active" || !active(actor)) return denied("COLLAB_ORGANIZATION_ACCESS_REVOKED");
  if (kind === "direct") {
    if (visibility != null || memberUserIds.length !== 2 || !memberUserIds.includes(actorUserId)) return denied("COLLAB_CONVERSATION_INVALID");
  } else if (visibility === "public") {
    if (memberUserIds.length !== 0) return denied("COLLAB_PUBLIC_MEMBERSHIP_DERIVED");
    return roleAtLeast(actor.role, "admin") ? allowed() : denied("COLLAB_INVITE_FORBIDDEN");
  } else if (visibility !== "private") return denied("COLLAB_CONVERSATION_INVALID");
  if (memberUserIds.length > 500) return denied("COLLAB_MEMBER_LIMIT");
  return memberUserIds.every((id) => active(member(organizationMembers, id))) ? allowed() : denied("COLLAB_TARGET_MEMBERSHIP_INACTIVE");
}

export function authorizeConversationMemberMutation(context = {}) {
  const { conversation, operation, role, targetMembership, targetOrganizationMembership, activeMemberCount = 0 } = context;
  if (!["add", "remove", "role"].includes(operation)) return denied("COLLAB_MEMBER_OPERATION_INVALID");
  if (conversation?.kind === "direct" || conversation?.visibility === "public") return denied("COLLAB_ACTION_NOT_AVAILABLE");
  if (conversation?.status && conversation.status !== "active") return denied("COLLAB_CONVERSATION_UNAVAILABLE");
  const permission = authorizeCollaborationAction(context, "invite");
  if (!permission.ok) return permission;
  if (operation === "add") {
    if (conversation.scopeType === "organization" && !active(targetOrganizationMembership)) return denied("COLLAB_TARGET_MEMBERSHIP_INACTIVE");
    if (!active(targetMembership) && activeMemberCount >= (conversation.scopeType === "personal" ? 200 : 500)) return denied("COLLAB_MEMBER_LIMIT");
    return allowed();
  }
  if (!active(targetMembership)) return operation === "remove" ? allowed() : denied("COLLAB_TARGET_MEMBERSHIP_INACTIVE");
  // Ownership transfer is a separate workflow; membership administration must
  // not accidentally destroy the only owner or manufacture another owner.
  if (targetMembership.role === "owner") return denied("COLLAB_OWNER_IMMUTABLE");
  if (operation === "role" && !["admin", "member"].includes(role)) return denied("COLLAB_MEMBER_ROLE_INVALID");
  return allowed();
}

export function authorizeTeamMemberRevocation({ actorUserId, targetUserId, organization, organizationMembers = [] } = {}) {
  const actor = member(organizationMembers, actorUserId);
  const target = member(organizationMembers, targetUserId);
  if (organization?.status !== "active" || !active(actor)) return denied("COLLAB_ORGANIZATION_ACCESS_REVOKED");
  if (!target) return denied("COLLAB_TARGET_MEMBERSHIP_INACTIVE");
  const permission = canManageMember({ actorRole: actor.role, targetRole: target.role, action: "remove", self: actorUserId === targetUserId });
  return permission.ok ? allowed() : denied(permission.code);
}

/** Member disabling and its security cursor share the ordinary command kernel. */
export function createCollaborationTeamScopeService({ repository, createId = (prefix) => `${prefix}_${randomUUID()}` } = {}) {
  if (!repository?.database) throw new TypeError("A collaboration conversation repository is required.");
  return Object.freeze({
    async revokeTeamMember({ account, organizationId, targetUserId, clientCommandId } = {}) {
      const input = { organizationId: repository.requireId(organizationId), targetUserId: repository.requireId(targetUserId) };
      return runCollaborationCommand({ account, clientCommandId, input, commandType: "team.member.revoke", database: repository.database,
        authorize: async ({ trx, account: actor }) => {
          const device = await repository.lockDevice(trx, actor);
          if (!device.ok) return device;
          const scope = await repository.lockTeamScope(trx, input.organizationId);
          return { ...authorizeTeamMemberRevocation({ ...scope, actorUserId: actor.userId, targetUserId: input.targetUserId }), scope };
        },
        project: async ({ authorization }) => {
          const target = member(authorization.scope.organizationMembers, input.targetUserId);
          const response = { organizationId: input.organizationId, userId: input.targetUserId, status: "disabled" };
          if (target.status === "disabled") return { noEvent: true, event: {}, response, project: async () => {} };
          const eventId = repository.requireId(createId("evt"));
          response.eventId = eventId;
          return { event: { id: eventId, conversationId: null, type: "scope.revoked", payload: { scopeType: "organization", organizationId: input.organizationId, userId: input.targetUserId, reason: "membership-disabled" } }, recipientUserIds: [input.targetUserId], response,
            project: ({ trx }) => repository.disableTeamMember(trx, input.organizationId, input.targetUserId),
          };
        },
      });
    },
  });
}
