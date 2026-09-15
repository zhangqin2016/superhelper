// Enterprise agent publishing — org owners/admins publish organization-scoped
// agent packages; every active member can list them. Runs under the
// /api/enterprise/ preHandler in enterprise.js (dual auth → request.user).
//
// Scope is pinned from the URL: a body can never publish outside :id.
import { z } from "zod";
import { db } from "../../db.js";
import { publicId } from "../../services/ids.js";
import { zodBody, okResponse } from "../../openapi.js";
import { requireOrgRole } from "./enterprise-route-support.js";
import {
  agentPackageErrorResponse,
  evaluateAgentPackageQuality,
  findAgentPackage,
  listAgentPackages,
  normalizeAgentPackageInput,
  normalizeAgentPackagePatch,
  patchAgentPackage,
  qualityGateResponse,
  upsertAgentPackage,
} from "../../services/agent-packages.js";

const orgIdSchema = z.object({ id: z.string().min(3).max(120) });
const publishSchema = z.object({
  agentId: z.string().min(1).max(128),
  version: z.string().min(1).max(40),
  channel: z.string().min(1).max(40).default("stable"),
  enabled: z.boolean().default(true),
  featured: z.boolean().default(false),
  displayInCatalog: z.boolean().default(true),
  publisher: z.string().max(120).optional().nullable(),
  definition: z.record(z.any()),
  roleCard: z.object({ canonical: z.record(z.any()) }).optional().nullable(),
  minAppVersion: z.string().max(40).optional().nullable(),
});
const patchSchema = z.object({
  enabled: z.boolean().optional(),
  featured: z.boolean().optional(),
  displayInCatalog: z.boolean().optional(),
});

function sendCoded(reply, error) {
  const mapped = agentPackageErrorResponse(error);
  if (!mapped) throw error;
  return reply.code(mapped.statusCode).send(mapped.body);
}

/** Same audit_logs row the admin console writes, with the org user as actor. */
async function auditAsUser(request, action, targetId, metadata = {}) {
  try {
    await db
      .insertInto("audit_logs")
      .values({
        actor: `user:${request.user?.userId || "unknown"}`,
        action,
        target_type: "agent_package",
        target_id: targetId,
        ip: request.ip || null,
        user_agent: request.headers["user-agent"] || null,
        metadata: JSON.stringify(metadata || {}),
      })
      .execute();
  } catch (error) {
    request.log.warn({ error }, "audit log write failed");
  }
}

export function registerPublicEnterpriseAgentRoutes(app) {
  // GET — any active member sees the org's published agents.
  app.get(
    "/api/enterprise/organizations/:id/agents",
    {
      schema: {
        tags: ["public:enterprise"],
        summary: "List an organization's agent packages",
        params: orgIdSchema,
        response: { 200: okResponse({ agentPackages: { type: "array" } }) },
      },
    },
    async (request, reply) => {
      const membership = await requireOrgRole(request, reply, request.params.id, "member");
      if (!membership) return;
      const rows = await listAgentPackages(db, { scopeType: "organization", organizationId: request.params.id });
      return { ok: true, agentPackages: rows };
    },
  );

  // POST — owner/admin publishes to the organization scope.
  app.post(
    "/api/enterprise/organizations/:id/agents",
    {
      schema: {
        tags: ["public:enterprise"],
        summary: "Publish an agent package to an organization",
        description: "Org owner/admin only. Scope is pinned to the organization in the URL; the definition must pass the shared validator and quality gate.",
        params: orgIdSchema,
        body: zodBody(publishSchema),
        response: { 201: okResponse({ id: { type: "string" }, agentId: { type: "string" } }) },
      },
    },
    async (request, reply) => {
      const membership = await requireOrgRole(request, reply, request.params.id, "admin");
      if (!membership) return;
      let input;
      try {
        input = normalizeAgentPackageInput(request.body || {}, { scopeType: "organization", organizationId: request.params.id });
      } catch (error) {
        return sendCoded(reply, error);
      }
      const quality = evaluateAgentPackageQuality(input);
      if (!quality.ok) {
        const failed = qualityGateResponse(quality);
        return reply.code(failed.statusCode).send(failed.body);
      }
      let saved;
      try {
        saved = await upsertAgentPackage(db, input, { id: publicId("agentpkg"), createdBy: `user:${request.user.userId}` });
      } catch (error) {
        return sendCoded(reply, error);
      }
      await auditAsUser(request, "agent_package.org_publish", input.agentId, {
        packageId: saved.id,
        organizationId: request.params.id,
        version: input.version,
        channel: input.channel,
        enabled: input.enabled,
        featured: input.featured,
        role: membership.role,
      });
      return reply.code(201).send({ ok: true, id: saved.id, agentId: input.agentId, created: saved.created });
    },
  );

  // PATCH — owner/admin toggles; the package must belong to THIS organization.
  app.patch(
    "/api/enterprise/organizations/:id/agents/:packageId",
    {
      schema: {
        tags: ["public:enterprise"],
        summary: "Toggle an organization agent package",
        params: orgIdSchema.extend({ packageId: z.string().min(1).max(120) }),
        body: zodBody(patchSchema),
        response: { 200: okResponse({ id: { type: "string" } }) },
      },
    },
    async (request, reply) => {
      const membership = await requireOrgRole(request, reply, request.params.id, "admin");
      if (!membership) return;
      let patch;
      try {
        patch = normalizeAgentPackagePatch(request.body || {});
      } catch (error) {
        return sendCoded(reply, error);
      }
      const row = await findAgentPackage(db, request.params.packageId);
      if (!row || row.scope_type !== "organization" || row.organization_id !== request.params.id) {
        return reply.code(404).send({ ok: false, code: "AGENT_PACKAGE_NOT_FOUND" });
      }
      await patchAgentPackage(db, row.id, patch);
      await auditAsUser(request, "agent_package.org_update", row.id, { organizationId: request.params.id, ...patch, role: membership.role });
      return { ok: true, id: row.id };
    },
  );
}
