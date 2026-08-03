import { db } from "../../db.js";
import { roleAtLeast } from "../../services/enterprise.js";

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
