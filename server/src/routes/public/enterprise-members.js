import { z } from "zod";
import { db } from "../../db.js";
import { zodBody, okResponse } from "../../openapi.js";
import { ORG_ROLES, canChangeMemberRole, canManageMember, normalizeQuota } from "../../services/enterprise.js";
import { orgMembership, requireOrgRole } from "./enterprise-route-support.js";

const orgIdSchema = z.object({ id: z.string().min(3).max(120) });
const memberParamsSchema = z.object({ id: z.string().min(3).max(120), userId: z.string().min(3).max(120) });
const addMemberSchema = z.object({
  userId: z.string().min(3).max(120).optional(),
  phoneE164: z.string().min(5).max(32).optional(),
  role: z.enum([...ORG_ROLES]).default("member"),
}).refine((value) => Boolean(value.userId || value.phoneE164), { message: "userId or phoneE164 required" });
const patchMemberSchema = z.object({
  role: z.enum([...ORG_ROLES]).optional(),
  status: z.enum(["active", "disabled"]).optional(),
  memberQuota: z.number().int().min(0).nullable().optional(),
}).refine((value) => value.role !== undefined || value.status !== undefined || value.memberQuota !== undefined, { message: "at least one field required" });

export function registerPublicEnterpriseMemberRoutes(app) {
  app.get(
    "/api/enterprise/organizations/:id/members",
    {
      schema: {
        tags: ["public:enterprise"],
        summary: "List organization members",
        params: orgIdSchema,
        response: { 200: okResponse({ members: { type: "array" } }) },
      },
    },
    async (request, reply) => {
      if (!await requireOrgRole(request, reply, request.params.id, "member")) return;
      const rows = await db
        .selectFrom("organization_members")
        .select(["user_id", "role", "status", "quota", "joined_at"])
        .where("organization_id", "=", request.params.id)
        .orderBy("joined_at", "asc")
        .execute();
      return { ok: true, members: rows };
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
      const membership = await requireOrgRole(request, reply, request.params.id, "admin");
      if (!membership) return;
      const input = addMemberSchema.parse(request.body);
      let targetUserId = input.userId;
      if (!targetUserId && input.phoneE164) {
        const user = await db.selectFrom("users").select("id").where("phone_e164", "=", input.phoneE164).executeTakeFirst();
        if (!user) return reply.code(404).send({ ok: false, code: "USER_NOT_FOUND" });
        targetUserId = user.id;
      }
      if (!targetUserId) return reply.code(400).send({ ok: false, code: "MEMBER_TARGET_REQUIRED" });
      const existing = await db
        .selectFrom("organization_members")
        .select("user_id")
        .where("organization_id", "=", request.params.id)
        .where("user_id", "=", targetUserId)
        .executeTakeFirst();
      if (existing) return reply.code(409).send({ ok: false, code: "MEMBER_ALREADY_EXISTS" });
      const roleChange = canChangeMemberRole("member", input.role, membership.role);
      if (!roleChange.ok) return reply.code(403).send({ ok: false, code: roleChange.code });
      await db
        .insertInto("organization_members")
        .values({ organization_id: request.params.id, user_id: targetUserId, role: input.role, status: "active", quota: null })
        .execute();
      return { ok: true, member: await orgMembership(request.params.id, targetUserId) };
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
      const membership = await requireOrgRole(request, reply, request.params.id, "admin");
      if (!membership) return;
      const input = patchMemberSchema.parse(request.body);
      const target = await orgMembership(request.params.id, request.params.userId);
      if (!target) return reply.code(404).send({ ok: false, code: "MEMBER_NOT_FOUND" });
      const isSelf = request.params.userId === request.user.userId;
      if (input.role !== undefined && input.role !== target.role) {
        const check = canChangeMemberRole(target.role, input.role, membership.role);
        if (!check.ok) return reply.code(403).send({ ok: false, code: check.code });
        if (isSelf && input.role !== "owner" && target.role === "owner") {
          return reply.code(403).send({ ok: false, code: "ORG_OWNER_IMMUTABLE" });
        }
      }
      if (input.status !== undefined && input.status !== "active") {
        const manage = canManageMember({ actorRole: membership.role, targetRole: target.role, action: "remove", self: isSelf });
        if (!manage.ok) return reply.code(403).send({ ok: false, code: manage.code });
      }
      const updated = await db
        .updateTable("organization_members")
        .set({
          ...(input.role !== undefined ? { role: input.role } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.memberQuota !== undefined ? { quota: normalizeQuota(input.memberQuota) } : {}),
        })
        .where("organization_id", "=", request.params.id)
        .where("user_id", "=", request.params.userId)
        .returningAll()
        .executeTakeFirstOrThrow();
      return { ok: true, member: updated };
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
      const membership = await requireOrgRole(request, reply, request.params.id, "admin");
      if (!membership) return;
      const target = await orgMembership(request.params.id, request.params.userId);
      if (!target) return reply.code(404).send({ ok: false, code: "MEMBER_NOT_FOUND" });
      const manage = canManageMember({
        actorRole: membership.role,
        targetRole: target.role,
        action: "remove",
        self: request.params.userId === request.user.userId,
      });
      if (!manage.ok) return reply.code(403).send({ ok: false, code: manage.code });
      await db
        .deleteFrom("organization_members")
        .where("organization_id", "=", request.params.id)
        .where("user_id", "=", request.params.userId)
        .execute();
      return { ok: true, removed: true };
    },
  );
}
