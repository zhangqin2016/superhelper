// Enterprise Organizations — pure logic for org membership, roles, and quotas.
//
// Everything in this file is side-effect free so it can be unit-tested without
// a database (see scripts/test-enterprise-orgs.mjs). Database access lives in
// the route handlers and in wallet.js consumption path.
//
// Roles: owner > admin > member (see docs/enterprise-organizations-design.md §7).
// Status: active | disabled (per-member), active | disabled (per-org).

export const ORG_ROLES = new Set(["owner", "admin", "member"]);
export const ORG_MEMBER_STATUSES = new Set(["active", "disabled"]);
export const ORG_STATUSES = new Set(["active", "disabled"]);

/** Strict-role hierarchy for the minimum role that may perform an action. */
export const ROLE_RANK = { owner: 3, admin: 2, member: 1 };

/** True when `role` may act as `requiredRole` (role >= required). */
export function roleAtLeast(role, requiredRole) {
  return Number(ROLE_RANK[role] || 0) >= Number(ROLE_RANK[requiredRole] || 0);
}

/**
 * Validate a membership record's role/status transition (pure state machine).
 * Returns { ok: true } or { ok: false, code }.
 */
export function canChangeMemberRole(currentRole, nextRole, actorRole) {
  if (!ORG_ROLES.has(currentRole)) return { ok: false, code: "ORG_ROLE_INVALID" };
  if (nextRole !== undefined && !ORG_ROLES.has(nextRole)) return { ok: false, code: "ORG_ROLE_INVALID" };
  if (nextRole === undefined) return { ok: true };
  // Only owner may promote/demote an owner; owner and admin may change admin/member.
  if (currentRole === "owner" && nextRole !== "owner" && actorRole !== "owner") {
    return { ok: false, code: "ORG_OWNER_IMMUTABLE" };
  }
  if (currentRole === "owner" && nextRole !== "owner" && actorRole === "owner") {
    // allowed: owner demotes self or another owner
    return { ok: true };
  }
  if (currentRole !== "owner" && nextRole === "owner" && actorRole !== "owner") {
    return { ok: false, code: "ORG_PROMOTE_FORBIDDEN" };
  }
  if (!roleAtLeast(actorRole, "admin")) return { ok: false, code: "ORG_FORBIDDEN" };
  return { ok: true };
}

/**
 * Decide whether the caller may act on a member. Guards:
 * - an owner cannot be removed/demoted by anyone but an owner
 * - nobody can remove/demote themselves to below admin (protect the last admin path)
 * - actor must be at least the required role for the action
 */
export function canManageMember({ actorRole, targetRole, action, self }) {
  if (!roleAtLeast(actorRole, "admin")) return { ok: false, code: "ORG_FORBIDDEN" };
  if (action === "remove") {
    if (self) return { ok: false, code: "ORG_SELF_REMOVE_FORBIDDEN" };
    if (targetRole === "owner" && actorRole !== "owner") return { ok: false, code: "ORG_OWNER_IMMUTABLE" };
  }
  if (action === "demote" && targetRole === "owner" && actorRole !== "owner") {
    return { ok: false, code: "ORG_OWNER_IMMUTABLE" };
  }
  return { ok: true };
}

/** Normalize/normalize a member quota (units). Returns null for unlimited. */
export function normalizeQuota(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/**
 * Pure decision for org-pool consumption: whether a member may consume from an
 * org grant, and the cap imposed by the member's quota.
 * Returns { ok: true, cap } or { ok: false, code }.
 */
export function orgConsumptionDecision({ memberStatus, orgStatus, quota = null, requestedUnits = 1 }) {
  if (orgStatus !== "active") return { ok: false, code: "ORG_DISABLED" };
  if (memberStatus !== "active") return { ok: false, code: "ORG_MEMBER_DISABLED" };
  const units = Math.max(1, Math.trunc(Number(requestedUnits || 1)));
  const cap = quota === null || quota === undefined ? null : Math.max(0, Math.trunc(Number(quota)));
  if (cap !== null && units > cap) {
    return { ok: false, code: "ORG_MEMBER_QUOTA_EXCEEDED", cap, requestedUnits: units };
  }
  return { ok: true, cap };
}
