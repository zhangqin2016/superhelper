#!/usr/bin/env node
// Enterprise seat invitations — pure-logic tests (no database required).
//
// The gap: POST /api/enterprise/organizations/:id/members accepts
// {userId | phoneE164} but organization_members references users(id), so an
// unregistered phone returned USER_NOT_FOUND (404). A company that bought 50
// seats had to wait for every employee to sign up and then add them one at a
// time — there was no way to hand out a seat in advance. The design doc never
// covered the case (no mention of 邀请 / invite / provisioning anywhere).
//
// An invitation records the intent, and the seat is granted at that person's
// next successful login. The rules below are the part that decides whether a
// seat is granted, consumed, or left for later, and they are pure so they can
// be held to account without a database.

import assert from "node:assert/strict";
import fs from "node:fs";

process.env.DATABASE_URL ||= "postgres://unused:unused@localhost:5432/unused";

const { addMemberTarget, redemptionDecision, INVITABLE_ROLES } = await import(
  new URL("../server/src/services/enterprise-invitations.js", import.meta.url)
);

// ---------- what POST members does with its target ----------

assert.deepEqual(addMemberTarget({ userId: "usr_1" }), { kind: "member" }, "an explicit userId is a direct membership");
assert.deepEqual(
  addMemberTarget({ phoneE164: "+8613800000000", existingUserId: "usr_2" }),
  { kind: "member" },
  "a REGISTERED phone must still become a membership immediately — inviting someone who can be added now would make them wait for a login they do not need",
);
assert.deepEqual(
  addMemberTarget({ phoneE164: "+8613800000000" }),
  { kind: "invite" },
  "an unregistered phone is the case that used to fail with USER_NOT_FOUND",
);
assert.deepEqual(
  addMemberTarget({}),
  { kind: "error", code: "MEMBER_TARGET_REQUIRED" },
  "neither target given must still be an error, not an invitation to nobody",
);
assert.deepEqual(addMemberTarget({ phoneE164: "" }), { kind: "error", code: "MEMBER_TARGET_REQUIRED" }, "an empty phone is not a target");

// ---------- when a pending invitation becomes a seat ----------

assert.deepEqual(
  redemptionDecision({ organizationStatus: "active" }),
  { action: "grant", reason: "OK" },
  "an active org and a non-member is the normal grant",
);
assert.deepEqual(
  redemptionDecision({ organizationStatus: "active", alreadyMember: true }),
  { action: "consume", reason: "ALREADY_MEMBER" },
  "someone added by hand between invite and login must not have their existing row fought over",
);
assert.deepEqual(
  redemptionDecision({ organizationStatus: "disabled" }),
  { action: "defer", reason: "ORG_DISABLED" },
  "a disabled org may be re-enabled and the seat was paid for — deferring keeps the invitation redeemable instead of burning it",
);
assert.deepEqual(
  redemptionDecision({}),
  { action: "defer", reason: "ORG_MISSING" },
  "a missing org must never be treated as a grant",
);
// Redemption runs on EVERY login, so the decision must be stable rather than
// depending on how many times it has already run.
for (const state of [{ organizationStatus: "active" }, { organizationStatus: "active", alreadyMember: true }, { organizationStatus: "disabled" }]) {
  assert.deepEqual(redemptionDecision(state), redemptionDecision(state), "the decision must be a pure function of state");
}

// ---------- ownership is never handed out this way ----------

assert.deepEqual([...INVITABLE_ROLES].sort(), ["admin", "member"], "an invitation may carry admin or member, never owner");

// ---------- wiring the pure logic cannot prove ----------

const invitationsSource = fs.readFileSync(new URL("../server/src/services/enterprise-invitations.js", import.meta.url), "utf8");
assert.match(
  invitationsSource,
  /\.where\("status", "=", "pending"\)[\s\S]{0,200}\.forUpdate\(\)/,
  "redemption must re-read the invitation FOR UPDATE — two devices logging in at once must not both grant the same seat",
);
assert.match(
  invitationsSource,
  /onConflict\(\(oc\) => oc\.columns\(\["organization_id", "user_id"\]\)\.doNothing\(\)\)/,
  "granting a seat must be idempotent against an existing membership",
);

const mutationsSource = fs.readFileSync(new URL("../server/src/services/enterprise-mutations.js", import.meta.url), "utf8");
assert.doesNotMatch(
  mutationsSource,
  /if \(!user\) fail\("USER_NOT_FOUND", 404\)/,
  "the dead end this change removes must be gone",
);
assert.match(mutationsSource, /if \(input\.role === "owner"\) fail\("INVITE_ROLE_UNSUPPORTED", 400\)/,
  "inviting an owner must be refused explicitly, not silently normalised down to member");
assert.match(mutationsSource, /revokeInvitation\(options, invitationId\)/, "an open invitation must be withdrawable");
assert.match(
  mutationsSource,
  /revokeInvitation[\s\S]{0,600}forUpdate\(\)/,
  "revoking must take the row lock, like every other membership mutation",
);

// Login must never depend on a seat being granted.
const authSource = fs.readFileSync(new URL("../server/src/routes/public/auth.js", import.meta.url), "utf8");
assert.match(authSource, /redeemInvitationsForPhone\(db, \{ userId: result\.user\.id, phoneE164 \}\)/, "login must redeem invitations for the phone that just logged in");
const redeemAt = authSource.indexOf("redeemInvitationsForPhone(db,");
const txEndAt = authSource.indexOf("if (result.disabled)");
assert.ok(redeemAt > 0 && txEndAt > 0 && redeemAt > txEndAt,
  "redemption must run AFTER the login transaction commits — a login must not fail because a seat could not be granted");
const redeemBlock = authSource.slice(redeemAt - 200, redeemAt + 300);
assert.match(redeemBlock, /try \{/, "redemption must be wrapped: a failure leaves the invitation pending for the next login");

const routesSource = fs.readFileSync(new URL("../server/src/routes/public/enterprise-members.js", import.meta.url), "utf8");
assert.match(routesSource, /"\/api\/enterprise\/organizations\/:id\/invitations"/, "pending seats must be listable");
assert.match(routesSource, /"\/api\/enterprise\/organizations\/:id\/invitations\/:invitationId"/, "a pending seat must be revocable");
assert.match(routesSource, /requireOrgRole\(request, reply, request\.params\.id, "admin"\)/, "listing invitations is an admin view, not a member view");

const migrationSource = fs.readFileSync(new URL("../server/migrations/043_enterprise_invitations.sql", import.meta.url), "utf8");
assert.match(migrationSource, /create table if not exists organization_invitations/, "migration 043 must create the table");
assert.match(
  migrationSource,
  /create unique index if not exists organization_invitations_pending_uq[\s\S]{0,160}where status = 'pending'/,
  "uniqueness must be PARTIAL — accepted and revoked rows stay for audit and must not block a re-invite",
);
assert.match(
  migrationSource,
  /invited_by text references users\(id\) on delete set null/,
  "an invitation must outlive the admin who sent it; cascading here would silently drop paid-for seats",
);
assert.doesNotMatch(migrationSource, /alter table/i, "the migration must be additive — no existing table may be touched");
assert.match(migrationSource, /check \(role in \('admin', 'member'\)\)/, "the table itself must refuse an owner invitation");

console.log("enterprise-invitations: ok");
console.log(`  unregistered phone → invitation; registered phone → immediate membership`);
console.log(`  redemption: grant / consume / defer, idempotent and locked`);
console.log(`  login never depends on it`);
