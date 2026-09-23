import { z } from "zod";
import { db } from "../../db.js";
import { publicId } from "../../services/ids.js";
import { zodBody, okResponse } from "../../openapi.js";
import { artifactErrorResponse, checkReleaseArtifact } from "../../services/release-artifact-check.js";
import { listPage, pageQuerySchema, pageResponseSchema } from "../../services/admin-pagination.js";

const createReleaseSchema = z.object({
  version: z.string().min(1).max(40),
  platform: z.string().min(1).max(40),
  url: z.string().url(),
  sha256: z.string().min(16).max(160),
  sizeBytes: z.number().int().min(0).optional().nullable(),
  notes: z.string().max(5000).optional().nullable(),
  forceUpdate: z.boolean().default(false),
  enabled: z.boolean().default(true),
});

const updateEnabledSchema = z.object({
  enabled: z.boolean(),
});

export function registerAdminReleaseRoutes(app, { audit }) {
  app.get(
    "/api/admin/releases",
    {
      schema: {
        tags: ["admin:releases"],
        summary: "List app releases",
        description: "Returns the most recent app releases ordered by creation time.",
        querystring: zodBody(pageQuerySchema),
        response: { 200: okResponse(pageResponseSchema("releases")) },
      },
    },
    async (request) => listPage(request, {
      key: "releases",
      query: () => db.selectFrom("releases").selectAll(),
      countQuery: () => db.selectFrom("releases").select((eb) => eb.fn.count("id").as("count")),
      sortColumn: "created_at",
    }),
  );

  app.post(
    "/api/admin/releases",
    {
      schema: {
        tags: ["admin:releases"],
        summary: "Create an app release",
        description: "Inserts a new app release record for a version/platform.",
        body: zodBody(createReleaseSchema),
        response: { 201: okResponse({ id: { type: "string" } }) },
      },
    },
    async (request, reply) => {
    const input = createReleaseSchema.parse(request.body);
    // A release row promises a file. Refuse only a definite "not there" — a host
    // that guards or cannot answer HEAD must never block a release.
    const artifact = await checkReleaseArtifact(input.url);
    if (!artifact.ok) return reply.code(400).send(artifactErrorResponse(artifact));
    const id = publicId("rel");
    await db
      .insertInto("releases")
      .values({
        id,
        version: input.version,
        platform: input.platform,
        url: input.url,
        sha256: input.sha256,
        size_bytes: input.sizeBytes || null,
        notes: input.notes || null,
        force_update: input.forceUpdate,
        enabled: input.enabled,
      })
      .execute();
    await audit(request, "release.create", "release", id, { version: input.version, platform: input.platform });
    return reply.code(201).send({ ok: true, id });
    },
  );

  app.patch(
    "/api/admin/releases/:id",
    {
      schema: {
        tags: ["admin:releases"],
        summary: "Enable or disable a release",
        description: "Toggles the enabled flag on an existing app release.",
        body: zodBody(updateEnabledSchema),
        response: { 200: okResponse({ id: { type: "string" } }) },
      },
    },
    async (request) => {
      const input = updateEnabledSchema.parse(request.body);
      await db.updateTable("releases").set({ enabled: input.enabled }).where("id", "=", request.params.id).execute();
      await audit(request, "release.update", "release", request.params.id, { enabled: input.enabled });
      return { ok: true, id: request.params.id };
    },
  );
}
