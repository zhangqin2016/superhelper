import crypto from "node:crypto";
import { config } from "../config.js";

// A grant-scoped token for the desktop-vouched mobile pairing flow. It is NOT an
// account session: it carries only a grant id + the mobile browser device id, so
// its ONLY power is to connect the relay for that one approved grant. The phone
// gets it at consume time (no login); the relay still refuses until the desktop
// approves the grant, so possession alone grants nothing without desktop consent.
//
// HMAC-signed with the same server secret as account tokens (account-auth.js),
// same compact `prefix + v1.<payload>.<mac>` shape, kept as an independent pure
// module so its rules are unit-tested without DB or network.

const GRANT_PREFIX = "lily_mgrant_";
const GRANT_VERSION = "v1";
const GRANT_TYP = "mobile_grant";
// Grants live at most a couple of days; the token outlives the approval wait but
// is bounded so a leaked one can't be replayed indefinitely.
const DEFAULT_TTL_SECONDS = 2 * 24 * 60 * 60;

function base64urlEncode(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function base64urlDecode(input) {
  const value = String(input || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = value.length % 4 ? "=".repeat(4 - (value.length % 4)) : "";
  return Buffer.from(value + pad, "base64");
}
function hmacHex(value, secret = config.sessionSecret) {
  return crypto.createHmac("sha256", secret).update(String(value)).digest("hex");
}

export function createGrantToken({ grantId, mobileDeviceId, nowMs = Date.now(), ttlSeconds = DEFAULT_TTL_SECONDS } = {}) {
  const payload = {
    typ: GRANT_TYP,
    gid: String(grantId || ""),
    did: String(mobileDeviceId || ""),
    iat: Math.floor(nowMs / 1000),
    exp: Math.floor(nowMs / 1000) + Number(ttlSeconds || 0),
  };
  const body = `${GRANT_VERSION}.${base64urlEncode(JSON.stringify(payload))}`;
  return `${GRANT_PREFIX}${body}.${hmacHex(body)}`;
}

export function verifyGrantToken(token, { nowMs = Date.now() } = {}) {
  const text = String(token || "");
  if (!text.startsWith(GRANT_PREFIX)) return { ok: false, code: "GRANT_TOKEN_INVALID" };
  const parts = text.slice(GRANT_PREFIX.length).split(".");
  if (parts.length !== 3 || parts[0] !== GRANT_VERSION) return { ok: false, code: "GRANT_TOKEN_INVALID" };
  const body = `${parts[0]}.${parts[1]}`;
  const actual = Buffer.from(parts[2]);
  const expected = Buffer.from(hmacHex(body));
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    return { ok: false, code: "GRANT_TOKEN_INVALID" };
  }
  let payload;
  try {
    payload = JSON.parse(base64urlDecode(parts[1]).toString("utf8"));
  } catch {
    return { ok: false, code: "GRANT_TOKEN_INVALID" };
  }
  if (payload?.typ !== GRANT_TYP) return { ok: false, code: "GRANT_TOKEN_INVALID" };
  if (Number(payload.exp || 0) <= Math.floor(nowMs / 1000)) return { ok: false, code: "GRANT_TOKEN_EXPIRED" };
  return {
    ok: true,
    grantId: String(payload.gid || ""),
    mobileDeviceId: String(payload.did || ""),
    expiresAt: new Date(Number(payload.exp || 0) * 1000).toISOString(),
  };
}
