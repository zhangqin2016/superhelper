#!/usr/bin/env node
// Enterprise-issued accounts — pure-logic tests (no database required).
//
// Identity was phone-only (users.phone_e164 NOT NULL UNIQUE, SMS-only login),
// so "the company creates the account" was impossible: a user row could not
// exist without a phone the person personally holds. This adds a login-name +
// password identity the company issues once; the employee must change it on
// first login, and the account is owned by the organization — removing it from
// the org locks the login.
//
// The rules below decide whether a login succeeds, when an account locks, and
// what happens to an issued account when its membership changes. They are pure
// so they can be held to account here; the wiring assertions cover what pure
// logic cannot see.

import assert from "node:assert/strict";
import fs from "node:fs";

process.env.DATABASE_URL ||= "postgres://unused:unused@localhost:5432/unused";

const m = await import(new URL("../server/src/services/enterprise-accounts.js", import.meta.url));
const {
  hashPassword, verifyPassword, generateInitialPassword, validateNewPassword,
  normalizeLoginName, generateLoginName, passwordLoginDecision,
  ownedAccountStatusAfterMembership, ENTERPRISE_ACCOUNT_LIMITS,
} = m;

// ---------- passwords ----------
{
  const hash = hashPassword("Correct-Horse-9");
  assert.match(hash, /^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/, "scrypt with parameters and a per-user salt, self-describing");
  assert.notEqual(hashPassword("Correct-Horse-9"), hash, "the same password must hash differently each time — a fixed salt would let identical passwords be spotted");
  assert.equal(verifyPassword("Correct-Horse-9", hash), true, "the right password verifies");
  assert.equal(verifyPassword("correct-horse-9", hash), false, "case matters");
  assert.equal(verifyPassword("", hash), false, "empty never verifies");
  assert.equal(verifyPassword("anything", "garbage"), false, "a malformed stored hash verifies false, it must not throw on the login path");
  assert.equal(verifyPassword("anything", null), false, "a phone-only user has no hash and can never password-login");
}
{
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) {
    const pw = generateInitialPassword();
    assert.equal(pw.length, 12, "initial passwords are 12 chars");
    assert.doesNotMatch(pw, /[0O1lI]/, "no glyphs that are read wrong off a screen or printout");
    seen.add(pw);
  }
  assert.equal(seen.size, 200, "200 draws must be 200 different passwords");
}
for (const [pw, code] of [["short1", "PASSWORD_TOO_SHORT"], ["a".repeat(129) + "1", "PASSWORD_TOO_LONG"], ["onlyletters", "PASSWORD_TOO_SIMPLE"], ["12345678", "PASSWORD_TOO_SIMPLE"]]) {
  assert.deepEqual(validateNewPassword(pw), { ok: false, code }, `${JSON.stringify(pw.slice(0, 12))} → ${code}`);
}
assert.deepEqual(validateNewPassword("Letters4Digits"), { ok: true }, "letters plus digits, 8+ chars, passes");

// ---------- login names ----------
assert.equal(normalizeLoginName("  Zhang.San-01 "), "zhang.san-01", "trimmed and lowercased — lookups must not depend on how the user typed it");
for (const bad of ["ab", "-leading", "has space", "太长了".repeat(20), "emoji😀", ""]) {
  assert.equal(normalizeLoginName(bad), "", `${JSON.stringify(bad.slice(0, 12))} is not a valid login name`);
}
{
  const generated = generateLoginName("Acme Corp (HK)!");
  assert.match(generated, /^acme-corp-hk-[a-z2-9]{6}$/, `org name becomes a safe prefix: ${generated}`);
  assert.match(generateLoginName(""), /^org-[a-z2-9]{6}$/, "no org name still yields a valid login name");
}

// ---------- the login decision ----------
const now = 1_700_000_000_000;
assert.deepEqual(
  passwordLoginDecision({ passwordOk: true, failedCount: 3, mustChange: true, now }),
  { ok: true, failedCount: 0, lockedUntil: null, mustChange: true },
  "a successful login resets the failure count and reports the forced change",
);
assert.deepEqual(
  passwordLoginDecision({ passwordOk: false, failedCount: 0, now }),
  { ok: false, code: "INVALID_CREDENTIALS", failedCount: 1, lockedUntil: null },
  "a wrong password counts one failure",
);
assert.deepEqual(
  passwordLoginDecision({ passwordOk: false, failedCount: 4, now }),
  { ok: false, code: "PASSWORD_LOCKED", failedCount: 5, lockedUntil: now + ENTERPRISE_ACCOUNT_LIMITS.LOCK_MS },
  "the fifth failure locks — same threshold as the SMS path, so an issued account is not a weaker door than a phone",
);
assert.deepEqual(
  passwordLoginDecision({ passwordOk: true, lockedUntil: new Date(now + 60_000), now }),
  { ok: false, code: "PASSWORD_LOCKED", failedCount: 0, lockedUntil: now + 60_000 },
  "a locked account rejects even the RIGHT password until the lock expires — otherwise the lock does nothing against a guesser who eventually guesses right",
);
assert.equal(passwordLoginDecision({ passwordOk: true, lockedUntil: new Date(now - 1), now }).ok, true, "an expired lock no longer applies");
assert.deepEqual(
  passwordLoginDecision({ passwordOk: true, userStatus: "disabled", now }),
  { ok: false, code: "USER_DISABLED", failedCount: 0, lockedUntil: null },
  "a disabled account cannot log in with a correct password",
);

