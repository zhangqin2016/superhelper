import { db } from "../../db.js";
import { roleAtLeast } from "../../services/enterprise.js";

export async function enterpriseMutationResponse(reply, operation) {
  try { return await operation(); } catch (error) {
    if (error.statusCode >= 400 && error.statusCode < 500 && error.code) return reply.code(error.statusCode).send({ ok: false, code: error.code });
    throw error;
  }
}

export async function orgMembership(organizationId, userId) {
  return db
    .selectFrom("organization_members")
    .select(["organization_id", "user_id", "role", "status", "quota", "joined_at"])
    .where("organization_id", "=", organizationId)
    .where("user_id", "=", userId)
    .executeTakeFirst();
}

export async function requireOrgRole(request, reply, organizationId, requiredRole = "member") {
  const membership = await orgMembership(organizationId, request.user.userId);
  if (!membership) {
    reply.code(403).send({ ok: false, code: "ORG_MEMBER_REQUIRED" });
    return null;
  }
  if (membership.status !== "active") {
    reply.code(403).send({ ok: false, code: "ORG_MEMBER_DISABLED" });
    return null;
  }
  if (!roleAtLeast(membership.role, requiredRole)) {
    reply.code(403).send({ ok: false, code: "ORG_FORBIDDEN" });
    return null;
  }
  return membership;
}

/** The mutation scope for an enterprise-side call, carrying what the audit row records. */
export function enterpriseScope(request) {
  return {
    organizationId: request.params.id,
    account: request.user,
    meta: { ip: request.ip || null, userAgent: request.headers["user-agent"] || null },
  };
}

/** 138****5678 — enough for a colleague to recognise, not a directory of numbers. */
export function maskPhone(phone) {
  const value = String(phone || "");
  if (!value) return null;
  const digits = value.replace(/^\+86/, "");
  return digits.length >= 7 ? `${digits.slice(0, 3)}****${digits.slice(-4)}` : "****";
}

/** Everything a member row needs to say WHO it is, not just usr_…. */
export async function memberIdentities(database, userIds) {
  if (!userIds.length) return new Map();
  const rows = await database.selectFrom("users")
    .select(["id", "phone_e164", "login_name", "display_name", "provisioned_organization_id", "status", "last_login_at"])
    .where("id", "in", userIds).execute();
  return new Map(rows.map((row) => [row.id, {
    phone: maskPhone(row.phone_e164),
    loginName: row.login_name || null,
    displayName: row.display_name || null,
    issuedBy: row.provisioned_organization_id || null,
    accountStatus: row.status,
    lastLoginAt: row.last_login_at || null,
  }]));
}
