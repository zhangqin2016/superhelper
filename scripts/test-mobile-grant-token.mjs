#!/usr/bin/env node
// Grant-scoped mobile token: the phone's only credential in the desktop-vouched
// pairing model. Security-critical — it must round-trip its own tokens, reject
// tampering/expiry/foreign prefixes, and carry only grantId + mobileDeviceId.

import assert from "node:assert/strict";

process.env.SESSION_SECRET ||= "test-session-secret-abcdefghijklmnop";
process.env.DATABASE_URL ||= "postgres://localhost:5432/test";

const { createGrantToken, verifyGrantToken } = await import("../server/src/services/mobile-grant-token.js");

// round-trip
{
  const now = Date.parse("2026-07-13T00:00:00Z");
  const token = createGrantToken({ grantId: "mpg_1", mobileDeviceId: "dmob", nowMs: now });
  assert.ok(token.startsWith("lily_mgrant_"), "has the grant-token prefix");
  const v = verifyGrantToken(token, { nowMs: now + 1000 });
  assert.equal(v.ok, true);
  assert.equal(v.grantId, "mpg_1");
  assert.equal(v.mobileDeviceId, "dmob");
}

// expiry
{
  const now = Date.parse("2026-07-13T00:00:00Z");
  const token = createGrantToken({ grantId: "mpg_1", mobileDeviceId: "dmob", nowMs: now, ttlSeconds: 60 });
  assert.equal(verifyGrantToken(token, { nowMs: now + 61_000 }).code, "GRANT_TOKEN_EXPIRED");
  assert.equal(verifyGrantToken(token, { nowMs: now + 59_000 }).ok, true);
}

// tampering: any byte flip in the payload/mac fails the HMAC
{
  const token = createGrantToken({ grantId: "mpg_1", mobileDeviceId: "dmob" });
  const tampered = `${token.slice(0, -1)}${token.slice(-1) === "a" ? "b" : "a"}`;
  assert.equal(verifyGrantToken(tampered).ok, false, "a tampered token is rejected");
  // a payload swap keeping the old mac must fail
  const parts = token.slice("lily_mgrant_".length).split(".");
  const forged = `lily_mgrant_${parts[0]}.${Buffer.from(JSON.stringify({ typ: "mobile_grant", gid: "EVIL", did: "dmob", exp: 9999999999 })).toString("base64url")}.${parts[2]}`;
  assert.equal(verifyGrantToken(forged).code, "GRANT_TOKEN_INVALID", "a re-signed payload with the old mac is rejected");
}

// foreign prefix / an account token must not verify as a grant token
{
  assert.equal(verifyGrantToken("").code, "GRANT_TOKEN_INVALID");
  assert.equal(verifyGrantToken("lily_access_v1.abc.def").code, "GRANT_TOKEN_INVALID", "an account access token is not a grant token");
}

console.log("mobile-grant-token: ok");
