// Enterprise Organizations — platform admin governance API.
// See docs/enterprise-organizations-design.md §7.1. Auth: admin session
// (assertAdmin hook in admin.js). Admin governs "switch, quota, audit" only:
// membership and roles stay with the org owner/admin.

import { z } from "zod";
import { db } from "../../db.js";
import { zodBody, okResponse } from "../../openapi.js";
import { publicId } from "../../services/ids.js";
import { config } from "../../config.js";
import { createEnterpriseMutationService } from "../../services/enterprise-mutations.js";
import { provisionAccounts, resetIssuedPassword } from "../../services/enterprise-accounts.js";
import { normalizePhoneE164 } from "../../services/account-auth.js";
import { enterpriseMutationResponse, memberIdentities } from "../public/enterprise-route-support.js";
import { grantState, registerAdminEnterpriseLedgerRoutes } from "./enterprise-ledger.js";

export { grantState };

const orgIdSchema = z.object({ id: z.string().min(3).max(120) });
const adjustGrantsSchema = z.object({
  resourceType: z.enum(["token", "image_generation", "video_generation"]),
  unitTotal: z.number().int().min(1).max(1000000000),
  expiresDays: z.number().int().min(1).max(3650).default(365),
  // One key per form render: a retry after a timeout returns the first grant
  // instead of granting twice.
  idempotencyKey: z.string().min(8).max(120).optional(),
  note: z.string().max(200).optional(),
});
const patchOrgSchema = z.object({
  // The platform's freeze. Only the platform can lift it; the enterprise's own
  // pause (owner_status) is separate and cannot override it.
  platformStatus: z.enum(["active", "suspended"]).optional(),
  // Legacy form value: disabled = suspended.
  status: z.enum(["active", "disabled"]).optional(),
  reason: z.string().max(200).optional(),
  name: z.string().min(1).max(120).optional(),
  defaultMemberWeeklyBudget: z.number().int().min(0).nullable().optional(),
}).refine((v) => v.platformStatus !== undefined || v.status !== undefined || v.name !== undefined || v.defaultMemberWeeklyBudget !== undefined, { message: "a field is required" });
const usageSchema = z.object({
  days: z.coerce.number().int().min(1).max(365).catch(30).default(30),
});
const listSchema = z.object({
  q: z.string().max(80).optional(),
  status: z.enum(["all", "active", "suspended", "paused"]).catch("all").default("all"),
  source: z.enum(["all", "platform", "self_serve"]).catch("all").default("all"),
  limit: z.coerce.number().int().min(1).max(200).catch(50).default(50),
  offset: z.coerce.number().int().min(0).catch(0).default(0),
});


/** Org with quota/member summary for admin lists. */
async function orgSummaries(rows) {
  const orgIds = rows.map((row) => row.id);
  if (orgIds.length === 0) return [];
  const memberCounts = await db
    .selectFrom("organization_members")
    .select(["organization_id"])
    .select((eb) => eb.fn.count("organization_members.user_id").as("count"))
    .where("organization_id", "in", orgIds)
    .groupBy("organization_id")
    .execute();
  const counts = new Map(memberCounts.map((row) => [row.organization_id, Number(row.count)]));
  // What the design promised the list would show (§7.1 "额度汇总") and it never
  // did: who owns it, what is left in the pool, what was used lately.
  const owners = await db.selectFrom("organization_members").select(["organization_id", "user_id"])
    .where("organization_id", "in", orgIds).where("role", "=", "owner").where("status", "=", "active")
    .orderBy("joined_at", "asc").execute();
  const ownerByOrg = new Map();
  for (const row of owners) if (!ownerByOrg.has(row.organization_id)) ownerByOrg.set(row.organization_id, row.user_id);
  const identities = await memberIdentities(db, [...new Set(ownerByOrg.values())]);
  const pool = await db.selectFrom("wallet_grants").select(["organization_id", "resource_type"])
    .select((eb) => eb.fn.sum("unit_remaining").as("remaining"))
    .where("organization_id", "in", orgIds).where("status", "=", "active").where("expires_at", ">", new Date()).where("starts_at", "<=", new Date())
    .groupBy(["organization_id", "resource_type"]).execute();
  const poolByOrg = new Map();
  for (const row of pool) poolByOrg.set(row.organization_id, { ...(poolByOrg.get(row.organization_id) || {}), [row.resource_type]: Number(row.remaining || 0) });
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const used = await db.selectFrom("usage_events").select(["organization_id"]).select((eb) => eb.fn.sum("billable_units").as("units"))
    .where("organization_id", "in", orgIds).where("created_at", ">=", since).groupBy("organization_id").execute();
  const usedByOrg = new Map(used.map((row) => [row.organization_id, Number(row.units || 0)]));
  return rows.map((row) => {
    const ownerId = ownerByOrg.get(row.id) || null;
    return { ...row, member_count: counts.get(row.id) || 0, owner: ownerId ? { userId: ownerId, ...identities.get(ownerId) } : null,
      pool: poolByOrg.get(row.id) || {}, units30d: usedByOrg.get(row.id) || 0 };
  });
}

