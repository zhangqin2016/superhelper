#!/usr/bin/env node
// Shared account-session guard decision core. Security-critical: it decides
// whether a bearer request is an authenticated account on its own device. Pure
// function, every branch driven with no DB.

import assert from "node:assert/strict";

process.env.SESSION_SECRET ||= "test-session-secret-abcdefghijklmnop";
process.env.DATABASE_URL ||= "postgres://localhost:5432/test";

const { evaluateAccountSession, bearerToken, accountSessionFailure } = await import("../server/src/services/account-session-guard.js");

const NOW = Date.parse("2026-07-12T12:00:00.000Z");
const freshSession = { user_id: "u1", device_id: "dev1", revoked_at: null, expires_at: "2026-07-12T13:00:00.000Z" };
const okVerified = { ok: true, userId: "u1", sessionId: "sess1", deviceId: "dev1" };

// bearerToken parsing
assert.equal(bearerToken({ headers: { authorization: "Bearer abc.def" } }), "abc.def");
assert.equal(bearerToken({ headers: { authorization: "bearer x" } }), "x", "case-insensitive scheme");
assert.equal(bearerToken({ headers: {} }), "", "no header → empty");
assert.deepEqual(accountSessionFailure({ status: 403, code: "DEVICE_MISMATCH" }), {
  status: 403,
  body: { ok: false, code: "DEVICE_MISMATCH" },
});

// happy path
{
  const r = evaluateAccountSession({ verified: okVerified, deviceId: "dev1", session: freshSession, now: NOW });
  assert.equal(r.ok, true);
  assert.deepEqual(r.account, { userId: "u1", sessionId: "sess1", deviceId: "dev1" });
}

// invalid token
{
  const r = evaluateAccountSession({ verified: { ok: false, code: "ACCESS_TOKEN_EXPIRED" }, deviceId: "dev1", session: freshSession, now: NOW });
  assert.equal(r.ok, false); assert.equal(r.status, 401); assert.equal(r.code, "ACCESS_TOKEN_EXPIRED");
}

// device mismatch: token bound to a different device than the request declares
{
  const r = evaluateAccountSession({ verified: okVerified, deviceId: "other-device", session: freshSession, now: NOW });
  assert.equal(r.code, "DEVICE_MISMATCH"); assert.equal(r.status, 403);
}

// revoked / expired session
{
  const revoked = evaluateAccountSession({ verified: okVerified, deviceId: "dev1", session: { ...freshSession, revoked_at: "2026-07-12T11:00:00Z" }, now: NOW });
  assert.equal(revoked.code, "SESSION_EXPIRED");
  const expired = evaluateAccountSession({ verified: okVerified, deviceId: "dev1", session: { ...freshSession, expires_at: "2026-07-12T11:00:00.000Z" }, now: NOW });
  assert.equal(expired.code, "SESSION_EXPIRED", "a session past expires_at is rejected");
  const missing = evaluateAccountSession({ verified: okVerified, deviceId: "dev1", session: null, now: NOW });
  assert.equal(missing.code, "SESSION_EXPIRED", "no session row is rejected");
}

// session belongs to a different user/device than the token claims
{
  const wrongUser = evaluateAccountSession({ verified: okVerified, deviceId: "dev1", session: { ...freshSession, user_id: "u2" }, now: NOW });
  assert.equal(wrongUser.code, "SESSION_MISMATCH"); assert.equal(wrongUser.status, 403);
  const wrongDevice = evaluateAccountSession({ verified: okVerified, deviceId: "dev1", session: { ...freshSession, device_id: "dev2" }, now: NOW });
  assert.equal(wrongDevice.code, "SESSION_MISMATCH");
}

console.log("account-session-guard: ok");
