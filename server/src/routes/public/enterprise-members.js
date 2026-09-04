import { z } from "zod";
import { db } from "../../db.js";
import { zodBody, okResponse } from "../../openapi.js";
import { ORG_ROLES } from "../../services/enterprise.js";
import { createEnterpriseMutationService } from "../../services/enterprise-mutations.js";
import { listInvitations } from "../../services/enterprise-invitations.js";
import { enterpriseMutationResponse, requireOrgRole } from "./enterprise-route-support.js";

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
}).refine((value) => value.role !== undefined || value.status !== undefined || value.memberQuota !== undefined, { message: "at least one field required" });

export function registerPublicEnterpriseMemberRoutes(app) {
  const mutations = createEnterpriseMutationService(db);
  const scope = (request) => ({ organizationId: request.params.id, account: request.user });
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
