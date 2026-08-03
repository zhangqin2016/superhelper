#!/usr/bin/env node
// Enterprise Organizations — pure-logic tests (no database required).
// Covers the Phase 1 verification gate in docs/enterprise-organizations-design.md §9:
// membership state machine, quota selection, org-pool fallback, fetchUserGrants
// filter regression, member quota, and the existing personal-path regression.

import assert from "node:assert/strict";
import fs from "node:fs";

process.env.DATABASE_URL ||= "postgres://unused:unused@localhost:5432/unused";

const {
  ORG_ROLES,
  ORG_MEMBER_STATUSES,
  ORG_STATUSES,
  roleAtLeast,
  canChangeMemberRole,
  canManageMember,
  normalizeQuota,
  orgConsumptionDecision,
} = await import("../server/src/services/enterprise.js");
const { selectGrantsForConsumption } = await import("../server/src/services/wallet.js");

// ---------- constants ----------
assert.ok(ORG_ROLES.has("owner") && ORG_ROLES.has("admin") && ORG_ROLES.has("member"));
assert.ok(ORG_MEMBER_STATUSES.has("active") && ORG_MEMBER_STATUSES.has("disabled"));
assert.ok(ORG_STATUSES.has("active") && ORG_STATUSES.has("disabled"));

// ---------- roleAtLeast ----------
assert.equal(roleAtLeast("owner", "admin"), true);
assert.equal(roleAtLeast("admin", "owner"), false);
assert.equal(roleAtLeast("member", "member"), true);
assert.equal(roleAtLeast("member", "admin"), false);
assert.equal(roleAtLeast("", "member"), false);

// ---------- canChangeMemberRole ----------
// invalid roles rejected
assert.deepEqual(canChangeMemberRole("bogus", "admin", "owner"), { ok: false, code: "ORG_ROLE_INVALID" });
assert.deepEqual(canChangeMemberRole("member", "bogus", "owner"), { ok: false, code: "ORG_ROLE_INVALID" });
// no role change = ok
assert.deepEqual(canChangeMemberRole("member", undefined, "member"), { ok: true });
// only owner may demote an owner
assert.deepEqual(canChangeMemberRole("owner", "member", "admin"), { ok: false, code: "ORG_OWNER_IMMUTABLE" });
assert.deepEqual(canChangeMemberRole("owner", "member", "owner"), { ok: true });
// only owner may promote to owner
assert.deepEqual(canChangeMemberRole("member", "owner", "admin"), { ok: false, code: "ORG_PROMOTE_FORBIDDEN" });
assert.deepEqual(canChangeMemberRole("member", "owner", "owner"), { ok: true });
// plain member cannot change roles at all
assert.deepEqual(canChangeMemberRole("member", "admin", "member"), { ok: false, code: "ORG_FORBIDDEN" });
// admin may change member <-> admin
assert.deepEqual(canChangeMemberRole("member", "admin", "admin"), { ok: true });
assert.deepEqual(canChangeMemberRole("admin", "member", "admin"), { ok: true });

// ---------- canManageMember ----------
// member cannot manage
assert.deepEqual(
  canManageMember({ actorRole: "member", targetRole: "member", action: "remove", self: false }),
  { ok: false, code: "ORG_FORBIDDEN" },
);
// cannot remove self
assert.deepEqual(
  canManageMember({ actorRole: "admin", targetRole: "admin", action: "remove", self: true }),
  { ok: false, code: "ORG_SELF_REMOVE_FORBIDDEN" },
);
// only owner can remove an owner
assert.deepEqual(
  canManageMember({ actorRole: "admin", targetRole: "owner", action: "remove", self: false }),
  { ok: false, code: "ORG_OWNER_IMMUTABLE" },
);
assert.deepEqual(
  canManageMember({ actorRole: "owner", targetRole: "owner", action: "remove", self: false }),
  { ok: true },
);
// only owner can demote an owner
assert.deepEqual(
  canManageMember({ actorRole: "admin", targetRole: "owner", action: "demote", self: false }),
  { ok: false, code: "ORG_OWNER_IMMUTABLE" },
);
// admin may remove a plain member
assert.deepEqual(
  canManageMember({ actorRole: "admin", targetRole: "member", action: "remove", self: false }),
  { ok: true },
);

// ---------- normalizeQuota ----------
assert.equal(normalizeQuota(undefined), null);
assert.equal(normalizeQuota(null), null);
assert.equal(normalizeQuota(""), null);
assert.equal(normalizeQuota("100"), 100);
assert.equal(normalizeQuota(42.9), 42);
assert.equal(normalizeQuota(-5), null);
assert.equal(normalizeQuota("abc"), null);