async function orgUsage(organizationId, days = 30) {
  const since = new Date(Date.now() - Number(days) * 24 * 60 * 60 * 1000).toISOString();
  const byMember = await db
    .selectFrom("usage_events")
    .select(["user_id"])
    .select((eb) => eb.fn.sum("usage_events.billable_units").as("units"))
    .select((eb) => [eb.fn.count("usage_events.id").as("request_count"), eb.fn.sum("usage_events.billable_tokens").as("tokens")])
    .where("organization_id", "=", organizationId)
    .where("created_at", ">=", since)
    .groupBy("user_id")
    .orderBy("units", "desc")
    .execute();
  const byModel = await db
    .selectFrom("usage_events")
    .select(["model"])
    .select((eb) => [eb.fn.sum("usage_events.billable_units").as("units"), eb.fn.count("usage_events.id").as("request_count")])
    .where("organization_id", "=", organizationId)
    .where("created_at", ">=", since)
    .groupBy("model")
    .orderBy("units", "desc")
    .execute();
  const identities = await memberIdentities(db, byMember.map((row) => row.user_id));
  const members = byMember.map((row) => ({ ...row, ...identities.get(row.user_id) }));
  const totals = members.reduce((sum, row) => ({ requests: sum.requests + Number(row.request_count || 0), units: sum.units + Number(row.units || 0) }), { requests: 0, units: 0 });
  return { days, byMember: members, byModel, totals };
}

const createOrgSchema = z.object({
  name: z.string().min(1).max(120),
  plan: z.string().min(1).max(40).default("standard"),
  // Exactly one way to name the first owner: a registered phone, or an account
  // the platform issues on the spot (login name + one-time password).
  owner: z.union([
    z.object({ phoneE164: z.string().min(5).max(32) }),
    z.object({ loginName: z.string().min(3).max(40).optional(), displayName: z.string().max(80).optional(), issue: z.literal(true) }),
  ]),
});

