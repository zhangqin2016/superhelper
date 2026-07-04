import { createWebSessionToken, hashRefreshToken } from "./account-auth.js";

function asTime(value) {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

export async function consumeBillingLinkToken({ token, now = new Date(), lookupToken, markConsumed }) {
  const text = String(token || "").trim();
  if (!text.startsWith("one_time_")) return { ok: false, code: "BILLING_LINK_INVALID" };

  const row = await lookupToken(hashRefreshToken(text));
  if (!row) return { ok: false, code: "BILLING_LINK_INVALID" };
  if (row.consumed_at) return { ok: false, code: "BILLING_LINK_CONSUMED" };
  if (asTime(row.expires_at) <= now.getTime()) return { ok: false, code: "BILLING_LINK_EXPIRED" };
  if (row.session_revoked_at || asTime(row.session_expires_at) <= now.getTime()) {
    return { ok: false, code: "USER_LOGIN_REQUIRED" };
  }

  const marked = await markConsumed(row.id, now);
  if (!marked) return { ok: false, code: "BILLING_LINK_CONSUMED" };

  return {
    ok: true,
    userId: row.user_id,
    sessionId: row.session_id,
    webSessionToken: createWebSessionToken({
      userId: row.user_id,
      sessionId: row.session_id,
    }),
  };
}
