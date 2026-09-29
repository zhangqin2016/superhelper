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

// ------------------------------------------------------------ two-layer switch

/**
 * Why an organization is not usable, or "" when it is. The platform's freeze
 * wins over the enterprise's own pause: it is the one the enterprise cannot
 * lift, so it is the one to name.
 */
export function orgUnavailableCode({ status, platform_status: platformStatus, owner_status: ownerStatus } = {}) {
  if (platformStatus === "suspended") return "ORG_SUSPENDED";
  if (ownerStatus === "disabled" || status !== "active") return "ORG_DISABLED";
  return "";
}

/** The effective status the database derives (organizations_status_derived_ck). */
export function effectiveOrgStatus({ ownerStatus = "active", platformStatus = "active" } = {}) {
  return ownerStatus === "active" && platformStatus === "active" ? "active" : "disabled";
}

// ------------------------------------------------------------ weekly budget

export const WEEKLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** The member's own budget, else the organization default, else unlimited (null). */
export function effectiveWeeklyBudget(memberBudget, orgDefault) {
  if (memberBudget !== null && memberBudget !== undefined) return Math.max(0, Math.trunc(Number(memberBudget)));
  if (orgDefault !== null && orgDefault !== undefined) return Math.max(0, Math.trunc(Number(orgDefault)));
  return null;
}

/**
 * The member's current weekly window. A window starts at the first charge after
 * the previous one ended and lasts 7 days — the way a weekly usage limit resets
 * — so an idle week does not leave a stale "used" behind.
 */
export function weeklyWindow({ windowStartedAt = null, used = 0, now = new Date() } = {}) {
  const startMs = windowStartedAt ? new Date(windowStartedAt).getTime() : NaN;
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(startMs) || nowMs >= startMs + WEEKLY_WINDOW_MS) {
    return { fresh: true, startedAt: null, used: 0, resetsAt: null };
  }
  return { fresh: false, startedAt: new Date(startMs), used: Math.max(0, Number(used || 0)), resetsAt: new Date(startMs + WEEKLY_WINDOW_MS) };
}

/**
 * May a new request start under this weekly budget? Like a weekly usage limit,
 * the gate is "is anything left", not "does this whole request fit": the request
 * that crosses the line completes, the next one waits for the reset.
 */
export function weeklyBudgetDecision({ budget = null, windowStartedAt = null, used = 0, now = new Date() } = {}) {
  const window = weeklyWindow({ windowStartedAt, used, now });
  if (budget === null || budget === undefined) return { ok: true, budget: null, used: window.used, resetsAt: window.resetsAt };
  if (window.used >= Number(budget)) {
    return { ok: false, code: "ORG_MEMBER_WEEKLY_LIMIT", budget: Number(budget), used: window.used, resetsAt: window.resetsAt };
  }
  return { ok: true, budget: Number(budget), used: window.used, resetsAt: window.resetsAt };
}

/** Window columns after charging `units` (starts a new window when the old one ended). */
export function weeklyWindowAfterCharge({ windowStartedAt = null, used = 0, units = 0, now = new Date() } = {}) {
  const window = weeklyWindow({ windowStartedAt, used, now });
  const startedAt = window.fresh ? new Date(now) : window.startedAt;
  return { weekly_window_started_at: startedAt, weekly_used: window.used + Math.max(0, Math.trunc(Number(units || 0))) };
}

// ------------------------------------------------------------ peer guard

/**
 * Admins run the roster; they do not act on each other. Disabling, removing,
 * re-roling or resetting the password of another admin is the owner's call —
 * a password reset on a peer is otherwise an account takeover.
 */
export function canActOnPeer({ actorRole, targetRole, self = false }) {
  if (self) return { ok: true };
  if (targetRole === "owner" && actorRole !== "owner") return { ok: false, code: "ORG_OWNER_IMMUTABLE" };
  if (targetRole === "admin" && actorRole !== "owner") return { ok: false, code: "ORG_ADMIN_PEER_FORBIDDEN" };
  return { ok: true };
}
