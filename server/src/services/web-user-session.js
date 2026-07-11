import { db } from "../db.js";
import { verifyWebSessionToken } from "./account-auth.js";

export function classifyWebSession({ verified, session, now = Date.now() } = {}) {
  if (!verified?.ok || !session) return { ok: false, code: "USER_LOGIN_REQUIRED" };
  if (session.id !== verified.sessionId || session.user_id !== verified.userId) {
    return { ok: false, code: "USER_LOGIN_REQUIRED" };
  }
  if (session.revoked_at) return { ok: false, code: "USER_LOGIN_REQUIRED" };
  if (new Date(session.expires_at || 0).getTime() <= now) {
    return { ok: false, code: "USER_LOGIN_REQUIRED" };
  }
  return { ok: true, userId: verified.userId, sessionId: verified.sessionId };
}

export async function resolveWebUser(request) {
  const sessionToken = request.cookies?.lily_user_session || "";
  const verified = verifyWebSessionToken(sessionToken);
  if (!verified.ok) return { ok: false, code: "USER_LOGIN_REQUIRED" };
  const session = await db
    .selectFrom("user_sessions")
    .selectAll()
    .where("id", "=", verified.sessionId)
    .executeTakeFirst();
  return classifyWebSession({ verified, session });
}

export async function requireWebUser(request, reply) {
  const result = await resolveWebUser(request);
  if (result.ok) return result;
  reply.code(401).send({ ok: false, code: "USER_LOGIN_REQUIRED" });
  return null;
}
