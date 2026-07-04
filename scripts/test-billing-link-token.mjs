#!/usr/bin/env node
import assert from "node:assert/strict";

process.env.SESSION_SECRET = "test-session-secret";
process.env.USER_TOKEN_PEPPER = "test-user-pepper";

const { hashRefreshToken, verifyWebSessionToken } = await import("../server/src/services/account-auth.js");
const { consumeBillingLinkToken } = await import("../server/src/services/billing-link-token.js");

const oneTimeToken = "one_time_test_token";
const rows = new Map([
  [hashRefreshToken(oneTimeToken), {
    id: "blink_test",
    user_id: "usr_test",
    session_id: "sess_test",
    device_id: "dev_test",
    token_hash: hashRefreshToken(oneTimeToken),
    expires_at: new Date("2026-07-04T10:05:00.000Z"),
    consumed_at: null,
    session_revoked_at: null,
    session_expires_at: new Date("2026-07-11T10:00:00.000Z"),
  }],
]);

const consumed = await consumeBillingLinkToken({
  token: oneTimeToken,
  now: new Date("2026-07-04T10:00:00.000Z"),
  lookupToken: async (tokenHash) => rows.get(tokenHash) || null,
  markConsumed: async (id, consumedAt) => {
    const row = rows.get(hashRefreshToken(oneTimeToken));
    assert.equal(id, "blink_test");
    row.consumed_at = consumedAt;
    return true;
  },
});
assert.equal(consumed.ok, true);
assert.equal(consumed.userId, "usr_test");
assert.equal(consumed.sessionId, "sess_test");
const verified = verifyWebSessionToken(consumed.webSessionToken, {
  nowMs: Date.parse("2026-07-04T10:00:01.000Z"),
});
assert.equal(verified.ok, true);
assert.equal(verified.userId, "usr_test");
assert.equal(verified.sessionId, "sess_test");

const reused = await consumeBillingLinkToken({
  token: oneTimeToken,
  now: new Date("2026-07-04T10:00:02.000Z"),
  lookupToken: async (tokenHash) => rows.get(tokenHash) || null,
  markConsumed: async () => {
    throw new Error("already-consumed token must not be marked again");
  },
});
assert.deepEqual(reused, { ok: false, code: "BILLING_LINK_CONSUMED" });

const expired = await consumeBillingLinkToken({
  token: "one_time_expired",
  now: new Date("2026-07-04T10:10:00.000Z"),
  lookupToken: async () => ({
    id: "blink_expired",
    user_id: "usr_test",
    session_id: "sess_test",
    expires_at: new Date("2026-07-04T10:05:00.000Z"),
    consumed_at: null,
    session_revoked_at: null,
    session_expires_at: new Date("2026-07-11T10:00:00.000Z"),
  }),
  markConsumed: async () => true,
});
assert.deepEqual(expired, { ok: false, code: "BILLING_LINK_EXPIRED" });

console.log("billing link token helpers ok");
