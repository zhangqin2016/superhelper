// Enterprise Organizations — web-session API for org owners/admins/members.
// See docs/enterprise-organizations-design.md §7. Auth: requireWebAccount
// (lily_user_session cookie) + requireOrgRole for org-scoped operations.
//
// Roles: owner > admin > member. Member can only read their own orgs.

import { z } from "zod";
import { db } from "../../db.js";
import { zodBody, okResponse } from "../../openapi.js";
import { publicId } from "../../services/ids.js";
import { verifyAccessToken, verifyWebSessionToken } from "../../services/account-auth.js";
import { fetchOrgGrants, memberWeeklyStatus } from "../../services/wallet.js";
import { registerPublicEnterpriseMemberRoutes } from "./enterprise-members.js";
import { registerPublicEnterpriseAccountRoutes } from "./enterprise-accounts.js";
import { registerPublicEnterpriseAgentRoutes } from "./enterprise-agents.js";
import { enterpriseMutationResponse, enterpriseScope, memberIdentities, requireOrgRole } from "./enterprise-route-support.js";
import { createEnterpriseMutationService } from "../../services/enterprise-mutations.js";

const orgIdSchema = z.object({ id: z.string().min(3).max(120) });
const ALLOW_SELF_SERVE_ORGS = false;
const createOrgSchema = z.object({
  name: z.string().min(1).max(120),
});
const patchOrgSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  // The enterprise's own pause (owner only). A platform freeze is not this.
  status: z.enum(["active", "disabled"]).optional(),
  defaultMemberWeeklyBudget: z.number().int().min(0).nullable().optional(),
}).refine((v) => v.name !== undefined || v.status !== undefined || v.defaultMemberWeeklyBudget !== undefined, { message: "at least one field required" });
// A hand-typed ?days=abc used to throw a 400 that blanked the whole page.
const usageSchema = z.object({
  days: z.coerce.number().int().min(1).max(365).catch(30).default(30),
});
const memberTargetSchema = z.object({ userId: z.string().min(3).max(120) });
const auditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).catch(50).default(50),
  before: z.coerce.number().int().min(1).optional().catch(undefined),
});

/** Look up an organization; 404 when missing. */
async function findOrg(organizationId) {
  return db.selectFrom("organizations").selectAll().where("id", "=", organizationId).executeTakeFirst();
}

async function orgSummaries(rows) {
  // A user with no organizations must get an empty list, not a 500: an empty
  // `in ()` is a Postgres syntax error (seen ~14x/day in production logs).
  if (!rows.length) return [];
  const orgIds = rows.map((r) => r.id);
  const memberCounts = await db
    .selectFrom("organization_members")
    .select(["organization_id"])
    .select((eb) => eb.fn.count("user_id").as("member_count"))
    .where("organization_id", "in", orgIds)
    .groupBy("organization_id")
    .execute();
  const counts = new Map(memberCounts.map((r) => [r.organization_id, Number(r.member_count || 0)]));
  return rows.map((row) => ({ ...row, member_count: counts.get(row.id) || 0 }));
}

/** Usage aggregate by member + by model for an org (last N days). */
async function orgUsage(organizationId, days = 30) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const byMember = await db
    .selectFrom("usage_events")
    .select(["user_id"])
    .select((eb) => [
      eb.fn.count("id").as("request_count"),
      eb.fn.sum("billable_units").as("units"),
      eb.fn.sum("billable_tokens").as("tokens"),
    ])
    .where("organization_id", "=", organizationId)
    .where("created_at", ">=", since)
    .groupBy("user_id")
    .orderBy("units", "desc")
    .execute();
  const byModel = await db
    .selectFrom("usage_events")
    .select(["model"])
    .select((eb) => [
      eb.fn.count("id").as("request_count"),
      eb.fn.sum("billable_units").as("units"),
    ])
    .where("organization_id", "=", organizationId)
    .where("created_at", ">=", since)
    .groupBy("model")
    .orderBy("units", "desc")
    .execute();
  const identities = await memberIdentities(db, byMember.map((row) => row.user_id));
  const members = byMember.map((row) => ({ ...row, ...identities.get(row.user_id) }));
  const totals = members.reduce((sum, row) => ({
    requests: sum.requests + Number(row.request_count || 0),
    units: sum.units + Number(row.units || 0),
    tokens: sum.tokens + Number(row.tokens || 0),
  }), { requests: 0, units: 0, tokens: 0 });
  return { days, byMember: members, byModel, totals };
}

