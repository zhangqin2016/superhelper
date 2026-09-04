import { publicId } from "./ids.js";

/**
 * Enterprise seat invitations: assign a seat to staff who have no account yet.
 *
 * `addMember` accepts `{userId | phoneE164}` and could only ever attach an
 * EXISTING user, because organization_members references users(id). An
 * unregistered phone returned USER_NOT_FOUND, so a company that bought 50
 * seats had to wait for each employee to sign up before adding them one by
 * one. An invitation records the intent instead, and the seat is granted at
 * that person's next successful login.
 *
 * The decision logic is pure and exported separately from the queries, so the
 * rules can be tested without a database.
 */

/** Roles an invitation may carry. Ownership is never transferable this way. */
export const INVITABLE_ROLES = Object.freeze(["admin", "member"]);

/**
 * Should a pending invitation become a membership right now?
 *
 * Pure. Redemption runs on every login, so it must be idempotent and must
 * decide, per invitation, between granting the seat, consuming the invitation
 * without granting, and leaving it pending for a later attempt.
 *
 * @param {{ organizationStatus?: string, alreadyMember?: boolean }} state
 * @returns {{ action: "grant" | "consume" | "defer", reason: string }}
 */
export function redemptionDecision(state = {}) {
  const organizationStatus = String(state.organizationStatus || "");
  if (!organizationStatus) return { action: "defer", reason: "ORG_MISSING" };
  // A disabled organization may be re-enabled, and the seat was paid for.
  // Deferring keeps the invitation redeemable instead of burning it.
  if (organizationStatus !== "active") return { action: "defer", reason: "ORG_DISABLED" };
  // Already a member (added by hand between invite and login): the invitation
  // has served its purpose and must not fight the existing row.
  if (state.alreadyMember) return { action: "consume", reason: "ALREADY_MEMBER" };
  return { action: "grant", reason: "OK" };
}

/**
 * What POST members should do with the target it was given.
 *
 * Pure. Keeping this out of the query path is what lets the "unregistered
 * phone" branch be tested without a users table.
 *
 * @returns {{ kind: "member" | "invite" | "error", code?: string }}
 */
export function addMemberTarget({ userId = "", phoneE164 = "", existingUserId = "" } = {}) {
  if (userId) return { kind: "member" };
  if (!phoneE164) return { kind: "error", code: "MEMBER_TARGET_REQUIRED" };
  // A registered phone still becomes a direct membership — inviting someone
  // who could be added now would make them wait for a login they do not need.
  if (existingUserId) return { kind: "member" };
  return { kind: "invite" };
}

/** Create (or refresh) the open invitation for a phone on an organization. */
export async function createInvitation(trx, { organizationId, phoneE164, role, invitedBy }) {
  const normalizedRole = INVITABLE_ROLES.includes(role) ? role : "member";
  const existing = await trx
    .selectFrom("organization_invitations")
    .selectAll()
    .where("organization_id", "=", organizationId)
    .where("phone_e164", "=", phoneE164)
    .where("status", "=", "pending")
    .executeTakeFirst();
  if (existing) {
    // Re-inviting with a different role updates the open invitation rather
    // than colliding with the partial unique index.
    if (existing.role === normalizedRole) return existing;
    return trx
      .updateTable("organization_invitations")
      .set({ role: normalizedRole, invited_by: invitedBy || null })
      .where("id", "=", existing.id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }
  return trx
    .insertInto("organization_invitations")
    .values({
      id: publicId("inv"),
      organization_id: organizationId,
      phone_e164: phoneE164,
      role: normalizedRole,
      status: "pending",
      invited_by: invitedBy || null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** Open invitations for an organization, newest first. */
export async function listInvitations(database, organizationId) {
  return database
    .selectFrom("organization_invitations")
    .select(["id", "phone_e164", "role", "status", "created_at", "invited_by"])
    .where("organization_id", "=", organizationId)
    .where("status", "=", "pending")
    .orderBy("created_at", "desc")
    .execute();
}

/**
 * Grant every seat waiting for this phone.
 *
 * Runs AFTER the login transaction commits, in its own transaction: a login
 * must never fail because a seat could not be granted. An invitation left
 * pending is retried at the next login, so the worst case is a delay.
 *
 * @returns {Promise<{ granted: string[], consumed: string[], deferred: string[] }>}
 */
export async function redeemInvitationsForPhone(database, { userId, phoneE164 }) {
  const result = { granted: [], consumed: [], deferred: [] };
  if (!userId || !phoneE164) return result;
  const pending = await database
    .selectFrom("organization_invitations")
    .selectAll()
    .where("phone_e164", "=", phoneE164)
    .where("status", "=", "pending")
    .execute();
  if (!pending.length) return result;

  for (const invitation of pending) {
    await database.transaction().execute(async (trx) => {
      // Re-read under the transaction: two devices logging in at once must not
      // both grant the same seat.
      const fresh = await trx
        .selectFrom("organization_invitations")
        .selectAll()
        .where("id", "=", invitation.id)
        .where("status", "=", "pending")
        .forUpdate()
        .executeTakeFirst();
      if (!fresh) return;
      const organization = await trx
        .selectFrom("organizations")
        .select(["id", "status"])
        .where("id", "=", fresh.organization_id)
        .executeTakeFirst();
      const alreadyMember = Boolean(await trx
        .selectFrom("organization_members")
        .select("user_id")
        .where("organization_id", "=", fresh.organization_id)
        .where("user_id", "=", userId)
        .executeTakeFirst());
      const decision = redemptionDecision({ organizationStatus: organization?.status, alreadyMember });
      if (decision.action === "defer") {
        result.deferred.push(fresh.organization_id);
        return;
      }
      if (decision.action === "grant") {
        await trx
          .insertInto("organization_members")
          .values({
            organization_id: fresh.organization_id,
            user_id: userId,
            role: fresh.role,
            status: "active",
            quota: null,
          })
          .onConflict((oc) => oc.columns(["organization_id", "user_id"]).doNothing())
          .execute();
        result.granted.push(fresh.organization_id);
      } else {
        result.consumed.push(fresh.organization_id);
      }
      await trx
        .updateTable("organization_invitations")
        .set({ status: "accepted", accepted_at: new Date(), accepted_user_id: userId })
        .where("id", "=", fresh.id)
        .execute();
    });
  }
  return result;
}
