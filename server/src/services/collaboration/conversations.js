import { randomUUID } from "node:crypto";
import { runCollaborationCommand } from "./command-runner.js";
import { authorizeConversationCreation, authorizeConversationMemberMutation } from "./team-scopes.js";

const denied = (code) => ({ ok: false, code, auditReason: code.toLowerCase(), retryable: false });
const uniqueSorted = (ids) => [...new Set(ids)].sort();

/** Personal groups and Team conversations; no route or transport dependencies. */
export function createCollaborationConversationService({ repository, createId = (prefix) => `${prefix}_${randomUUID()}` } = {}) {
  if (!repository?.database) throw new TypeError("A collaboration conversation repository is required.");
  const id = repository.requireId;
  function normalizeCreate(raw, actorUserId) {
    const { scopeType, kind } = raw;
    const visibility = raw.visibility ?? null;
    const organizationId = raw.organizationId == null ? null : id(raw.organizationId);
    if ((scopeType === "organization") !== Boolean(organizationId)) throw new TypeError("Conversation organization scope is invalid.");
    if (typeof (raw.title ?? "") !== "string" || (raw.title ?? "").length > 200) throw new TypeError("Conversation title must be at most 200 characters.");
    if (raw.memberUserIds != null && !Array.isArray(raw.memberUserIds)) throw new TypeError("Conversation members must be a list.");
    const members = (raw.memberUserIds || []).map(id);
    const memberUserIds = uniqueSorted(visibility === "public" ? members : [actorUserId, ...members]);
    return { scopeType, organizationId, kind, visibility, title: (raw.title || "").trim(), memberUserIds };
  }
  return Object.freeze({
    async createConversation({ account, clientCommandId, ...raw } = {}) {
      const actorUserId = id(account?.userId ?? account?.user_id ?? account?.id);
      const input = normalizeCreate(raw, actorUserId);
      return runCollaborationCommand({ account, clientCommandId, input, commandType: "conversation.create", database: repository.database,
        authorize: async ({ trx, account: actor }) => {
          const device = await repository.lockDevice(trx, actor);
          if (!device.ok) return device;
          const scope = input.scopeType === "organization" ? await repository.lockTeamScope(trx, input.organizationId) : {};
          const permission = authorizeConversationCreation({ ...input, ...scope, actorUserId: actor.userId });
          if (!permission.ok) return permission;
          if (input.memberUserIds.length && (await repository.findUsers(trx, input.memberUserIds)).length !== input.memberUserIds.length) return denied("COLLAB_TARGET_UNAVAILABLE");
          return { ...permission, scope };
        },
        prepare: async ({ trx, account: actor }) => {
          const existing = input.kind === "direct" ? await repository.findTeamDirect(trx, input.organizationId, input.memberUserIds) : null;
          if (existing) return { conversation: existing, existing: true };
          return { conversation: await repository.insertConversation(trx, { ...input, id: id(createId("conv")), actorUserId: actor.userId }), existing: false };
        },
        project: async ({ preparation, authorization, account: actor }) => {
          const conversationId = preparation.conversation.id;
          const response = { conversationId };
          if (preparation.existing) return { noEvent: true, event: {}, response, project: async () => {} };
          const eventId = id(createId("evt"));
          response.eventId = eventId;
          const recipients = input.visibility === "public" ? authorization.scope.organizationMembers.filter((row) => row.status === "active").map((row) => row.user_id).sort() : input.memberUserIds;
          return { event: { id: eventId, conversationId, type: "conversation.created", payload: { conversationId, scopeType: input.scopeType, organizationId: input.organizationId, kind: input.kind, visibility: input.visibility, title: input.title, memberUserIds: input.memberUserIds } }, recipientUserIds: recipients, response,
            project: async ({ trx, event }) => {
              // Public membership is derived from organization_members. Never
              // freeze an incomplete copy of the Team roster into this table.
              for (const userId of input.memberUserIds) {
                await repository.addMember(trx, { conversationId, userId, role: input.kind === "direct" ? "member" : userId === actor.userId ? "owner" : "member", joinedSeq: input.kind === "direct" ? 0 : event.seq });
              }
            },
          };
        },
      });
    },
    async mutateMember({ account, clientCommandId, conversationId, targetUserId, operation, role } = {}) {
      const input = { conversationId: id(conversationId), targetUserId: id(targetUserId), operation, role: role ?? null };
      return runCollaborationCommand({ account, clientCommandId, input, commandType: "conversation.member.change", database: repository.database,
        authorize: async ({ trx, account: actor }) => {
          const device = await repository.lockDevice(trx, actor);
          if (!device.ok) return device;
          const context = await repository.lockConversationContext(trx, { actorUserId: actor.userId, conversationId: input.conversationId });
          if (context.decision) return context.decision;
          const targetMembership = context.members.find((row) => row.user_id === input.targetUserId);
          const permission = authorizeConversationMemberMutation({ ...context, ...input, targetMembership, targetOrganizationMembership: context.organizationMembers?.find((row) => row.user_id === input.targetUserId), activeMemberCount: context.members.filter((row) => row.status === "active").length });
          if (!permission.ok) return permission;
          if (operation === "add" && (await repository.findUsers(trx, [input.targetUserId])).length !== 1) return denied("COLLAB_TARGET_UNAVAILABLE");
          return { ...permission, context, targetMembership };
        },
        project: async ({ trx, authorization }) => {
          const current = authorization.targetMembership;
          const response = { conversationId: input.conversationId, userId: input.targetUserId, status: operation === "remove" ? "removed" : "active" };
          const noop = operation === "add" && current?.status === "active" || operation === "remove" && current?.status !== "active" || operation === "role" && current?.role === role;
          if (noop) return { noEvent: true, event: {}, response, project: async () => {} };
          const recipients = await repository.activeConversationMemberIds(trx, input.conversationId);
          // Include the removed member so its devices can drop this channel;
          // this is not scope.revoked, which would remove all Team content.
          const recipientUserIds = uniqueSorted([...recipients, input.targetUserId]);
          const eventId = id(createId("evt")); response.eventId = eventId;
          const type = { add: "member.joined", remove: "member.removed", role: "member.role_changed" }[operation];
          return { event: { id: eventId, conversationId: input.conversationId, type, payload: { userId: input.targetUserId, role: operation === "role" ? role : operation === "add" ? "member" : current?.role || "member" } }, recipientUserIds, response,
            project: async ({ trx: projectionTrx, event }) => {
              if (operation === "add") await repository.addMember(projectionTrx, { conversationId: input.conversationId, userId: input.targetUserId, joinedSeq: event.seq });
              else await repository.changeMember(projectionTrx, { conversationId: input.conversationId, userId: input.targetUserId, operation, role });
            },
          };
        },
      });
    },
  });
}
