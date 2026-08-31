import { sql } from "kysely";
import { canChangeMemberRole, canManageMember, normalizeQuota, roleAtLeast } from "./enterprise.js";
import { createKyselyConversationRepository } from "./collaboration/conversation-repository.js";
import { writeEnterpriseEvents } from "./collaboration/enterprise-events.js";

function fail(code, statusCode = 403) { throw Object.assign(new Error(code), { code, statusCode }); }
const activeIds = (members) => members.filter((member) => member.status === "active").map((member) => member.user_id).sort();
function requireAllowed(result) { if (!result.ok) fail(result.code); }

/** All enterprise membership/status entry points share collaboration's locks. */
export function createEnterpriseMutationService(database) {
  const repository = createKyselyConversationRepository(database);
  async function mutate({ organizationId, account, adminActor, authorizeAdmin }, operation) {
    return database.transaction().execute(async (trx) => {
      await sql`set local lock_timeout = '2s'`.execute(trx);
      await sql`set local statement_timeout = '8s'`.execute(trx);
      const scope = await repository.lockTeamScope(trx, organizationId);
      let membership, actor;
      if (adminActor) {
        if (typeof authorizeAdmin !== "function" || !await authorizeAdmin()) return null;
        actor = { source: "platform-admin", auditActor: adminActor };
      } else {
        // A session or role may have been revoked after the preHandler while
        // this request waited for the organization lock.
        const session = account?.sessionId && await trx.selectFrom("user_sessions").selectAll()
          .where("id", "=", account.sessionId).forUpdate().executeTakeFirst();
        if (!session || session.user_id !== account?.userId || session.revoked_at || new Date(session.expires_at).getTime() <= Date.now()) fail("USER_LOGIN_REQUIRED", 401);
        membership = scope.organizationMembers.find((member) => member.user_id === account.userId);
        if (!membership) fail("ORG_MEMBER_REQUIRED");
        if (membership.status !== "active") fail("ORG_MEMBER_DISABLED");
        if (!roleAtLeast(membership.role, "admin")) fail("ORG_FORBIDDEN");
        actor = { source: "enterprise-web", userId: account.userId };
      }
      if (!scope.organization) fail("ORG_NOT_FOUND", 404);
      return operation({ trx, ...scope, membership, actor, organizationId });
    });
  }
  async function notify(context, { revoke = [], directory = [], reason }) {
    await writeEnterpriseEvents(context.trx, { actor: context.actor, organizationId: context.organizationId, revokedUserIds: revoke, directoryUserIds: directory, reason });
  }
  return Object.freeze({
    addMember(options, input) {
      return mutate(options, async (context) => {
        const { trx, organizationId, organization, organizationMembers, membership } = context;
        let targetUserId = input.userId;
        if (!targetUserId && input.phoneE164) {
          const user = await trx.selectFrom("users").select("id").where("phone_e164", "=", input.phoneE164).executeTakeFirst();
          if (!user) fail("USER_NOT_FOUND", 404);
          targetUserId = user.id;
        }
        if (!targetUserId) fail("MEMBER_TARGET_REQUIRED", 400);
        if (organizationMembers.some((member) => member.user_id === targetUserId)) fail("MEMBER_ALREADY_EXISTS", 409);
        requireAllowed(canChangeMemberRole("member", input.role, membership.role));
        const member = await trx.insertInto("organization_members").values({ organization_id: organizationId, user_id: targetUserId, role: input.role, status: "active", quota: null }).returningAll().executeTakeFirstOrThrow();
        if (organization.status === "active") await notify(context, { directory: [...activeIds(organizationMembers), targetUserId] });
        return { ok: true, member };
      });
    },
    changeMember(options, targetUserId, input, remove = false) {
      return mutate(options, async (context) => {
        const { trx, organizationId, organization, organizationMembers, membership } = context;
        const target = organizationMembers.find((member) => member.user_id === targetUserId);
        if (!target) fail("MEMBER_NOT_FOUND", 404);
        const isSelf = targetUserId === options.account.userId;
        if (input.role !== undefined && input.role !== target.role) {
          requireAllowed(canChangeMemberRole(target.role, input.role, membership.role));
          if (isSelf && input.role !== "owner" && target.role === "owner") fail("ORG_OWNER_IMMUTABLE");
        }
        if (remove || input.status !== undefined && input.status !== "active") requireAllowed(canManageMember({ actorRole: membership.role, targetRole: target.role, action: "remove", self: isSelf }));
        const nextStatus = remove ? "removed" : input.status ?? target.status;
        const lostAccess = organization.status === "active" && target.status === "active" && nextStatus !== "active";
        const changed = remove || nextStatus !== target.status || input.role !== undefined && input.role !== target.role;
        let member;
        if (remove) await trx.deleteFrom("organization_members").where("organization_id", "=", organizationId).where("user_id", "=", targetUserId).execute();
        else member = await trx.updateTable("organization_members").set({
          ...(input.role !== undefined ? { role: input.role } : {}), ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.memberQuota !== undefined ? { quota: normalizeQuota(input.memberQuota) } : {}),
        }).where("organization_id", "=", organizationId).where("user_id", "=", targetUserId).returningAll().executeTakeFirstOrThrow();
        const directory = changed && organization.status === "active" ? [...activeIds(organizationMembers).filter((id) => id !== targetUserId), ...(nextStatus === "active" ? [targetUserId] : [])] : [];
        await notify(context, { revoke: lostAccess ? [targetUserId] : [], directory, reason: remove ? "membership-removed" : "membership-disabled" });
        return remove ? { ok: true, removed: true } : { ok: true, member };
      });
    },
    changeOrganization(options, input) {
      return mutate(options, async (context) => {
        const { trx, organization, organizationId, organizationMembers } = context;
        const updated = await trx.updateTable("organizations").set({ ...(input.name !== undefined ? { name: input.name } : {}), ...(input.status !== undefined ? { status: input.status } : {}), updated_at: sql`now()` })
          .where("id", "=", organizationId).returningAll().executeTakeFirstOrThrow();
        const users = activeIds(organizationMembers);
        if (organization.status === "active" && updated.status === "disabled") await notify(context, { revoke: users, reason: "organization-disabled" });
        else if (updated.status === "active" && (organization.status !== updated.status || organization.name !== updated.name)) await notify(context, { directory: users });
        return { ok: true, organization: updated };
      });
    },
  });
}
