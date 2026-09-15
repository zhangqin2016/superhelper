// Public agent registry — GET /api/agents/registry?channel=stable
//
// Auth is the enterprise dual surface (Bearer account access token, or the
// lily_user_session cookie) but OPTIONAL: anonymous callers get the global
// enabled packages; an authenticated caller additionally gets the packages
// published to organizations they are an ACTIVE member of. An invalid or
// stale token is treated as anonymous (never a 401 — the registry must keep
// working for clients that have not logged in), and organization packages
// are only ever selected through the membership join, so they cannot leak.
import { db } from "../../db.js";
import { config } from "../../config.js";
import { verifyAccessToken, verifyWebSessionToken } from "../../services/account-auth.js";
import { signConfigPayload } from "../../services/security.js";
import { buildAgentRegistry, listVisibleAgentPackages } from "../../services/agent-packages.js";

function requestBaseUrl(request) {
  const configured = String(config.publicBaseUrl || "").trim().replace(/\/+$/, "");
  if (configured) return configured;
  const forwardedProto = String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const proto = forwardedProto || request.protocol || "http";
  const host = String(request.headers["x-forwarded-host"] || request.headers.host || request.hostname || "")
    .split(",")[0]
    .trim();
  return host ? `${proto}://${host}`.replace(/\/+$/, "") : "";
}

/** Optional caller identity: {userId} for a live, active session; else null. */
async function optionalAccount(request) {
  const bearer = String(request.headers.authorization || "");
  const accessToken = bearer.startsWith("Bearer ") ? bearer.slice(7).trim() : "";
  const sessionToken = request.cookies?.lily_user_session || "";
  const access = accessToken ? verifyAccessToken(accessToken) : { ok: false };
  const session = sessionToken ? verifyWebSessionToken(sessionToken) : { ok: false };
  const verified = access.ok ? access : session.ok ? session : null;
  if (!verified) return null;
  const liveSession = await db
    .selectFrom("user_sessions")
    .select(["id", "user_id", "expires_at", "revoked_at"])
    .where("id", "=", verified.sessionId)
    .executeTakeFirst();
  if (!liveSession || liveSession.user_id !== verified.userId || liveSession.revoked_at || new Date(liveSession.expires_at).getTime() <= Date.now()) {
    return null;
  }
  const user = await db.selectFrom("users").select(["status"]).where("id", "=", verified.userId).executeTakeFirst();
  if (!user || user.status !== "active") return null;
  return { userId: verified.userId };
}

async function activeOrganizationIds(userId) {
  if (!userId) return [];
  const rows = await db
    .selectFrom("organization_members")
    .innerJoin("organizations", "organizations.id", "organization_members.organization_id")
    .select("organization_members.organization_id")
    .where("organization_members.user_id", "=", userId)
    .where("organization_members.status", "=", "active")
    .where("organizations.status", "=", "active")
    .execute();
  return rows.map((row) => row.organization_id);
}

export function registerPublicAgentRoutes(app) {
  app.get(
    "/api/agents/registry",
    {
      schema: {
        tags: ["public:agents"],
        summary: "Get the signed agent registry",
        description:
          "Enabled agent packages for the channel: global ones for everyone, plus organization-scoped ones for the caller's active organizations when a valid account token / session is presented.",
        querystring: {
          type: "object",
          properties: { channel: { type: "string", default: "stable" } },
        },
      },
    },
    async (request, reply) => {
      const channel = String(request.query?.channel || "stable").trim().toLowerCase() || "stable";
      const account = await optionalAccount(request);
      const organizationIds = await activeOrganizationIds(account?.userId);
      const rows = await listVisibleAgentPackages(db, { channel, organizationIds });
      const baseUrl = requestBaseUrl(request);
      let registry;
      try {
        registry = buildAgentRegistry(rows, {
          channel,
          registryUrl: `${baseUrl}/api/agents/registry`,
          signer: signConfigPayload,
        });
      } catch (error) {
        // No signing key and unsigned mode not allowed: refuse loudly rather
        // than hand out an unsigned registry the client would have to trust.
        request.log.error({ error }, "agent registry signing unavailable");
        return reply.code(503).send({ ok: false, code: "AGENT_REGISTRY_SIGNING_UNAVAILABLE" });
      }
      return { ok: true, ...registry };
    },
  );
}
