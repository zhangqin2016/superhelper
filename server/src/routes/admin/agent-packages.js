// Admin CRUD for agent packages (智能体分发). Mirrors admin/skill-packages.js:
// JSON upsert gated by the definition validator + quality gate, PATCH toggles,
// soft delete (enabled=false). Every mutation is audited.
import { z } from "zod";
import { db } from "../../db.js";
import { publicId } from "../../services/ids.js";
import { zodBody, okResponse } from "../../openapi.js";
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

// Documentation-only shapes (handlers validate via the service; see openapi.js).
const upsertAgentPackageSchema = z.object({
  agentId: z.string().min(1).max(128),
  version: z.string().min(1).max(40),
  channel: z.string().min(1).max(40).default("stable"),
  scopeType: z.enum(["global", "organization"]).default("global"),
  organizationId: z.string().max(120).optional().nullable(),
  enabled: z.boolean().default(true),
  featured: z.boolean().default(false),
  displayInCatalog: z.boolean().default(true),
  publisher: z.string().max(120).optional().nullable(),
  definition: z.record(z.any()),
  roleCard: z.object({ canonical: z.record(z.any()) }).optional().nullable(),
  minAppVersion: z.string().max(40).optional().nullable(),
});

const patchAgentPackageSchema = z.object({
  enabled: z.boolean().optional(),
  featured: z.boolean().optional(),
  displayInCatalog: z.boolean().optional(),
});

const listQuerySchema = z.object({
  channel: z.string().max(40).optional(),
  scope: z.enum(["global", "organization"]).optional(),
  organizationId: z.string().max(120).optional(),
});

function sendCoded(reply, error) {
  const mapped = agentPackageErrorResponse(error);
  if (!mapped) throw error;
  return reply.code(mapped.statusCode).send(mapped.body);
}

export function registerAdminAgentPackageRoutes(app, { audit }) {
  app.get(
    "/api/admin/agent-packages",
    {
      schema: {
        tags: ["admin:agent-packages"],
        summary: "List agent packages",
        description: "Returns the most recent agent packages, optionally filtered by channel / scope / organization.",
        querystring: zodBody(listQuerySchema),
        response: { 200: okResponse({ agentPackages: { type: "array" } }) },
      },
    },
    async (request) => {
      const query = listQuerySchema.parse(request.query || {});
      return {
        ok: true,
        agentPackages: await listAgentPackages(db, {
          channel: query.channel || undefined,
          scopeType: query.scope || undefined,
          organizationId: query.organizationId || undefined,
        }),
      };
    },
  );

  app.get(
    "/api/admin/agent-packages/:id",
    {
      schema: {
        tags: ["admin:agent-packages"],
        summary: "Get one agent package",
        response: { 200: okResponse({ agentPackage: { type: "object" } }) },
      },
    },
    async (request, reply) => {
      const row = await findAgentPackage(db, request.params.id);
      if (!row) return reply.code(404).send({ ok: false, code: "AGENT_PACKAGE_NOT_FOUND" });
      return { ok: true, agentPackage: row };
    },
  );

  app.post(
    "/api/admin/agent-packages",
    {
      schema: {
        tags: ["admin:agent-packages"],
        summary: "Upsert an agent package",
        description:
          "Creates or updates the publication keyed by (agentId, version, channel, scope). The definition must pass the shared agent-definition validator and the distribution quality gate.",
        body: zodBody(upsertAgentPackageSchema),
        response: { 201: okResponse({ id: { type: "string" }, agentId: { type: "string" } }) },
      },
    },
    async (request, reply) => {
      let input;
      try {
        input = normalizeAgentPackageInput(request.body || {});
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
        saved = await upsertAgentPackage(db, input, { id: publicId("agentpkg"), createdBy: "admin" });
      } catch (error) {
        return sendCoded(reply, error);
      }
      await audit(request, "agent_package.upsert", "agent_package", input.agentId, {
        packageId: saved.id,
        version: input.version,
        channel: input.channel,
        scopeType: input.scopeType,
        organizationId: input.organizationId,
        enabled: input.enabled,
        featured: input.featured,
      });
      return reply.code(201).send({ ok: true, id: saved.id, agentId: input.agentId, created: saved.created });
    },
  );

  app.patch(
    "/api/admin/agent-packages/:id",
    {
      schema: {
        tags: ["admin:agent-packages"],
        summary: "Toggle enabled / featured / catalog visibility",
        body: zodBody(patchAgentPackageSchema),
        response: { 200: okResponse({ id: { type: "string" } }) },
      },
    },
    async (request, reply) => {
      let patch;
      try {
        patch = normalizeAgentPackagePatch(request.body || {});
      } catch (error) {
        return sendCoded(reply, error);
      }
      const updated = await patchAgentPackage(db, request.params.id, patch);
      if (!updated) return reply.code(404).send({ ok: false, code: "AGENT_PACKAGE_NOT_FOUND" });
      await audit(request, "agent_package.update", "agent_package", request.params.id, patch);
      return { ok: true, id: request.params.id };
    },
  );

  app.delete(
    "/api/admin/agent-packages/:id",
    {
      schema: {
        tags: ["admin:agent-packages"],
        summary: "Unpublish an agent package (soft delete)",
        description: "Sets enabled=false; the row is kept for audit and rollback.",
        response: { 200: okResponse({ id: { type: "string" } }) },
      },
    },
    async (request, reply) => {
      const updated = await patchAgentPackage(db, request.params.id, { enabled: false });
      if (!updated) return reply.code(404).send({ ok: false, code: "AGENT_PACKAGE_NOT_FOUND" });
      await audit(request, "agent_package.unpublish", "agent_package", request.params.id, { enabled: false });
      return { ok: true, id: request.params.id };
    },
  );
}