// ---------- orgConsumptionDecision ----------
assert.deepEqual(
  orgConsumptionDecision({ memberStatus: "active", orgStatus: "disabled" }),
  { ok: false, code: "ORG_DISABLED" },
);
assert.deepEqual(
  orgConsumptionDecision({ memberStatus: "disabled", orgStatus: "active" }),
  { ok: false, code: "ORG_MEMBER_DISABLED" },
);
assert.deepEqual(
  orgConsumptionDecision({ memberStatus: "active", orgStatus: "active", quota: 100, requestedUnits: 50 }),
  { ok: true, cap: 100 },
);
assert.deepEqual(
  orgConsumptionDecision({ memberStatus: "active", orgStatus: "active", quota: 100, requestedUnits: 150 }),
  { ok: false, code: "ORG_MEMBER_QUOTA_EXCEEDED", cap: 100, requestedUnits: 150 },
);
assert.deepEqual(
  orgConsumptionDecision({ memberStatus: "active", orgStatus: "active", quota: null, requestedUnits: 9999 }),
  { ok: true, cap: null },
);

// ---------- selectGrantsForConsumption (personal path regression) ----------
const now = new Date("2026-08-03T00:00:00Z");
const grant = (over = {}) => ({
  id: "grant_x",
  status: "active",
  resource_type: "token",
  unit_remaining: 500,
  token_remaining: 500,
  starts_at: "2026-01-01T00:00:00Z",
  expires_at: "2026-12-31T00:00:00Z",
  ...over,
});

// membership covers everything
assert.deepEqual(
  selectGrantsForConsumption([grant({ resource_type: "membership" })], { resourceType: "token", units: 100, now }),
  { ok: true, coveredByMembership: true, debits: [], units: 100 },
);
// plain consume
const plain = selectGrantsForConsumption([grant()], { resourceType: "token", units: 100, now });
assert.equal(plain.ok, true);
assert.equal(plain.debits.length, 1);
assert.equal(plain.debits[0].units, 100);
// insufficient
const insufficient = selectGrantsForConsumption([grant({ unit_remaining: 10 })], { resourceType: "token", units: 100, now });
assert.equal(insufficient.ok, false);
assert.equal(insufficient.code, "ENTITLEMENT_INSUFFICIENT");
assert.equal(insufficient.availableUnits, 10);
// expired grants ignored
const expired = selectGrantsForConsumption([grant({ expires_at: "2020-01-01T00:00:00Z" })], { resourceType: "token", units: 10, now });
assert.equal(expired.ok, false);
// wrong resource type ignored
const wrongType = selectGrantsForConsumption([grant({ resource_type: "image_generation" })], { resourceType: "token", units: 10, now });
assert.equal(wrongType.ok, false);
// org grant (organization_id set) is IGNORED by the personal selector
const orgGrantMixed = selectGrantsForConsumption(
  [grant(), grant({ id: "grant_org", organization_id: "org_1", unit_remaining: 99999 })],
  { resourceType: "token", units: 100, now },
);
assert.equal(orgGrantMixed.ok, true);
assert.equal(orgGrantMixed.debits.length, 1, "org grants must not leak into personal selection");

// ---------- source wiring checks (regression guards) ----------
const walletSource = fs.readFileSync(new URL("../server/src/services/wallet.js", import.meta.url), "utf8");
assert.match(walletSource, /where\("organization_id", "is", null\)/, "fetchUserGrants must filter org grants");
assert.match(walletSource, /organizationId/, "consumeEntitlement must accept organizationId");
assert.match(walletSource, /resolveOrgForConsumption/, "resolveOrgForConsumption must exist and be wired");
assert.match(walletSource, /organization_id: usedOrganization \? organizationId : null/, "usage_events must record org attribution");

const migrationSource = fs.readFileSync(new URL("../server/migrations/028_enterprise_organizations.sql", import.meta.url), "utf8");
assert.match(migrationSource, /create table if not exists organizations/, "migration 028 must create organizations");
assert.match(migrationSource, /create table if not exists organization_members/, "migration 028 must create organization_members");
assert.match(migrationSource, /add column if not exists organization_id/, "migration 028 must add org columns");
assert.match(migrationSource, /quota integer/, "migration 028 must add member quota column");

console.log("enterprise-orgs: ok");
