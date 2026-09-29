import { sql } from "kysely";
import { canActOnPeer, canChangeMemberRole, canManageMember, effectiveOrgStatus, normalizeQuota, roleAtLeast } from "./enterprise.js";
import { addMemberTarget, createInvitation, redeemDeferredForOrganization } from "./enterprise-invitations.js";
import { provisionAccounts, resetIssuedPassword, ownedAccountStatusAfterMembership } from "./enterprise-accounts.js";
import { normalizePhoneE164 } from "./account-auth.js";
import { createKyselyConversationRepository } from "./collaboration/conversation-repository.js";
import { writeEnterpriseEvents } from "./collaboration/enterprise-events.js";

function fail(code, statusCode = 403) { throw Object.assign(new Error(code), { code, statusCode }); }
const activeIds = (members) => members.filter((member) => member.status === "active").map((member) => member.user_id).sort();
function requireAllowed(result) { if (!result.ok) fail(result.code); }
function normalizeBudget(value) {
  if (value === null || value === "") return null;
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n < 0) fail("WEEKLY_BUDGET_INVALID", 400);
  return n;
}

/** All enterprise membership/status entry points share collaboration's locks. */
export function createEnterpriseMutationService(database) {
  const repository = createKyselyConversationRepository(database);
  async function mutate({ organizationId, account, adminActor, authorizeAdmin, minRole = "admin", meta = {} }, operation) {
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
        const user = await trx.selectFrom("users").select(["status", "password_must_change"]).where("id", "=", account.userId).forShare().executeTakeFirst();
        if (!user || user.status !== "active") fail("USER_DISABLED");
        if (user.password_must_change) fail("PASSWORD_CHANGE_REQUIRED");
        membership = scope.organizationMembers.find((member) => member.user_id === account.userId);
        if (!membership) fail("ORG_MEMBER_REQUIRED");
        if (membership.status !== "active") fail("ORG_MEMBER_DISABLED");
        if (!roleAtLeast(membership.role, minRole)) fail("ORG_FORBIDDEN");
        actor = { source: "enterprise-web", userId: account.userId };
      }
      if (!scope.organization) fail("ORG_NOT_FOUND", 404);
      // Every enterprise-side change leaves the same audit_logs row the platform
      // console writes, in the SAME transaction: a change without a trail cannot
      // commit. (Member, account and org changes made here used to leave none.)
      const recordAudit = async (action, metadata = {}) => {
        if (adminActor) return; // the platform routes audit their own calls
        await trx.insertInto("audit_logs").values({
          actor: `user:${account.userId}`,
          action,
          target_type: "organization",
          target_id: organizationId,
          ip: meta.ip || null,
          user_agent: meta.userAgent || null,
          metadata: JSON.stringify({ role: membership?.role, ...metadata }),
        }).execute();
      };
      return operation({ trx, ...scope, membership, actor, organizationId, recordAudit });
    });
  }
  async function notify(context, { revoke = [], directory = [], reason }) {
    await writeEnterpriseEvents(context.trx, { actor: context.actor, organizationId: context.organizationId, revokedUserIds: revoke, directoryUserIds: directory, reason });
  }
  async function restoreOwnedAccount(trx, organizationId, userId) {
    const user = await trx.selectFrom("users").select(["id", "provisioned_organization_id", "status"]).where("id", "=", userId).executeTakeFirst();
    const owned = ownedAccountStatusAfterMembership({ provisionedOrganizationId: user?.provisioned_organization_id || null, organizationId, memberStatus: "active" });
    if (owned && user.status !== owned) await trx.updateTable("users").set({ status: owned }).where("id", "=", userId).execute();
  }
  return Object.freeze({
    addMember(options, input) {
      return mutate(options, async (context) => {
        const { trx, organizationId, organization, organizationMembers, membership, recordAudit } = context;
        let targetUserId = input.userId;
        let existingUserId = "";
        // Stored the way login stores it (+86…): an invitation for a typed
        // 138… could never match the phone a login writes, so the seat was never
        // granted and a registered person got a dead invitation instead of a seat.
        const phoneE164 = input.phoneE164 ? normalizePhoneE164(input.phoneE164) : "";
        if (input.phoneE164 && !phoneE164) fail("INVALID_PHONE", 400);
        if (!targetUserId && phoneE164) {
          const user = await trx.selectFrom("users").select("id").where("phone_e164", "=", phoneE164).executeTakeFirst();
          existingUserId = user?.id || "";
          targetUserId = existingUserId;
        } else if (targetUserId) {
          const user = await trx.selectFrom("users").select("id").where("id", "=", targetUserId).executeTakeFirst();
          if (!user) fail("USER_NOT_FOUND", 404);
        }
        // An unregistered phone used to be a dead end (USER_NOT_FOUND), so a
        // company could not hand out the seats it had paid for until every
        // employee had signed up. Record the intent instead and grant the seat
        // at that person's next login.
        const target = addMemberTarget({ userId: input.userId, phoneE164, existingUserId });
        if (target.kind === "error") fail(target.code, 400);
        if (target.kind === "invite") {
          // Ownership cannot be handed to someone who has no account yet.
          // Without this the role would be silently normalised to "member",
          // which is a downgrade the caller never asked for.
          if (input.role === "owner") fail("INVITE_ROLE_UNSUPPORTED", 400);
          requireAllowed(canChangeMemberRole("member", input.role, membership.role));
          const invitation = await createInvitation(trx, {
            organizationId,
            phoneE164,
            role: input.role,
            invitedBy: options.account?.userId || null,
          });
          await recordAudit("enterprise_invitation_create", { invitationId: invitation.id, invitedRole: invitation.role });
          return { ok: true, invitation };
        }
        if (!targetUserId) fail("MEMBER_TARGET_REQUIRED", 400);
        if (organizationMembers.some((member) => member.user_id === targetUserId)) fail("MEMBER_ALREADY_EXISTS", 409);
        requireAllowed(canChangeMemberRole("member", input.role, membership.role));
        const member = await trx.insertInto("organization_members").values({ organization_id: organizationId, user_id: targetUserId, role: input.role, status: "active", quota: null }).returningAll().executeTakeFirstOrThrow();
        // An account this org issued and later removed was locked with it;
        // bringing it back into the org brings its login back.
        await restoreOwnedAccount(trx, organizationId, targetUserId);
        if (organization.status === "active") await notify(context, { directory: [...activeIds(organizationMembers), targetUserId] });
        await recordAudit("enterprise_member_add", { userId: targetUserId, memberRole: input.role });
        return { ok: true, member };
      });
    },
    /**
     * Issue dedicated accounts for staff. Returns each initial password ONCE.
     * Same lock and admin gate as every other membership mutation.
     */
    provisionAccounts(options, input) {
      return mutate(options, async (context) => {
        const { trx, organizationId, organization, organizationMembers, membership, recordAudit } = context;
        if (organization.status !== "active") fail(organization.platform_status === "suspended" ? "ORG_SUSPENDED" : "ORG_DISABLED");
        const requests = Array.isArray(input?.accounts) ? input.accounts : [];
        const pattern = input?.pattern && input.pattern.prefix ? input.pattern : null;
        if (!requests.length && !pattern) fail("ACCOUNTS_REQUIRED", 400);
        if (pattern?.role === "owner") fail("INVITE_ROLE_UNSUPPORTED", 400);
        if (pattern) requireAllowed(canChangeMemberRole("member", pattern.role || "member", membership.role));
        for (const request of requests) {
          // An admin may issue member or admin accounts, never owner — and only
          // roles they could assign by hand.
          if (request?.role === "owner") fail("INVITE_ROLE_UNSUPPORTED", 400);
          requireAllowed(canChangeMemberRole("member", request?.role || "member", membership.role));
        }
        const issued = await provisionAccounts(trx, {
          organizationId,
          organizationName: organization.name,
          requests,
          pattern,
          provisionedBy: options.account?.userId || null,
        });
        await notify(context, { directory: [...activeIds(organizationMembers), ...issued.map((row) => row.userId)] });
        await recordAudit("enterprise_accounts_issue", { count: issued.length, userIds: issued.map((row) => row.userId) });
        return { ok: true, accounts: issued };
      });
    },
    /** New one-time password for an issued account; the old one dies now. */
    resetIssuedPassword(options, targetUserId) {
      return mutate(options, async (context) => {
        const { trx, organizationId, organizationMembers, membership, recordAudit } = context;
        const target = organizationMembers.find((member) => member.user_id === targetUserId);
        if (!target) fail("MEMBER_NOT_FOUND", 404);
        requireAllowed(canActOnPeer({ actorRole: membership.role, targetRole: target.role, self: targetUserId === options.account.userId }));
        const result = await resetIssuedPassword(trx, { organizationId, userId: targetUserId });
        await recordAudit("enterprise_account_password_reset", { userId: targetUserId });
        return { ok: true, ...result };
      });
    },
    /** Withdraw an open seat invitation. Same lock and role gate as members. */
    revokeInvitation(options, invitationId) {
      return mutate(options, async (context) => {
        const { trx, organizationId, recordAudit } = context;
        const invitation = await trx
          .selectFrom("organization_invitations")
          .selectAll()
          .where("id", "=", invitationId)
          .where("organization_id", "=", organizationId)
          .where("status", "=", "pending")
          .forUpdate()
          .executeTakeFirst();
        if (!invitation) fail("INVITATION_NOT_FOUND", 404);
        await trx
          .updateTable("organization_invitations")
          .set({ status: "revoked" })
          .where("id", "=", invitation.id)
          .execute();
        await recordAudit("enterprise_invitation_revoke", { invitationId });
        return { ok: true, revoked: true };
      });
    },
    changeMember(options, targetUserId, input, remove = false) {
      return mutate(options, async (context) => {
        const { trx, organizationId, organization, organizationMembers, membership, recordAudit } = context;
        const target = organizationMembers.find((member) => member.user_id === targetUserId);
        if (!target) fail("MEMBER_NOT_FOUND", 404);
        const isSelf = targetUserId === options.account.userId;
        requireAllowed(canActOnPeer({ actorRole: membership.role, targetRole: target.role, self: isSelf }));
        if (input.role !== undefined && input.role !== target.role) {
          requireAllowed(canChangeMemberRole(target.role, input.role, membership.role));
          // An owner may step down only while another active owner remains —
          // an organization must never be left with nobody who can run it.
          if (target.role === "owner" && input.role !== "owner"
            && !organizationMembers.some((member) => member.user_id !== targetUserId && member.role === "owner" && member.status === "active")) {
            fail("ORG_LAST_OWNER", 409);
          }
        }
        if (remove || input.status !== undefined && input.status !== "active") requireAllowed(canManageMember({ actorRole: membership.role, targetRole: target.role, action: "remove", self: isSelf }));
        const nextStatus = remove ? "removed" : input.status ?? target.status;
        const lostAccess = organization.status === "active" && target.status === "active" && nextStatus !== "active";
        const changed = remove || nextStatus !== target.status || input.role !== undefined && input.role !== target.role;
        let member;
        // An account the company issued belongs to the company. Taking it out
        // of the org, or disabling it there, must also lock the login itself —
        // otherwise a removed employee keeps a working account with nothing
        // attached to it. A phone user who merely joined keeps their own.
        const targetUser = await trx.selectFrom("users").select(["id", "provisioned_organization_id"]).where("id", "=", targetUserId).executeTakeFirst();
        const ownedStatus = ownedAccountStatusAfterMembership({
          provisionedOrganizationId: targetUser?.provisioned_organization_id || null,
          organizationId,
          memberStatus: remove ? "removed" : nextStatus,
        });
        if (ownedStatus) await trx.updateTable("users").set({ status: ownedStatus }).where("id", "=", targetUserId).execute();
        if (remove) await trx.deleteFrom("organization_members").where("organization_id", "=", organizationId).where("user_id", "=", targetUserId).execute();
        else member = await trx.updateTable("organization_members").set({
          ...(input.role !== undefined ? { role: input.role } : {}), ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.memberQuota !== undefined ? { quota: normalizeQuota(input.memberQuota) } : {}),
          ...(input.weeklyBudget !== undefined ? { weekly_budget: normalizeBudget(input.weeklyBudget) } : {}),
        }).where("organization_id", "=", organizationId).where("user_id", "=", targetUserId).returningAll().executeTakeFirstOrThrow();
        const directory = changed && organization.status === "active" ? [...activeIds(organizationMembers).filter((id) => id !== targetUserId), ...(nextStatus === "active" ? [targetUserId] : [])] : [];
        await notify(context, { revoke: lostAccess ? [targetUserId] : [], directory, reason: remove ? "membership-removed" : "membership-disabled" });
        await recordAudit(remove ? "enterprise_member_remove" : "enterprise_member_change", {
          userId: targetUserId,
          ...(input.role !== undefined ? { memberRole: input.role, previousRole: target.role } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.memberQuota !== undefined ? { memberQuota: input.memberQuota } : {}),
          ...(input.weeklyBudget !== undefined ? { weeklyBudget: input.weeklyBudget } : {}),
        });
        return remove ? { ok: true, removed: true } : { ok: true, member };
      });
    },
    /** Hand ownership to an active member in one step: they become owner, the caller admin. */
    transferOwnership(options, targetUserId) {
      return mutate({ ...options, minRole: "owner" }, async (context) => {
        const { trx, organizationId, organizationMembers, recordAudit } = context;
        const selfId = options.account.userId;
        const target = organizationMembers.find((member) => member.user_id === targetUserId);
        if (!target || targetUserId === selfId) fail("MEMBER_NOT_FOUND", 404);
        if (target.status !== "active") fail("ORG_MEMBER_DISABLED", 409);
        await trx.updateTable("organization_members").set({ role: "owner" }).where("organization_id", "=", organizationId).where("user_id", "=", targetUserId).execute();
        await trx.updateTable("organization_members").set({ role: "admin" }).where("organization_id", "=", organizationId).where("user_id", "=", selfId).execute();
        await notify(context, { directory: activeIds(organizationMembers) });
        await recordAudit("enterprise_owner_transfer", { toUserId: targetUserId, fromUserId: selfId });
        return { ok: true, transferred: true };
      });
    },
    /** A member leaves on their own. Nobody could, so a person could never get out of an org. */
    leaveOrganization(options) {
      return mutate({ ...options, minRole: "member" }, async (context) => {
        const { trx, organizationId, organization, organizationMembers, membership, recordAudit } = context;
        const selfId = options.account.userId;
        if (membership.role === "owner" && !organizationMembers.some((member) => member.user_id !== selfId && member.role === "owner" && member.status === "active")) {
          fail("ORG_LAST_OWNER", 409);
        }
        // An issued account exists only for this org: leaving would lock the
        // person out of their only login. The org removes it instead.
        const user = await trx.selectFrom("users").select(["provisioned_organization_id"]).where("id", "=", selfId).executeTakeFirst();
        if (user?.provisioned_organization_id === organizationId) fail("ORG_ISSUED_ACCOUNT_CANNOT_LEAVE", 409);
        await trx.deleteFrom("organization_members").where("organization_id", "=", organizationId).where("user_id", "=", selfId).execute();
        if (organization.status === "active") await notify(context, { revoke: [selfId], directory: activeIds(organizationMembers).filter((id) => id !== selfId), reason: "membership-removed" });
        await recordAudit("enterprise_member_leave", { userId: selfId });
        return { ok: true, left: true };
      });
    },
    /**
     * Two-layer switch. The enterprise pauses/resumes its own org (owner only)
     * and may rename it / set the member weekly default (admin+). The platform
     * freezes/unfreezes (platformStatus). The effective `status` is derived —
     * so an enterprise resuming its own pause can never lift a platform freeze.
     */
    changeOrganization(options, input) {
      const enterpriseSide = !options.adminActor;
      const minRole = enterpriseSide && input.status !== undefined ? "owner" : "admin";
      return mutate({ ...options, minRole }, async (context) => {
        const { trx, organization, organizationId, organizationMembers, recordAudit } = context;
        if (enterpriseSide && input.platformStatus !== undefined) fail("ORG_FORBIDDEN");
        const ownerStatus = enterpriseSide && input.status !== undefined ? input.status : organization.owner_status;
        const platformStatus = !enterpriseSide && input.platformStatus !== undefined ? input.platformStatus : organization.platform_status;
        const status = effectiveOrgStatus({ ownerStatus, platformStatus });
        const updated = await trx.updateTable("organizations").set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.defaultMemberWeeklyBudget !== undefined ? { default_member_weekly_budget: normalizeBudget(input.defaultMemberWeeklyBudget) } : {}),
          owner_status: ownerStatus,
          platform_status: platformStatus,
          ...(platformStatus !== organization.platform_status ? { platform_status_changed_at: sql`now()`, platform_status_reason: input.reason ?? null } : {}),
          status,
          updated_at: sql`now()`,
        }).where("id", "=", organizationId).returningAll().executeTakeFirstOrThrow();
        const users = activeIds(organizationMembers);
        if (organization.status !== "active" && updated.status === "active") users.push(...await redeemDeferredForOrganization(trx, organizationId));
        if (organization.status === "active" && updated.status === "disabled") await notify(context, { revoke: users, reason: "organization-disabled" });
        else if (updated.status === "active" && (organization.status !== updated.status || organization.name !== updated.name)) await notify(context, { directory: users });
        await recordAudit("enterprise_org_change", {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.status !== undefined ? { ownerStatus: input.status } : {}),
          ...(input.defaultMemberWeeklyBudget !== undefined ? { defaultMemberWeeklyBudget: input.defaultMemberWeeklyBudget } : {}),
        });
        return { ok: true, organization: updated };
      });
    },
  });
}
