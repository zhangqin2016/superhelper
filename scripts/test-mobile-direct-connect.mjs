#!/usr/bin/env node
// Direct-connect codes (TeamViewer/ToDesk-style): short code + password → an
// active grant, no approval. Security-critical — verify hashing, opaque errors,
// per-code lockout, self-pair/license guards, and case/space-insensitive input.

import assert from "node:assert/strict";

process.env.SESSION_SECRET ||= "test-session-secret-abcdefghijklmnop";
process.env.DATABASE_URL ||= "postgres://localhost:5432/test";

const {
  createDirectCode, consumeDirectCode, hashDirectSecret, normalizeDirectInput,
  generateDirectCode, generateDirectPassword, MAX_ATTEMPTS, CODE_LENGTH, PASSWORD_LENGTH,
} = await import("../server/src/services/mobile-direct-connect.js");

const NOW = new Date("2026-07-15T00:00:00.000Z");

// --- generation + normalization + hashing ---
{
  const code = generateDirectCode();
  assert.equal(code.length, CODE_LENGTH);
  assert.match(code, /^[2-9A-HJ-NP-Z]+$/, "no ambiguous chars (0/1/O/I/L)");
  assert.equal(generateDirectPassword().length, PASSWORD_LENGTH);
  // input is normalized: case + spaces/dashes ignored
  assert.equal(normalizeDirectInput(" ab-cd 12 "), "ABCD12");
  assert.equal(hashDirectSecret("abcd"), hashDirectSecret("A B C D"), "hash is normalization-invariant");
  assert.notEqual(hashDirectSecret("abcd"), "abcd", "stores a hash, not the secret");
}

// --- create: hashes both, inserts, returns plaintext once, revokes prior ---
{
  let revoked = false; let row = null;
  const res = await createDirectCode({
    userId: "u1", accountSessionId: "s1", desktopDeviceId: "dtop", now: NOW,
    revokePriorActive: async () => { revoked = true; },
    insertCode: async (r) => { row = r; },
    makeCode: () => "CODE1234", makePassword: () => "PASS12",
  });
  assert.equal(res.ok, true);
  assert.equal(revoked, true, "prior active code revoked (one active at a time)");
  assert.equal(res.code, "CODE1234"); assert.equal(res.password, "PASS12");
  assert.equal(row.code_hash, hashDirectSecret("CODE1234"), "only the code hash is stored");
  assert.equal(row.password_hash, hashDirectSecret("PASS12"));
  assert.equal(row.status, "active"); assert.equal(row.user_id, "u1");
  assert.ok(!("code" in row) && !("password" in row), "plaintext never persisted");
}

// --- consume happy path → active grant + token, attempts reset ---
{
  const active = { id: "mdc1", user_id: "u1", desktop_device_id: "dtop", code_hash: hashDirectSecret("CODE1234"), password_hash: hashDirectSecret("PASS12"), status: "active", attempt_count: 2 };
  let grant = null; let reset = false;
  const res = await consumeDirectCode({
    code: "code1234", password: "pass12", mobileDeviceId: "dmob", now: NOW, // lowercase → normalized
    findActiveCodeByHash: async (h) => (h === hashDirectSecret("CODE1234") ? active : null),
    resolveDesktopLicense: async () => "lic1",
    supersedeLivePairs: async () => {},
    insertGrant: async (r) => { grant = r; },
    resetAttempts: async () => { reset = true; },
    issueGrantToken: ({ grantId, mobileDeviceId }) => `gt_${grantId}_${mobileDeviceId}`,
  });
  assert.equal(res.ok, true, "correct code+password (any case) connects");
  assert.equal(grant.status, "active", "direct grant is active immediately (no approval)");
  assert.ok(grant.approved_at, "active grant carries approved_at");
  assert.equal(grant.account_session_id, null);
  assert.equal(res.mobileToken, `gt_${grant.id}_dmob`);
  assert.equal(reset, true, "attempts reset on success");
}

// --- wrong password → opaque error + attempt registered; lock at MAX ---
{
  const active = { id: "mdc1", user_id: "u1", desktop_device_id: "dtop", code_hash: hashDirectSecret("C"), password_hash: hashDirectSecret("RIGHT"), status: "active", attempt_count: 0 };
  let recorded = null;
  const attempt = (attempt_count) => consumeDirectCode({
    code: "C", password: "WRONG", mobileDeviceId: "dmob", now: NOW,
    findActiveCodeByHash: async () => ({ ...active, attempt_count }),
    registerFailedAttempt: async (a) => { recorded = a; },
    insertGrant: async () => { throw new Error("must not grant on wrong password"); },
  });
  const r1 = await attempt(0);
  assert.equal(r1.ok, false); assert.equal(r1.code, "DIRECT_CODE_INVALID", "opaque error");
  assert.equal(recorded.attemptCount, 1); assert.equal(recorded.lockedUntil, null);
  const rLock = await attempt(MAX_ATTEMPTS - 1);
  assert.equal(rLock.code, "DIRECT_CODE_LOCKED", "locks at MAX_ATTEMPTS");
  assert.ok(recorded.lockedUntil, "lockedUntil set on final attempt");
}

// --- unknown code → same opaque error (no enumeration) ---
{
  const r = await consumeDirectCode({ code: "NOPE", password: "x", mobileDeviceId: "dmob", findActiveCodeByHash: async () => null });
  assert.equal(r.code, "DIRECT_CODE_INVALID", "unknown code is indistinguishable from wrong password");
}

// --- locked code refuses even with the right password ---
{
  const locked = { id: "mdc1", user_id: "u1", desktop_device_id: "dtop", password_hash: hashDirectSecret("RIGHT"), status: "active", attempt_count: MAX_ATTEMPTS, locked_until: "2026-07-15T00:10:00.000Z" };
  const r = await consumeDirectCode({ code: "C", password: "RIGHT", mobileDeviceId: "dmob", now: NOW, findActiveCodeByHash: async () => locked, insertGrant: async () => { throw new Error("must not grant while locked"); } });
  assert.equal(r.code, "DIRECT_CODE_LOCKED");
}

// --- self-pair + license guards ---
{
  const base = { id: "mdc1", user_id: "u1", desktop_device_id: "dtop", password_hash: hashDirectSecret("P"), status: "active", attempt_count: 0 };
  const self = await consumeDirectCode({ code: "C", password: "P", mobileDeviceId: "dtop", now: NOW, findActiveCodeByHash: async () => base, resolveDesktopLicense: async () => "lic1" });
  assert.equal(self.code, "DIRECT_SELF_PAIR");
  const noLic = await consumeDirectCode({ code: "C", password: "P", mobileDeviceId: "dmob", now: NOW, findActiveCodeByHash: async () => base, resolveDesktopLicense: async () => null });
  assert.equal(noLic.code, "DIRECT_LICENSE_UNRESOLVED");
}

// --- invalid input ---
{
  assert.equal((await consumeDirectCode({ code: "", password: "p", mobileDeviceId: "d" })).code, "DIRECT_CONSUME_INVALID");
  assert.equal((await createDirectCode({ desktopDeviceId: "", insertCode: async () => {} })).code, "DIRECT_CREATE_INVALID");
}

console.log("mobile-direct-connect: ok");