export function registerAdminEnterpriseRoutes(app, { audit, assertAdmin }) {
  const mutations = createEnterpriseMutationService(db);

  // POST /api/admin/enterprise/organizations — create an organization FOR a
  // customer and hand it to its first owner. This is the one moment the platform
  // admin acts inside an organization; after the handoff the §7.1 boundary holds
  // and members are the owner's business alone. The initial password, when an
  // owner account is issued, is returned once and never stored.
  app.post(
    "/api/admin/enterprise/organizations",
    {
      schema: {
        tags: ["admin:enterprise"],
        summary: "Create an organization and designate its first owner",
        body: zodBody(createOrgSchema),
        response: { 200: okResponse({ organization: { type: "object" }, owner: { type: "object" } }) },
      },
    },
    async (request, reply) => {
      if (!await assertAdmin(request, reply)) return;
      const input = createOrgSchema.parse(request.body);
      const organizationId = publicId("org");
      let owner;
      try {
        owner = await db.transaction().execute(async (trx) => {
          await trx.insertInto("organizations").values({ id: organizationId, name: input.name, status: "active", plan: input.plan, source: "platform" }).execute();
          if ("phoneE164" in input.owner) {
            const phone = normalizePhoneE164(input.owner.phoneE164);
            const user = phone
              ? await trx.selectFrom("users").select(["id", "phone_e164"]).where("phone_e164", "=", phone).executeTakeFirst()
              : null;
            // An unregistered phone cannot own anything yet. Say so plainly and
            // point at the path that does work, rather than inventing a seat.
            if (!user) { const err = new Error("OWNER_NOT_REGISTERED"); err.code = "OWNER_NOT_REGISTERED"; err.statusCode = 404; throw err; }
            await trx.insertInto("organization_members").values({ organization_id: organizationId, user_id: user.id, role: "owner", status: "active", quota: null }).execute();
            return { userId: user.id, phoneE164: user.phone_e164, issued: false };
          }
          const [issued] = await provisionAccounts(trx, {
            organizationId,
            organizationName: input.name,
            requests: [{ loginName: input.owner.loginName, displayName: input.owner.displayName, role: "owner" }],
            provisionedBy: null,
            allowOwner: true,
          });
          return { userId: issued.userId, loginName: issued.loginName, initialPassword: issued.initialPassword, issued: true };
        });
      } catch (error) {
        // Only codes we raised on purpose reach the operator; a database error
        // used to come back as its Postgres code (e.g. 23505) with a 400.
        if (!(Number(error?.statusCode) >= 400 && Number(error?.statusCode) < 500 && error?.code)) throw error;
        return reply.code(Number(error.statusCode)).send({ ok: false, code: error.code });
      }
      await audit(request, "enterprise_org_create", "organization", organizationId, {
        name: input.name, plan: input.plan, ownerUserId: owner.userId, ownerIssued: owner.issued,
      });
      const organization = await db.selectFrom("organizations").selectAll().where("id", "=", organizationId).executeTakeFirst();
      return { ok: true, organization, owner };
    },
  );
  // GET /api/admin/enterprise/organizations — all orgs with summaries
  app.get(
    "/api/admin/enterprise/organizations",
    {
      schema: {
        tags: ["admin:enterprise"],
        summary: "List organizations (search by name, id, owner phone or login name)",
        querystring: zodBody(listSchema),
        response: { 200: okResponse({ organizations: { type: "array" }, total: { type: "number" } }) },
      },
    },
    async (request) => {
      const input = listSchema.parse(request.query || {});
      let query = db.selectFrom("organizations");
      const q = String(input.q || "").trim();
      if (q) {
        const like = `%${q.replace(/[%_\\]/g, (c) => "\\" + c)}%`;
        const digits = q.replace(/\D/g, "");
        query = query.where((eb) => eb.or([
          eb("organizations.name", "ilike", like),
          eb("organizations.id", "=", q),
          // Find the org from a person: any member's phone, login name or id.
          eb.exists(eb.selectFrom("organization_members").innerJoin("users", "users.id", "organization_members.user_id")
            .select("organization_members.user_id")
            .whereRef("organization_members.organization_id", "=", "organizations.id")
            .where((inner) => inner.or([
              inner("users.id", "=", q),
              inner("users.login_name", "ilike", like),
              ...(digits.length >= 7 ? [inner("users.phone_e164", "like", `%${digits}%`)] : []),
            ]))),
        ]));
      }
      if (input.status === "active") query = query.where("organizations.status", "=", "active");
      if (input.status === "suspended") query = query.where("organizations.platform_status", "=", "suspended");
      if (input.status === "paused") query = query.where("organizations.owner_status", "=", "disabled");
      if (input.source !== "all") query = query.where("organizations.source", "=", input.source);
      const total = Number((await query.select((eb) => eb.fn.countAll().as("n")).executeTakeFirst())?.n || 0);
      const rows = await query.selectAll("organizations").orderBy("organizations.created_at", "desc").orderBy("organizations.id", "desc")
        .limit(input.limit).offset(input.offset).execute();
      const summarized = await orgSummaries(rows);
      return { ok: true, organizations: summarized, total, limit: input.limit, offset: input.offset };
    },
  );

  // GET /api/admin/enterprise/organizations/:id — org detail with grants
  app.get(
    "/api/admin/enterprise/organizations/:id",
    {
      schema: {
        tags: ["admin:enterprise"],
        summary: "Get organization detail",
        params: orgIdSchema,
        response: { 200: okResponse({ organization: { type: "object" } }) },
      },
    },
    async (request, reply) => {
      const org = await db.selectFrom("organizations").selectAll().where("id", "=", request.params.id).executeTakeFirst();
      if (!org) {
        reply.code(404).send({ ok: false, code: "ORG_NOT_FOUND" });
        return;
      }
      const grants = await db.selectFrom("wallet_grants").selectAll().where("organization_id", "=", request.params.id).orderBy("expires_at", "asc").execute();
      const ownerRows = await db.selectFrom("organization_members").innerJoin("users", "users.id", "organization_members.user_id")
        .select(["users.id", "users.login_name", "users.display_name", "users.password_must_change", "users.provisioned_organization_id"])
        .where("organization_members.organization_id", "=", org.id).where("organization_members.role", "=", "owner")
        .where("organization_members.status", "=", "active").where("users.status", "=", "active").orderBy("users.id", "asc").execute();
      const owners = ownerRows.map((owner) => ({ id: owner.id, loginName: owner.login_name, displayName: owner.display_name,
        passwordMustChange: Boolean(owner.password_must_change), issued: owner.provisioned_organization_id === org.id }));
      const memberCount = Number((await db.selectFrom("organization_members").select((eb) => eb.fn.countAll().as("n")).where("organization_id", "=", org.id).executeTakeFirst())?.n || 0);
      const pendingInvitations = Number((await db.selectFrom("organization_invitations").select((eb) => eb.fn.countAll().as("n"))
        .where("organization_id", "=", org.id).where("status", "=", "pending").executeTakeFirst())?.n || 0);
      const now = new Date();
      return { ok: true, organization: { ...org, grants: grants.map((grant) => ({ ...grant, state: grantState(grant, now) })), owners, memberCount, pendingInvitations } };
    },
  );

  // Recover only the initial handoff. Once the owner changes their password,
  // platform governance cannot reset their credentials or manage membership.
  const ownerInitialPasswordSchema = z.object({ userId: z.string().min(3).max(120) });
  app.post("/api/admin/enterprise/organizations/:id/owner-initial-password", {
    schema: { tags: ["admin:enterprise"], summary: "Reissue an unactivated issued owner's initial password",
      params: orgIdSchema, body: zodBody(ownerInitialPasswordSchema), response: { 200: okResponse({ owner: { type: "object" } }) } },
  }, async (request, reply) => {
    const input = ownerInitialPasswordSchema.parse(request.body);
    const result = await enterpriseMutationResponse(reply, () => db.transaction().execute(async (trx) => {
      const org = await trx.selectFrom("organizations").select(["id", "status"]).where("id", "=", request.params.id).forUpdate().executeTakeFirst();
      if (!org) throw Object.assign(new Error("ORG_NOT_FOUND"), { code: "ORG_NOT_FOUND", statusCode: 404 });
      const membership = await trx.selectFrom("organization_members").select(["role", "status"])
        .where("organization_id", "=", org.id).where("user_id", "=", input.userId).forUpdate().executeTakeFirst();
      const user = await trx.selectFrom("users").select(["id", "status", "password_must_change", "provisioned_organization_id"])
        .where("id", "=", input.userId).forUpdate().executeTakeFirst();
      if (org.status !== "active" || membership?.role !== "owner" || membership?.status !== "active" || user?.status !== "active"
        || !user.password_must_change || user.provisioned_organization_id !== org.id) {
        throw Object.assign(new Error("OWNER_INITIAL_PASSWORD_UNAVAILABLE"), { code: "OWNER_INITIAL_PASSWORD_UNAVAILABLE", statusCode: 409 });
      }
      return { ok: true, owner: await resetIssuedPassword(trx, { organizationId: org.id, userId: user.id }) };
    }));
    if (result?.ok) await audit(request, "enterprise_owner_initial_password_reissue", "organization", request.params.id, { userId: input.userId });
    return result;
  });

  // PATCH /api/admin/enterprise/organizations/:id — enable/disable org
  app.patch(
    "/api/admin/enterprise/organizations/:id",
    {
      schema: {
        tags: ["admin:enterprise"],
        summary: "Enable or disable an organization",
        params: orgIdSchema,
        body: zodBody(patchOrgSchema),
        response: { 200: okResponse({ organization: { type: "object" } }) },
      },
    },
    async (request, reply) => {
      const raw = patchOrgSchema.parse(request.body);
      const input = {
        ...(raw.platformStatus !== undefined ? { platformStatus: raw.platformStatus }
          : raw.status !== undefined ? { platformStatus: raw.status === "disabled" ? "suspended" : "active" } : {}),
        ...(raw.name !== undefined ? { name: raw.name } : {}),
        ...(raw.defaultMemberWeeklyBudget !== undefined ? { defaultMemberWeeklyBudget: raw.defaultMemberWeeklyBudget } : {}),
        ...(raw.reason !== undefined ? { reason: raw.reason } : {}),
      };
      const result = await enterpriseMutationResponse(reply, () => mutations.changeOrganization({
        organizationId: request.params.id, adminActor: config.adminEmail || "admin",
        authorizeAdmin: () => assertAdmin(request, reply),
      }, input));
      if (!result?.ok) return result;
      await audit(request, input.platformStatus !== undefined ? "enterprise_org_status" : "enterprise_org_change", "organization", request.params.id, input);
      return result;
    },
  );

  // POST /api/admin/enterprise/organizations/:id/grants — platform-side quota transfer
  app.post(
    "/api/admin/enterprise/organizations/:id/grants",
    {
      schema: {
        tags: ["admin:enterprise"],
        summary: "Adjust organization quota pool (admin transfer)",
        params: orgIdSchema,
        body: zodBody(adjustGrantsSchema),
        response: { 200: okResponse({ grant: { type: "object" } }) },
      },
    },
    async (request, reply) => {
      const input = adjustGrantsSchema.parse(request.body);
      const org = await db.selectFrom("organizations").selectAll().where("id", "=", request.params.id).executeTakeFirst();
      if (!org) {
        reply.code(404).send({ ok: false, code: "ORG_NOT_FOUND" });
        return;
      }
      const now = new Date();
      const expiresAt = new Date(now.getTime() + Number(input.expiresDays) * 24 * 60 * 60 * 1000);
      // Org grant rows reuse wallet_grants, whose user_id is NOT NULL and FK
      // references users(id). Per design §5 the row's user_id is the org OWNER
      // (creation is performed by the org's owner; fall back to the first owner).
      const owner = await db
        .selectFrom("organization_members")
        .select("user_id")
        .where("organization_id", "=", request.params.id)
        .where("role", "=", "owner")
        .where("status", "=", "active")
        .orderBy("joined_at", "asc")
        .executeTakeFirst();
      if (!owner) {
        reply.code(409).send({ ok: false, code: "ORG_NO_OWNER" });
        return;
      }
      const grantId = publicId("grant");
      const ledgerKey = input.idempotencyKey ? `admin_org_grant:${request.params.id}:${input.idempotencyKey}` : null;
      if (ledgerKey) {
        const previous = await db.selectFrom("wallet_ledger").select("grant_id").where("idempotency_key", "=", ledgerKey).executeTakeFirst();
        if (previous?.grant_id) {
          const grant = await db.selectFrom("wallet_grants").selectAll().where("id", "=", previous.grant_id).executeTakeFirst();
          return { ok: true, grant, idempotent: true };
        }
      }
      await db.transaction().execute(async (trx) => {
        await trx
          .insertInto("wallet_grants")
          .values({
            id: grantId,
            user_id: owner.user_id, // org grant row; user_id = org owner (FK valid)
            source_type: "admin_adjustment",
            source_id: request.params.id,
            grant_type: "org_pool",
            resource_type: input.resourceType,
            token_total: input.resourceType === "token" ? input.unitTotal : 0,
            token_remaining: input.resourceType === "token" ? input.unitTotal : 0,
            unit_total: input.unitTotal,
            unit_remaining: input.unitTotal,
            starts_at: now,
            expires_at: expiresAt,
            status: "active",
            metadata: { organization_id: request.params.id },
            organization_id: request.params.id,
          })
          .execute();
        await trx
          .insertInto("wallet_ledger")
          .values({
            id: publicId("ledger"),
            user_id: owner.user_id,
            grant_id: grantId,
            event_type: "grant",
            resource_type: input.resourceType,
            token_delta: input.resourceType === "token" ? input.unitTotal : 0,
            unit_delta: input.unitTotal,
            source_type: "admin_adjustment",
            source_id: request.params.id,
            idempotency_key: ledgerKey,
            metadata: { actor: config.adminEmail || "admin", organization_id: request.params.id, ...(input.note ? { note: input.note } : {}) },
          })
          .execute();
      });
      await audit(request, "enterprise_grant_adjust", "organization", request.params.id, {
        resourceType: input.resourceType,
        unitTotal: input.unitTotal,
        expiresDays: input.expiresDays,
        ...(input.note ? { note: input.note } : {}),
      });
      const grant = await db.selectFrom("wallet_grants").selectAll().where("id", "=", grantId).executeTakeFirst();
      return { ok: true, grant };
    },
  );

  // GET /api/admin/enterprise/organizations/:id/usage — cross-org usage audit
  app.get(
    "/api/admin/enterprise/organizations/:id/usage",
    {
      schema: {
        tags: ["admin:enterprise"],
        summary: "Organization usage audit",
        params: orgIdSchema,
        querystring: zodBody(usageSchema),
        response: { 200: okResponse({ usage: { type: "object" } }) },
      },
    },
    async (request, reply) => {
      const org = await db.selectFrom("organizations").selectAll().where("id", "=", request.params.id).executeTakeFirst();
      if (!org) {
        reply.code(404).send({ ok: false, code: "ORG_NOT_FOUND" });
        return;
      }
      const input = usageSchema.parse(request.query);
      const usage = await orgUsage(request.params.id, input.days);
      return { ok: true, usage };
    },
  );

  registerAdminEnterpriseLedgerRoutes(app, { audit });
}

