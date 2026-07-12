#!/usr/bin/env node
// Mobile relay connection-auth decision. Security-critical: it decides whether
// a WebSocket may join a pairing's message channel. A wrong "ok" lets a
// stranger read/inject another user's desktop session. Pure, no socket/db.

import assert from "node:assert/strict";

process.env.SESSION_SECRET ||= "test-session-secret-abcdefghijklmnop";
process.env.DATABASE_URL ||= "postgres://localhost:5432/test";

const { authenticateRelayConnection } = await import("../server/src/services/mobile-relay.js");

const verifiedMobile = { ok: true, userId: "u1", sessionId: "sess1", deviceId: "dmob" };
const activeGrant = { id: "g1", status: "active", user_id: "u1", desktop_device_id: "dtop", mobile_device_id: "dmob" };

// happy path: mobile joins its grant
{
  const r = authenticateRelayConnection({ verified: verifiedMobile, role: "mobile", grantId: "g1", deviceId: "dmob", grant: activeGrant });
  assert.equal(r.ok, true);
  assert.deepEqual(r.conn, { role: "mobile", grantId: "g1", deviceId: "dmob", userId: "u1" });
}

// happy path: desktop joins its grant
{
  const verifiedDesktop = { ok: true, userId: "u1", sessionId: "s", deviceId: "dtop" };
  const r = authenticateRelayConnection({ verified: verifiedDesktop, role: "desktop", grantId: "g1", deviceId: "dtop", grant: activeGrant });
  assert.equal(r.ok, true);
  assert.equal(r.conn.role, "desktop");
}

// invalid token
assert.equal(authenticateRelayConnection({ verified: { ok: false, code: "ACCESS_TOKEN_EXPIRED" }, role: "mobile", grantId: "g1", deviceId: "dmob", grant: activeGrant }).code, "ACCESS_TOKEN_EXPIRED");

// token bound to a different device than declared
assert.equal(authenticateRelayConnection({ verified: verifiedMobile, role: "mobile", grantId: "g1", deviceId: "other", grant: activeGrant }).code, "DEVICE_MISMATCH");

// bad role
assert.equal(authenticateRelayConnection({ verified: verifiedMobile, role: "peer", grantId: "g1", deviceId: "dmob", grant: activeGrant }).code, "RELAY_ROLE_INVALID");

// no grant / inactive grant
assert.equal(authenticateRelayConnection({ verified: verifiedMobile, role: "mobile", grantId: "g1", deviceId: "dmob", grant: null }).code, "RELAY_GRANT_INACTIVE");
assert.equal(authenticateRelayConnection({ verified: verifiedMobile, role: "mobile", grantId: "g1", deviceId: "dmob", grant: { ...activeGrant, status: "revoked" } }).code, "RELAY_GRANT_INACTIVE", "a revoked grant cannot open the channel");

// grant belongs to another account
assert.equal(authenticateRelayConnection({ verified: verifiedMobile, role: "mobile", grantId: "g1", deviceId: "dmob", grant: { ...activeGrant, user_id: "u2" } }).code, "RELAY_GRANT_ACCOUNT_MISMATCH");

// device not the one bound in the grant for this role (the core protection):
// a device that holds a valid token but is not this grant's mobile cannot join
assert.equal(authenticateRelayConnection({ verified: { ...verifiedMobile, deviceId: "dmob" }, role: "desktop", grantId: "g1", deviceId: "dmob", grant: activeGrant }).code, "RELAY_GRANT_DEVICE_MISMATCH", "a device cannot join in a role it isn't bound to");

console.log("mobile-relay-auth: ok");