export function registerPublicEnterpriseRoutes(app) {
  const mutations = createEnterpriseMutationService(db);
  // All enterprise endpoints require a logged-in web user. Two auth surfaces:
  // 1. web session cookie (lily_user_session) — browser admin pages;
  // 2. Bearer account access token — desktop client.
  // Populate request.user for handlers; unauthorized -> 401.
  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api/enterprise/")) return;
    const bearer = String(request.headers.authorization || "");
    const accessToken = bearer.startsWith("Bearer ") ? bearer.slice(7).trim() : "";
    const sessionToken = request.cookies?.lily_user_session || "";
    const access = accessToken ? verifyAccessToken(accessToken) : { ok: false };
    const session = sessionToken ? verifyWebSessionToken(sessionToken) : { ok: false };
    const verified = access.ok ? access : session.ok ? session : null;
    if (!verified) {
      reply.code(401).send({ ok: false, code: "USER_LOGIN_REQUIRED" });
      return;
    }
    const liveSession = await db
      .selectFrom("user_sessions")
      .selectAll()
      .where("id", "=", verified.sessionId)
      .executeTakeFirst();
    if (!liveSession || liveSession.user_id !== verified.userId || liveSession.revoked_at || new Date(liveSession.expires_at).getTime() <= Date.now()) {
      reply.code(401).send({ ok: false, code: "USER_LOGIN_REQUIRED" });
      return;
    }
    const user = await db.selectFrom("users").select(["status", "password_must_change"]).where("id", "=", verified.userId).executeTakeFirst();
    if (!user || user.status !== "active") return reply.code(403).send({ ok: false, code: "USER_DISABLED" });
    if (user.password_must_change) return reply.code(403).send({ ok: false, code: "PASSWORD_CHANGE_REQUIRED" });
    request.user = { userId: verified.userId, sessionId: verified.sessionId };
  });
  registerPublicEnterpriseMemberRoutes(app);
  registerPublicEnterpriseAccountRoutes(app);
  registerPublicEnterpriseAgentRoutes(app);

  // GET /api/enterprise/organizations — my orgs
  app.get(
    "/api/enterprise/organizations",
    {
      schema: {
        tags: ["public:enterprise"],
        summary: "List my organizations",
        response: { 200: okResponse({ organizations: { type: "array" } }) },
      },
    },
    async (request, reply) => {
      if (!request.user) {
        reply.code(401).send({ ok: false, code: "USER_LOGIN_REQUIRED" });
        return;
      }
      const rows = await db
        .selectFrom("organization_members")
        .innerJoin("organizations", "organizations.id", "organization_members.organization_id")
        .select([
          "organizations.id",
          "organizations.name",
          "organizations.status",
          "organizations.owner_status",
          "organizations.platform_status",
          "organizations.source",
          "organizations.plan",
          "organizations.created_at",
          "organization_members.role",
          "organization_members.status as membership_status",
        ])
        .where("organization_members.user_id", "=", request.user.userId)
        .orderBy("organizations.created_at", "asc")
        .execute();
      const rowsWithCounts = await orgSummaries(rows);
      return { ok: true, organizations: rowsWithCounts };
    },
  );

  // POST /api/enterprise/organizations — create, creator becomes owner
  app.post(
    "/api/enterprise/organizations",
    {
      schema: {
        tags: ["public:enterprise"],
        summary: "Create an organization (creator becomes owner)",
        body: zodBody(createOrgSchema),
        response: { 200: okResponse({ organization: { type: "object" } }) },
      },
    },
    async (request, reply) => {
      if (!request.user) {
        reply.code(401).send({ ok: false, code: "USER_LOGIN_REQUIRED" });
        return;
      }
      // Enterprises are opened by the platform (sales handoff, owner issued or
      // named there). Self-serve creation let anyone mint an org and then issue
      // unlimited password accounts that take global login names. Orgs already
      // created this way keep working; admin lists them as source=self_serve.
      if (!ALLOW_SELF_SERVE_ORGS) return reply.code(403).send({ ok: false, code: "ORG_CREATE_PLATFORM_ONLY" });
      const input = createOrgSchema.parse(request.body);
      const id = publicId("org");
      await db.transaction().execute(async (trx) => {
        await trx
          .insertInto("organizations")
          .values({ id, name: input.name, status: "active", plan: "standard", source: "self_serve" })
          .execute();
        await trx
          .insertInto("organization_members")
          .values({
            organization_id: id,
            user_id: request.user.userId,
            role: "owner",
            status: "active",
            quota: null,
          })
          .execute();
      });
      const org = await findOrg(id);
      return { ok: true, organization: org };
    },
  );

  // GET /api/enterprise/organizations/:id — org detail (members only)
  app.get(
    "/api/enterprise/organizations/:id",
    {
      schema: {
        tags: ["public:enterprise"],
        summary: "Organization detail (with quota summary)",
        params: orgIdSchema,
        response: { 200: okResponse({ organization: { type: "object" } }) },
      },
    },
    async (request, reply) => {
      const membership = await requireOrgRole(request, reply, request.params.id, "member");
      if (!membership) return;
      const org = await findOrg(request.params.id);
      if (!org) {
        reply.code(404).send({ ok: false, code: "ORG_NOT_FOUND" });
        return;
      }
      // The pool is the admins' view (the grants page is owner-only, and this
      // detail used to hand it to every member). A member sees their own week.
      const admin = membership.role === "owner" || membership.role === "admin";
      const quotaSummary = admin ? (await fetchOrgGrants(request.params.id)).map((g) => ({
        id: g.id,
        resource_type: g.resource_type,
        status: g.status,
        unit_total: Number(g.unit_total || 0),
        unit_remaining: Number(g.unit_remaining || 0),
        expires_at: g.expires_at,
      })) : undefined;
      const me = await memberWeeklyStatus({ userId: request.user.userId, organizationId: request.params.id });
      return { ok: true, organization: { ...org, role: membership.role, ...(admin ? { quota: quotaSummary } : {}), me: me.ok ? me : { ok: false, code: me.code } } };
    },
  );

  // PATCH /api/enterprise/organizations/:id — rename / disable (owner/admin)
  app.patch(
    "/api/enterprise/organizations/:id",
    {
      schema: {
        tags: ["public:enterprise"],
        summary: "Rename or disable an organization",
        params: orgIdSchema,
        body: zodBody(patchOrgSchema),
        response: { 200: okResponse({ organization: { type: "object" } }) },
      },
    },
    async (request, reply) => {
      const input = patchOrgSchema.parse(request.body);
      return enterpriseMutationResponse(reply, () => mutations.changeOrganization(enterpriseScope(request), input));
    },
  );

  // POST /api/enterprise/organizations/:id/transfer-ownership — owner hands over
  app.post("/api/enterprise/organizations/:id/transfer-ownership", {
    schema: { tags: ["public:enterprise"], summary: "Transfer ownership to an active member (caller becomes admin)",
      params: orgIdSchema, body: zodBody(memberTargetSchema), response: { 200: okResponse({ transferred: { type: "boolean" } }) } },
  }, async (request, reply) => {
    const input = memberTargetSchema.parse(request.body);
    return enterpriseMutationResponse(reply, () => mutations.transferOwnership(enterpriseScope(request), input.userId));
  });

  // POST /api/enterprise/organizations/:id/leave — leave on your own
  app.post("/api/enterprise/organizations/:id/leave", {
    schema: { tags: ["public:enterprise"], summary: "Leave an organization", params: orgIdSchema, response: { 200: okResponse({ left: { type: "boolean" } }) } },
  }, async (request, reply) => enterpriseMutationResponse(reply, () => mutations.leaveOrganization(enterpriseScope(request))));

  // GET /api/enterprise/organizations/:id/audit — who changed what (admin+)
  app.get("/api/enterprise/organizations/:id/audit", {
    schema: { tags: ["public:enterprise"], summary: "Organization change history", params: orgIdSchema, querystring: zodBody(auditQuerySchema),
      response: { 200: okResponse({ entries: { type: "array" } }) } },
  }, async (request, reply) => {
    if (!await requireOrgRole(request, reply, request.params.id, "admin")) return;
    const input = auditQuerySchema.parse(request.query || {});
    let query = db.selectFrom("audit_logs").select(["id", "actor", "action", "metadata", "created_at"])
      .where("target_type", "=", "organization").where("target_id", "=", request.params.id);
    if (input.before) query = query.where("id", "<", input.before);
    const rows = await query.orderBy("id", "desc").limit(input.limit).execute();
    const actorIds = [...new Set(rows.map((row) => String(row.actor || "")).filter((a) => a.startsWith("user:")).map((a) => a.slice(5)))];
    const identities = await memberIdentities(db, actorIds);
    const entries = rows.map((row) => {
      const actor = String(row.actor || "");
      const userId = actor.startsWith("user:") ? actor.slice(5) : null;
      // The platform acts as "the platform" here, never by operator identity.
      return { id: Number(row.id), action: row.action, metadata: row.metadata, createdAt: row.created_at,
        actor: userId ? { kind: "member", userId, ...identities.get(userId) } : { kind: "platform" } };
    });
    return { ok: true, entries, nextBefore: rows.length === input.limit ? Number(rows.at(-1).id) : null };
  });

  // GET /api/enterprise/organizations/:id/grants — org quota pool (owner/admin)
  app.get(
    "/api/enterprise/organizations/:id/grants",
    {
      schema: {
        tags: ["public:enterprise"],
        summary: "List organization quota pool",
        params: orgIdSchema,
        response: { 200: okResponse({ grants: { type: "array" } }) },
      },
    },
    async (request, reply) => {
      const membership = await requireOrgRole(request, reply, request.params.id, "owner");
      if (!membership) return;
      const grants = await fetchOrgGrants(request.params.id);
      return { ok: true, grants };
    },
  );

  // POST /api/enterprise/organizations/:id/grants — (二期: real self-service top-up)
  // Phase 1 keeps the endpoint absent-or-403 so admins know top-up is via platform admin.

  // GET /api/enterprise/organizations/:id/usage
  app.get(
    "/api/enterprise/organizations/:id/usage",
    {
      schema: {
        tags: ["public:enterprise"],
        summary: "Organization usage (by member / by model)",
        params: orgIdSchema,
        querystring: zodBody(usageSchema),
        response: { 200: okResponse({ usage: { type: "object" } }) },
      },
    },
    async (request, reply) => {
      const membership = await requireOrgRole(request, reply, request.params.id, "admin");
      if (!membership) return;
      const input = usageSchema.parse(request.query);
      const usage = await orgUsage(request.params.id, input.days);
      return { ok: true, usage };
    },
  );
}
