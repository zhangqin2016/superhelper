import { z } from "zod";
import { db } from "../../db.js";
import { zodBody, okResponse } from "../../openapi.js";
import { ORG_ROLES, effectiveWeeklyBudget, weeklyWindow } from "../../services/enterprise.js";
import { createEnterpriseMutationService } from "../../services/enterprise-mutations.js";
import { listInvitations } from "../../services/enterprise-invitations.js";
import { enterpriseMutationResponse, enterpriseScope, memberIdentities, requireOrgRole } from "./enterprise-route-support.js";

const orgIdSchema = z.object({ id: z.string().min(3).max(120) });
const memberParamsSchema = z.object({ id: z.string().min(3).max(120), userId: z.string().min(3).max(120) });
const invitationParamsSchema = z.object({ id: z.string().min(3).max(120), invitationId: z.string().min(3).max(120) });
const addMemberSchema = z.object({
  userId: z.string().min(3).max(120).optional(),
  phoneE164: z.string().min(5).max(32).optional(),
  role: z.enum([...ORG_ROLES]).default("member"),
}).refine((value) => Boolean(value.userId || value.phoneE164), { message: "userId or phoneE164 required" });
const patchMemberSchema = z.object({
  role: z.enum([...ORG_ROLES]).optional(),
  status: z.enum(["active", "disabled"]).optional(),
  memberQuota: z.number().int().min(0).nullable().optional(),
  // null = use the organization's default weekly budget.
  weeklyBudget: z.number().int().min(0).nullable().optional(),
}).refine((value) => value.role !== undefined || value.status !== undefined || value.memberQuota !== undefined || value.weeklyBudget !== undefined, { message: "at least one field required" });
const listSchema = z.object({
  q: z.string().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(500).catch(200).default(200),
  offset: z.coerce.number().int().min(0).catch(0).default(0),
});

export function registerPublicEnterpriseMemberRoutes(app) {
  const mutations = createEnterpriseMutationService(db);
  const scope = enterpriseScope;
  app.get(
    "/api/enterprise/organizations/:id/members",
    {
      schema: {
        tags: ["public:enterprise"],
        summary: "List organization members",
        params: orgIdSchema,
        querystring: zodBody(listSchema),
        response: { 200: okResponse({ members: { type: "array" }, total: { type: "number" } }) },
      },
    },
    async (request, reply) => {
      const viewer = await requireOrgRole(request, reply, request.params.id, "member");
      if (!viewer) return;
      const input = listSchema.parse(request.query || {});
      const organization = await db.selectFrom("organizations").select(["default_member_weekly_budget"]).where("id", "=", request.params.id).executeTakeFirst();
      let query = db
        .selectFrom("organization_members")
        .innerJoin("users", "users.id", "organization_members.user_id")
        .where("organization_members.organization_id", "=", request.params.id);
      const q = String(input.q || "").trim();
      if (q) {
        const like = `%${q.replace(/[%_\\]/g, (c) => "\\" + c)}%`;
        query = query.where((eb) => eb.or([
          eb("users.login_name", "ilike", like), eb("users.display_name", "ilike", like),
          eb("users.phone_e164", "like", like), eb("users.id", "=", q),
        ]));
      }
      const total = Number((await query.select((eb) => eb.fn.countAll().as("n")).executeTakeFirst())?.n || 0);
      const rows = await query
        .select(["organization_members.user_id", "organization_members.role", "organization_members.status", "organization_members.quota",
          "organization_members.joined_at", "organization_members.weekly_budget", "organization_members.weekly_window_started_at", "organization_members.weekly_used"])
        .orderBy("organization_members.joined_at", "asc").orderBy("organization_members.user_id", "asc")
        .limit(input.limit).offset(input.offset)
        .execute();
      const identities = await memberIdentities(db, rows.map((row) => row.user_id));
      const admin = viewer.role === "owner" || viewer.role === "admin";
      const members = rows.map((row) => {
        const weekly = weeklyWindow({ windowStartedAt: row.weekly_window_started_at, used: Number(row.weekly_used || 0) });
        return {
          user_id: row.user_id, role: row.role, status: row.status, joined_at: row.joined_at,
          ...identities.get(row.user_id),
          issued: identities.get(row.user_id)?.issuedBy === request.params.id,
          // Budgets and caps are the roster's business, not every colleague's.
          ...(admin ? {
            quota: row.quota,
            weeklyBudget: row.weekly_budget,
            effectiveWeeklyBudget: effectiveWeeklyBudget(row.weekly_budget, organization?.default_member_weekly_budget),
            weeklyUsed: weekly.used,
            weeklyResetsAt: weekly.resetsAt,
          } : {}),
        };
      });
      return { ok: true, members, total, limit: input.limit, offset: input.offset };
    },
  );

  app.post(
    "/api/enterprise/organizations/:id/members",
    {
      schema: {
        tags: ["public:enterprise"],
        summary: "Add a member (by userId or phoneE164)",
        params: orgIdSchema,
        body: zodBody(addMemberSchema),
        response: { 200: okResponse({ member: { type: "object" } }) },
      },
    },
    async (request, reply) => {
      const input = addMemberSchema.parse(request.body);
      return enterpriseMutationResponse(reply, () => mutations.addMember(scope(request), input));
    },
  );

  // Seats handed to staff who have no account yet. They are not members until
  // they log in, so they live beside the member list rather than inside it.
  app.get(
    "/api/enterprise/organizations/:id/invitations",
    {
      schema: {
        tags: ["public:enterprise"],
        summary: "List pending seat invitations",
        params: orgIdSchema,
        response: { 200: okResponse({ invitations: { type: "array" } }) },
      },
    },
    async (request, reply) => {
      if (!await requireOrgRole(request, reply, request.params.id, "admin")) return;
      return { ok: true, invitations: await listInvitations(db, request.params.id) };
    },
  );

  app.delete(
    "/api/enterprise/organizations/:id/invitations/:invitationId",
    {
      schema: {
        tags: ["public:enterprise"],
        summary: "Revoke a pending seat invitation",
        params: invitationParamsSchema,
        response: { 200: okResponse({ revoked: { type: "boolean" } }) },
      },
    },
    async (request, reply) => {
      return enterpriseMutationResponse(reply, () => mutations.revokeInvitation(scope(request), request.params.invitationId));
    },
  );

  app.patch(
    "/api/enterprise/organizations/:id/members/:userId",
    {
      schema: {
        tags: ["public:enterprise"],
        summary: "Change member role / status / quota",
        params: memberParamsSchema,
        body: zodBody(patchMemberSchema),
        response: { 200: okResponse({ member: { type: "object" } }) },
      },
    },
    async (request, reply) => {
      const input = patchMemberSchema.parse(request.body);
      return enterpriseMutationResponse(reply, () => mutations.changeMember(scope(request), request.params.userId, input));
    },
  );

  app.delete(
    "/api/enterprise/organizations/:id/members/:userId",
    {
      schema: {
        tags: ["public:enterprise"],
        summary: "Remove a member",
        params: memberParamsSchema,
        response: { 200: okResponse({ removed: { type: "boolean" } }) },
      },
    },
    async (request, reply) => {
      return enterpriseMutationResponse(reply, () => mutations.changeMember(scope(request), request.params.userId, {}, true));
    },
  );
}
