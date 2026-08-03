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
import { fetchOrgGrants } from "../../services/wallet.js";
import { registerPublicEnterpriseMemberRoutes } from "./enterprise-members.js";
import { requireOrgRole } from "./enterprise-route-support.js";

const orgIdSchema = z.object({ id: z.string().min(3).max(120) });
const createOrgSchema = z.object({
  name: z.string().min(1).max(120),
});
const patchOrgSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  status: z.enum(["active", "disabled"]).optional(),
}).refine((v) => v.name !== undefined || v.status !== undefined, { message: "at least one field required" });
const usageSchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});

/** Look up an organization; 404 when missing. */
async function findOrg(organizationId) {
  return db.selectFrom("organizations").selectAll().where("id", "=", organizationId).executeTakeFirst();
}

async function orgSummaries(rows) {
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
  return { days, byMember, byModel };
}

export function registerPublicEnterpriseRoutes(app) {
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
    request.user = { userId: verified.userId, sessionId: verified.sessionId };
  });
  registerPublicEnterpriseMemberRoutes(app);

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
      const input = createOrgSchema.parse(request.body);
      const id = publicId("org");
      await db.transaction().execute(async (trx) => {
        await trx
          .insertInto("organizations")
          .values({ id, name: input.name, status: "active", plan: "standard" })
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
      const grants = await fetchOrgGrants(request.params.id);
      const quotaSummary = grants.map((g) => ({
        id: g.id,
        resource_type: g.resource_type,
        unit_total: Number(g.unit_total || 0),
        unit_remaining: Number(g.unit_remaining || 0),
        expires_at: g.expires_at,
      }));
      return { ok: true, organization: { ...org, quota: quotaSummary } };
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
      const membership = await requireOrgRole(request, reply, request.params.id, "admin");
      if (!membership) return;
      const input = patchOrgSchema.parse(request.body);
      const org = await findOrg(request.params.id);
      if (!org) {
        reply.code(404).send({ ok: false, code: "ORG_NOT_FOUND" });
        return;
      }
      const updated = await db
        .updateTable("organizations")
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          updated_at: new Date().toISOString(),
        })
        .where("id", "=", request.params.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return { ok: true, organization: updated };
    },
  );

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
        querystring: usageSchema,
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
