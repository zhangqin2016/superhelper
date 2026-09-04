import { z } from "zod";
import { db } from "../../db.js";
import { zodBody, okResponse } from "../../openapi.js";
import { createEnterpriseMutationService } from "../../services/enterprise-mutations.js";
import { ENTERPRISE_ACCOUNT_LIMITS } from "../../services/enterprise-accounts.js";
import { enterpriseMutationResponse, requireOrgRole } from "./enterprise-route-support.js";

/**
 * Enterprise-issued accounts — the company generates dedicated logins.
 *
 * Distinct from members (attach an existing user) and invitations (a seat for
 * a phone that has not registered): here the company CREATES the identity. The
 * initial password is returned exactly once in the provisioning response and
 * never stored; the employee must change it on first login.
 */

const orgIdSchema = z.object({ id: z.string().min(3).max(120) });
const accountParamsSchema = z.object({ id: z.string().min(3).max(120), userId: z.string().min(3).max(120) });
// Either an explicit list, or a prefix + count that the server numbers
// sequentially (MAX + 20 -> max_0001..max_0020, continuing after the last
// batch). The server does the numbering so two admins cannot both take 0001.
const provisionSchema = z.object({
  accounts: z.array(z.object({
    loginName: z.string().min(3).max(40).optional(),
    displayName: z.string().max(80).optional(),
    role: z.enum(["admin", "member"]).default("member"),
  })).max(ENTERPRISE_ACCOUNT_LIMITS.MAX_BATCH).optional(),
  pattern: z.object({
    prefix: z.string().min(1).max(20),
    count: z.number().int().min(1).max(ENTERPRISE_ACCOUNT_LIMITS.MAX_BATCH),
    role: z.enum(["admin", "member"]).default("member"),
  }).optional(),
}).refine((value) => (value.accounts && value.accounts.length > 0) || value.pattern, { message: "accounts or pattern required" });

export function registerPublicEnterpriseAccountRoutes(app) {
  const mutations = createEnterpriseMutationService(db);
  const scope = (request) => ({ organizationId: request.params.id, account: request.user });

  app.get(
    "/api/enterprise/organizations/:id/accounts",
    {
      schema: {
        tags: ["public:enterprise"],
        summary: "List accounts this organization issued",
        params: orgIdSchema,
        response: { 200: okResponse({ accounts: { type: "array" } }) },
      },
    },
    async (request, reply) => {
      if (!await requireOrgRole(request, reply, request.params.id, "admin")) return;
      const rows = await db
        .selectFrom("users")
        .innerJoin("organization_members", (join) => join
          .onRef("organization_members.user_id", "=", "users.id")
          .on("organization_members.organization_id", "=", request.params.id))
        .select([
          "users.id as userId",
          "users.login_name as loginName",
          "users.display_name as displayName",
          "users.status as status",
          "users.password_must_change as passwordMustChange",
          "users.last_login_at as lastLoginAt",
          "organization_members.role as role",
          "organization_members.status as memberStatus",
        ])
        .where("users.provisioned_organization_id", "=", request.params.id)
        .orderBy("users.created_at", "asc")
        .execute();
      return { ok: true, accounts: rows };
    },
  );

  app.post(
    "/api/enterprise/organizations/:id/accounts",
    {
      schema: {
        tags: ["public:enterprise"],
        summary: "Issue dedicated accounts — explicit list or prefix+count sequence (initial passwords returned once)",
        params: orgIdSchema,
        body: zodBody(provisionSchema),
        response: { 200: okResponse({ accounts: { type: "array" } }) },
      },
    },
    async (request, reply) => {
      const input = provisionSchema.parse(request.body);
      return enterpriseMutationResponse(reply, () => mutations.provisionAccounts(scope(request), input));
    },
  );

  app.post(
    "/api/enterprise/organizations/:id/accounts/:userId/reset-password",
    {
      schema: {
        tags: ["public:enterprise"],
        summary: "Issue a new one-time password for an issued account",
        params: accountParamsSchema,
        response: { 200: okResponse({ loginName: { type: "string" }, initialPassword: { type: "string" } }) },
      },
    },
    async (request, reply) => {
      return enterpriseMutationResponse(reply, () => mutations.resetIssuedPassword(scope(request), request.params.userId));
    },
  );
}
