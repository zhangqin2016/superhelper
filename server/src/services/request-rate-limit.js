import { config } from "../config.js";
import { timingSafeEqualText, verifyAdminSessionToken } from "./security.js";
import { verifyAccessToken, verifyWebSessionToken } from "./account-auth.js";
import { verifyModelGatewayToken } from "./model-gateway/auth.js";

// Bucket identity comes only from server-authenticated credentials. This is
// traffic isolation, not authorization: handlers still check live sessions,
// account eligibility and permissions before doing any work.
function requestIdentity(request) {
  const authorization = String(request.headers.authorization || "");
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization)?.[1]?.trim() || "";
  if (config.adminToken && bearer && timingSafeEqualText(bearer, config.adminToken)) return "admin";
  if (request.cookies?.lily_admin_session && verifyAdminSessionToken(request.cookies.lily_admin_session)) return "admin";
  const access = bearer ? verifyAccessToken(bearer) : null;
  if (access?.ok && access.userId) return `user:${access.userId}`;
  const web = request.cookies?.lily_user_session ? verifyWebSessionToken(request.cookies.lily_user_session) : null;
  if (web?.ok && web.userId) return `user:${web.userId}`;
  const gateway = verifyModelGatewayToken(bearer || request.headers["x-api-key"] || "");
  if (gateway.ok && gateway.userId) return `user:${gateway.userId}`;
  if (gateway.ok && gateway.deviceId) return `device:${gateway.deviceId}`;
  if (gateway.ok && gateway.static) return "gateway:static";
  return `ip:${request.ip || request.headers["x-forwarded-for"] || "unknown"}`;
}

export function createRequestRateLimiter({ max = 120, windowMs = 60_000, now = Date.now } = {}) {
  const buckets = new Map();
  let nextCleanup = 0;
  return (request) => {
    const time = now();
    if (time >= nextCleanup) {
      for (const [key, bucket] of buckets) if (time >= bucket.resetAt) buckets.delete(key);
      nextCleanup = time + windowMs;
    }
    const key = requestIdentity(request);
    const bucket = buckets.get(key);
    if (!bucket || time >= bucket.resetAt) {
      buckets.set(key, { count: 1, resetAt: time + windowMs });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= max;
  };
}
