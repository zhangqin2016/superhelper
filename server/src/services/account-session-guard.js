import { db } from "../db.js";
import { verifyAccessToken } from "./account-auth.js";

// Shared account-session guard for device-flow (bearer + device-bound) routes.
//
// The JWT verification primitive lives in account-auth.js (verifyAccessToken);
// this module owns the session-freshness + device-binding decision so more than
// one route can require an authenticated account without re-implementing it.
// The decision core (evaluateAccountSession) is pure and unit-tested; the
// request wrapper (requireAccountSession) loads the session row and replies.
//
// NOTE: server/src/routes/public/account.js still has an equivalent private
// requireAccount; converging it onto this module is a tracked follow-up. The
// security PRIMITIVE is not duplicated — both call verifyAccessToken.

export function bearerToken(request) {
  const header = String(request?.headers?.authorization || "");
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

/**
 * Pure decision. Given the verified token claims, the bound device id, and the
 * loaded session row, decide whether the request is an authenticated account
 * on its own device. Returns { ok, code?, account? }.
 */
export function evaluateAccountSession({ verified, deviceId, session, now = Date.now() }) {
  if (!verified?.ok) return { ok: false, code: verified?.code || "ACCESS_TOKEN_INVALID", status: 401 };
  if (verified.deviceId !== deviceId) return { ok: false, code: "DEVICE_MISMATCH", status: 403 };
  if (!session || session.revoked_at || new Date(session.expires_at).getTime() <= now) {
    return { ok: false, code: "SESSION_EXPIRED", status: 401 };
  }
  if (session.user_id !== verified.userId || session.device_id !== verified.deviceId) {
    return { ok: false, code: "SESSION_MISMATCH", status: 403 };
  }
  return {
    ok: true,
    account: { userId: verified.userId, sessionId: verified.sessionId, deviceId: verified.deviceId },
  };
}

/**
 * Request wrapper: verifies the bearer access token, loads the session row, and
 * on failure sends the mapped status/code and returns null. On success returns
 * { userId, sessionId, deviceId }. `input.deviceId` is the client-declared
 * device the token must be bound to.
 */
export async function requireAccountSession(request, reply, input) {
  const verified = verifyAccessToken(bearerToken(request));
  const session = verified?.ok
    ? await db.selectFrom("user_sessions").selectAll().where("id", "=", verified.sessionId).executeTakeFirst()
    : null;
  const decision = evaluateAccountSession({ verified, deviceId: input?.deviceId, session });
  if (!decision.ok) {
    reply.code(decision.status || 401).send({ ok: false, code: decision.code });
    return null;
  }
  return decision.account;
}
