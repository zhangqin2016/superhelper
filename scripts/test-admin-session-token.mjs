#!/usr/bin/env node
/**
 * Admin session token: the cookie must be a per-login signed value with
 * expiry — never the session secret itself (leaking one cookie must not leak
 * the signing secret), and forged/expired/tampered tokens must verify false.
 */
import { assert } from "./lib/test-assert.mjs";

process.env.SESSION_SECRET = "test-secret-for-admin-session";
const { createAdminSessionToken, verifyAdminSessionToken } =
  await import("../server/src/services/security.js");

const token = createAdminSessionToken();

assert(verifyAdminSessionToken(token), "fresh token verifies");
assert(token !== process.env.SESSION_SECRET, "token is not the raw secret");
assert(!token.includes(process.env.SESSION_SECRET), "token does not embed the secret");
assert(createAdminSessionToken() !== createAdminSessionToken(), "tokens are per-login unique");

// expiry honored
const expired = createAdminSessionToken(-1000);
assert(!verifyAdminSessionToken(expired), "expired token rejected");

// tampering breaks the MAC
const [v, exp, nonce, mac] = token.split(".");
assert(!verifyAdminSessionToken(`${v}.${Number(exp) + 9_999_999}.${nonce}.${mac}`), "extended expiry rejected");
assert(!verifyAdminSessionToken(`${v}.${exp}.${"0".repeat(nonce.length)}.${mac}`), "nonce swap rejected");
assert(!verifyAdminSessionToken(`${v}.${exp}.${nonce}.${"0".repeat(64)}`), "forged mac rejected");

// legacy/garbage shapes
assert(!verifyAdminSessionToken(process.env.SESSION_SECRET), "legacy secret-as-cookie rejected");
assert(!verifyAdminSessionToken(""), "empty rejected");
assert(!verifyAdminSessionToken("v0.1.2.3"), "unknown version rejected");

console.log("PASS: test-admin-session-token (11 tests)");