// ---------- an issued account follows its membership ----------
assert.equal(
  ownedAccountStatusAfterMembership({ provisionedOrganizationId: "org_1", organizationId: "org_1", memberStatus: "removed" }),
  "disabled",
  "removing an issued account from the org that issued it must lock the login — a removed employee must not keep a working account",
);
assert.equal(
  ownedAccountStatusAfterMembership({ provisionedOrganizationId: "org_1", organizationId: "org_1", memberStatus: "disabled" }),
  "disabled",
  "disabling the membership disables the login",
);
assert.equal(
  ownedAccountStatusAfterMembership({ provisionedOrganizationId: "org_1", organizationId: "org_1", memberStatus: "active" }),
  "active",
  "re-enabling the membership re-enables the login",
);
assert.equal(
  ownedAccountStatusAfterMembership({ provisionedOrganizationId: null, organizationId: "org_1", memberStatus: "removed" }),
  null,
  "a phone user who merely joined keeps their own account when removed — the org does not own it",
);
assert.equal(
  ownedAccountStatusAfterMembership({ provisionedOrganizationId: "org_1", organizationId: "org_2", memberStatus: "removed" }),
  null,
  "an account issued by org_1 is not touched when removed from a DIFFERENT org it also joined",
);

// ---------- wiring the pure logic cannot prove ----------
const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");

const migration = read("../server/migrations/044_enterprise_accounts.sql");
assert.match(migration, /alter table users alter column phone_e164 drop not null/, "a phone must become optional for an issued account to exist");
assert.match(migration, /check \(phone_e164 is not null or login_name is not null\)/, "but a user must still have SOME identity — never a row nobody can log in as");
assert.match(migration, /create unique index if not exists users_login_name_uq on users \(login_name\) where login_name is not null/, "login names are unique, and the index is partial so phone-only users are not in it");
assert.match(migration, /provisioned_organization_id text references organizations\(id\) on delete set null/, "ownership is recorded, and outlives the org row itself");

const auth = read("../server/src/routes/public/auth.js");
assert.match(auth, /"\/api\/auth\/password\/login"/, "the password login route exists");
assert.match(auth, /"\/api\/auth\/password\/change"/, "the change route exists");
assert.match(auth, /if \(!user\) return reply\.code\(401\)\.send\(\{ ok: false, code: "INVALID_CREDENTIALS" \}\)/, "an unknown login name must return the SAME code as a wrong password, so names cannot be probed");
// The decision must be computed BEFORE the user-existence early return, or the
// timing of "no such user" differs from "wrong password".
assert.ok(auth.indexOf("passwordLoginDecision({") < auth.indexOf('if (!user) return reply.code(401)'), "the decision is computed before the existence check, keeping timing uniform");
assert.match(auth, /password_failed_count: decision\.failedCount/, "failures must be persisted or the lock never engages");
assert.match(auth, /const account = await requireAccountSession\(request, reply, input\);\s*\n\s*if \(!account\) return;/, "changing a password requires the signed-in session");
assert.match(auth, /if \(!verifyPassword\(input\.currentPassword, user\.password_hash\)\)/, "changing a password requires the CURRENT one — a stolen session alone must not be enough to take over the account");
assert.match(auth, /password_must_change: false/, "a successful change clears the forced-change flag");

const mutations = read("../server/src/services/enterprise-mutations.js");
assert.match(mutations, /if \(request\?\.role === "owner"\) fail\("INVITE_ROLE_UNSUPPORTED", 400\)/, "an issued account can never be an owner");
assert.match(mutations, /if \(organization\.status !== "active"\) fail\("ORG_DISABLED"\)/, "a disabled org cannot issue accounts");
assert.match(mutations, /ownedAccountStatusAfterMembership\(/, "membership changes must consult the ownership rule");
assert.match(mutations, /if \(ownedStatus\) await trx\.updateTable\("users"\)\.set\(\{ status: ownedStatus \}\)/, "and apply it to the login itself");

const service = read("../server/src/services/enterprise-accounts.js");
assert.doesNotMatch(service, /initial_password|initialPassword:\s*initialPassword\s*\}\)\s*\.execute/, "the initial password must never be written to the database");
// Both writes — provisioning AND reset — must hash. A regex that matched
// either site let plaintext at one of them pass, so count them.
assert.equal(
  (service.match(/password_hash: hashPassword\(initialPassword\)/g) || []).length,
  2,
  "every write of an initial password must go through hashPassword — provisioning and reset alike",
);
assert.doesNotMatch(service, /password_hash: initialPassword\b/, "an initial password must never be stored as-is at any site");
assert.match(service, /password_must_change: true/, "an issued account starts in forced-change");

const routes = read("../server/src/routes/public/enterprise-accounts.js");
assert.match(routes, /"\/api\/enterprise\/organizations\/:id\/accounts"/, "provisioning endpoint exists");
assert.match(routes, /reset-password/, "reset endpoint exists");
assert.match(routes, /requireOrgRole\(request, reply, request\.params\.id, "admin"\)/, "listing issued accounts is an admin view");
const publicRoutes = read("../server/src/routes/public/enterprise.js");
assert.match(publicRoutes, /registerPublicEnterpriseAccountRoutes\(app\)/, "and the route file is actually registered");

// The client must offer the second door.
const renderer = read("../src/renderer/modules/account-settings.js");
assert.match(renderer, /loginAccountWithPassword\(\{ loginName, password \}\)/, "the client calls the password login");
assert.match(renderer, /if \(result\.passwordMustChange\) \{/, "and honours the forced change before treating the login as complete");
const preload = read("../src/preload.js");
assert.match(preload, /loginAccountWithPassword:/, "preload exposes password login");
assert.match(preload, /changeAccountPassword:/, "preload exposes password change");

console.log("enterprise-accounts: ok");
console.log("  scrypt hashing, unreadable-glyph-free initial passwords, 5-strike lock that rejects even a correct password");
console.log("  an issued account follows its membership; a phone user keeps their own");
console.log("  unknown login name and wrong password are indistinguishable");
