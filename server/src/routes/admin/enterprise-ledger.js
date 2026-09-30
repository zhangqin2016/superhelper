// Enterprise platform-admin routes for the pool's ledger and the org's history:
// reduce/revoke a grant and read the change history. Split out of
// enterprise.js (size ratchet); behaviour unchanged.

import { z } from "zod";
import { db } from "../../db.js";
import { zodBody, okResponse } from "../../openapi.js";
import { publicId } from "../../services/ids.js";
import { config } from "../../config.js";
import { enterpriseMutationResponse, memberIdentities } from "../public/enterprise-route-support.js";

const orgIdSchema = z.object({ id: z.string().min(3).max(120) });
const reduceGrantSchema = z.object({
  // Take back part of what is left, or all of it (revoke). A typo'd grant used
  // to be permanent: the platform could only ever add.
  units: z.number().int().min(1).max(1000000000).optional(),
  all: z.boolean().optional(),
  reason: z.string().min(1).max(200),
}).refine((v) => v.all === true || v.units !== undefined, { message: "units or all required" });
const grantParamsSchema = z.object({ id: z.string().min(3).max(120), grantId: z.string().min(3).max(120) });
const auditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).catch(50).default(50),
  before: z.coerce.number().int().min(1).optional().catch(undefined),
});

/** What a grant row means to an operator, not its raw columns. */
export function grantState(grant, now = new Date()) {
  if (grant.status === "revoked") return "revoked";
  if (new Date(grant.expires_at).getTime() <= now.getTime()) return "expired";
  if (Number(grant.unit_remaining || 0) <= 0) return "depleted";
  if (new Date(grant.starts_at).getTime() > now.getTime()) return "scheduled";
  return "active";
}

export function registerAdminEnterpriseLedgerRoutes(app, { audit }) {
  // POST /api/admin/enterprise/organizations/:id/grants/:grantId/reduce — take back
  // part of a grant's remaining units, or all of it (revoke). Ledgered + audited.
  app.post("/api/admin/enterprise/organizations/:id/grants/:grantId/reduce", {
    schema: { tags: ["admin:enterprise"], summary: "Reduce or revoke an organization grant", params: grantParamsSchema,
      body: zodBody(reduceGrantSchema), response: { 200: okResponse({ grant: { type: "object" } }) } },
  }, async (request, reply) => {
    const input = reduceGrantSchema.parse(request.body);
    const result = await enterpriseMutationResponse(reply, () => db.transaction().execute(async (trx) => {
      const grant = await trx.selectFrom("wallet_grants").selectAll().where("id", "=", request.params.grantId)
        .where("organization_id", "=", request.params.id).forUpdate().executeTakeFirst();
      if (!grant) throw Object.assign(new Error("GRANT_NOT_FOUND"), { code: "GRANT_NOT_FOUND", statusCode: 404 });
      if (grant.status !== "active") throw Object.assign(new Error("GRANT_NOT_ACTIVE"), { code: "GRANT_NOT_ACTIVE", statusCode: 409 });
      const remaining = Number(grant.unit_remaining || 0);
      const taken = input.all ? remaining : Math.min(remaining, Number(input.units));
      if (!input.all && taken <= 0) throw Object.assign(new Error("GRANT_NOTHING_LEFT"), { code: "GRANT_NOTHING_LEFT", statusCode: 409 });
      const updated = await trx.updateTable("wallet_grants").set((eb) => ({
        unit_remaining: eb("unit_remaining", "-", taken),
        ...(grant.resource_type === "token" ? { token_remaining: eb("token_remaining", "-", taken) } : {}),
        ...(input.all ? { status: "revoked" } : {}),
      })).where("id", "=", grant.id).returningAll().executeTakeFirstOrThrow();
      await trx.insertInto("wallet_ledger").values({
        id: publicId("ledger"), user_id: grant.user_id, grant_id: grant.id, event_type: input.all ? "revoke" : "adjust",
        resource_type: grant.resource_type, token_delta: grant.resource_type === "token" ? -taken : 0, unit_delta: -taken,
        source_type: "admin_adjustment", source_id: request.params.id,
        metadata: { actor: config.adminEmail || "admin", organization_id: request.params.id, reason: input.reason },
      }).execute();
      return { ok: true, grant: { ...updated, state: grantState(updated) }, taken };
    }));
    if (result?.ok) await audit(request, input.all ? "enterprise_grant_revoke" : "enterprise_grant_reduce", "organization", request.params.id, {
      grantId: request.params.grantId, units: result.taken, reason: input.reason });
    return result;
  });

  // GET /api/admin/enterprise/organizations/:id/audit — this org's history, both sides
  app.get("/api/admin/enterprise/organizations/:id/audit", {
    schema: { tags: ["admin:enterprise"], summary: "Organization change history (platform and enterprise side)", params: orgIdSchema,
      querystring: zodBody(auditQuerySchema), response: { 200: okResponse({ entries: { type: "array" } }) } },
  }, async (request) => {
    const input = auditQuerySchema.parse(request.query || {});
    let query = db.selectFrom("audit_logs").select(["id", "actor", "action", "metadata", "created_at", "ip"])
      .where("target_type", "=", "organization").where("target_id", "=", request.params.id);
    if (input.before) query = query.where("id", "<", input.before);
    const rows = await query.orderBy("id", "desc").limit(input.limit).execute();
    const userIds = [...new Set(rows.map((row) => String(row.actor || "")).filter((a) => a.startsWith("user:")).map((a) => a.slice(5)))];
    const identities = await memberIdentities(db, userIds);
    const entries = rows.map((row) => {
      const actor = String(row.actor || "");
      const userId = actor.startsWith("user:") ? actor.slice(5) : null;
      return { id: Number(row.id), action: row.action, metadata: row.metadata, createdAt: row.created_at, ip: row.ip,
        actor: userId ? { kind: "member", userId, ...identities.get(userId) } : { kind: "platform", name: actor } };
    });
    return { ok: true, entries, nextBefore: rows.length === input.limit ? Number(rows.at(-1).id) : null };
  });
}
