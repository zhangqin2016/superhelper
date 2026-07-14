#!/usr/bin/env node
// Mobile relay connection-auth decision. Security-critical: it decides whether
// a WebSocket may join a pairing's message channel. A wrong "ok" lets a
// stranger read/inject another user's desktop session. Pure, no socket/db.
//
// Desktop-vouched model: desktop authenticates with an ACCOUNT token
// (auth.kind==="account"), mobile with a GRANT-scoped token
// (auth.kind==="grant", no account). Both must bind an active grant + device.

import assert from "node:assert/strict";

process.env.SESSION_SECRET ||= "test-session-secret-abcdefghijklmnop";
process.env.DATABASE_URL ||= "postgres://localhost:5432/test";

const { authenticateRelayConnection, peerOfflineFrameForMessage } = await import("../server/src/services/mobile-relay.js");

const mobileAuth = { kind: "grant", ok: true, grantId: "g1", mobileDeviceId: "dmob" };
const desktopAuth = { kind: "account", ok: true, userId: "u1", deviceId: "dtop" };
const activeGrant = { id: "g1", status: "active", user_id: "u1", desktop_device_id: "dtop", mobile_device_id: "dmob" };

// happy path: mobile joins its grant with a grant token (no account)
{
  const r = authenticateRelayConnection({ auth: mobileAuth, role: "mobile", grantId: "g1", deviceId: "dmob", grant: activeGrant });
  assert.equal(r.ok, true);
  assert.deepEqual(r.conn, { role: "mobile", grantId: "g1", deviceId: "dmob", userId: "u1" });
}

// happy path: desktop joins its grant with its account token
{
  const r = authenticateRelayConnection({ auth: desktopAuth, role: "desktop", grantId: "g1", deviceId: "dtop", grant: activeGrant });
  assert.equal(r.ok, true);
  assert.equal(r.conn.role, "desktop");
  assert.equal(r.conn.userId, "u1");
}

// invalid / failed auth
assert.equal(authenticateRelayConnection({ auth: { kind: "grant", ok: false, code: "GRANT_TOKEN_EXPIRED" }, role: "mobile", grantId: "g1", deviceId: "dmob", grant: activeGrant }).code, "GRANT_TOKEN_EXPIRED");

// bad role
assert.equal(authenticateRelayConnection({ auth: mobileAuth, role: "peer", grantId: "g1", deviceId: "dmob", grant: activeGrant }).code, "RELAY_ROLE_INVALID");

// no grant / inactive grant
assert.equal(authenticateRelayConnection({ auth: mobileAuth, role: "mobile", grantId: "g1", deviceId: "dmob", grant: null }).code, "RELAY_GRANT_INACTIVE");
assert.equal(authenticateRelayConnection({ auth: mobileAuth, role: "mobile", grantId: "g1", deviceId: "dmob", grant: { ...activeGrant, status: "revoked" } }).code, "RELAY_GRANT_INACTIVE", "a revoked grant cannot open the channel");

// --- mobile-specific protections ---
// grant token issued for a different grant than the one declared
assert.equal(authenticateRelayConnection({ auth: { ...mobileAuth, grantId: "gOTHER" }, role: "mobile", grantId: "g1", deviceId: "dmob", grant: activeGrant }).code, "RELAY_GRANT_TOKEN_MISMATCH", "a token minted for another grant cannot join this one");
// token bound to a different device than declared
assert.equal(authenticateRelayConnection({ auth: mobileAuth, role: "mobile", grantId: "g1", deviceId: "other", grant: activeGrant }).code, "DEVICE_MISMATCH");
// declared device isn't the grant's mobile device
assert.equal(authenticateRelayConnection({ auth: { ...mobileAuth, mobileDeviceId: "dX" }, role: "mobile", grantId: "g1", deviceId: "dX", grant: activeGrant }).code, "RELAY_GRANT_DEVICE_MISMATCH");
// wrong auth kind for the role: a grant token can't open a desktop channel
assert.equal(authenticateRelayConnection({ auth: mobileAuth, role: "desktop", grantId: "g1", deviceId: "dtop", grant: activeGrant }).code, "RELAY_AUTH_KIND_INVALID", "a mobile grant token cannot join as desktop");
// ...and an account token can't open a mobile channel
assert.equal(authenticateRelayConnection({ auth: desktopAuth, role: "mobile", grantId: "g1", deviceId: "dmob", grant: activeGrant }).code, "RELAY_AUTH_KIND_INVALID", "an account token cannot join as mobile");

// --- desktop-specific protections ---
// desktop grant belongs to another account
assert.equal(authenticateRelayConnection({ auth: desktopAuth, role: "desktop", grantId: "g1", deviceId: "dtop", grant: { ...activeGrant, user_id: "u2" } }).code, "RELAY_GRANT_ACCOUNT_MISMATCH");
// desktop device not the grant's desktop device
assert.equal(authenticateRelayConnection({ auth: { ...desktopAuth, deviceId: "dX" }, role: "desktop", grantId: "g1", deviceId: "dX", grant: activeGrant }).code, "RELAY_GRANT_DEVICE_MISMATCH");

// peer-offline feedback preserves command diagnostics when the relay can parse it
{
  const frame = peerOfflineFrameForMessage(JSON.stringify({ type: "command", commandId: "cmd_1", correlationId: "corr_1" }));
  assert.deepEqual(frame, { type: "relay.peer_offline", commandId: "cmd_1", correlationId: "corr_1" });
  assert.deepEqual(peerOfflineFrameForMessage("{bad json"), { type: "relay.peer_offline" });
}

console.log("mobile-relay-auth: ok");
