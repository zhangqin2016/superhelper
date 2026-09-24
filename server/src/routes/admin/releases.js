import { z } from "zod";
import { db } from "../../db.js";
import { publicId } from "../../services/ids.js";
import { zodBody, okResponse } from "../../openapi.js";
import { artifactErrorResponse, checkReleaseArtifact } from "../../services/release-artifact-check.js";
import { listPage, pageQuerySchema, pageResponseSchema } from "../../services/admin-pagination.js";
import { latestReleases } from "../../services/release-versions.js";

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

// A release can be switched on/off, and marked mandatory after the fact: an
// operator usually learns a version must go only once it is already out.
const updateReleaseSchema = z.object({
  enabled: z.boolean().optional(),
  forceUpdate: z.boolean().optional(),
}).refine((value) => value.enabled !== undefined || value.forceUpdate !== undefined, { message: "enabled or forceUpdate is required" });

export function registerAdminReleaseRoutes(app, { audit }) {
  app.get(
    "/api/admin/releases",
    {
      schema: {
        tags: ["admin:releases"],
        summary: "List app releases",
        description: "Returns the most recent app releases ordered by creation time, plus the version each platform is currently offered (newest enabled).",
        querystring: zodBody(pageQuerySchema),
        response: { 200: okResponse({ ...pageResponseSchema("releases"), latest: { type: "object", additionalProperties: { type: "string" } } }) },
      },
    },
    async (request) => {
      const [page, enabled] = await Promise.all([
        listPage(request, {
          key: "releases",
          query: () => db.selectFrom("releases").selectAll(),
          countQuery: () => db.selectFrom("releases").select((eb) => eb.fn.count("id").as("count")),
          sortColumn: "created_at",
        }),
        db.selectFrom("releases").select(["platform", "version"]).where("enabled", "=", true).execute().catch(() => []),
      ]);
      // Which row a client is offered today is the one fact the list could not say.
      const latest = Object.fromEntries(latestReleases(enabled).map((row) => [row.platform, row.latest]));
      return { ...page, latest };
    },
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
        summary: "Enable, disable, or mark a release mandatory",
        description: "Updates the enabled and/or force_update flags of an existing app release. A mandatory release is a floor: clients below it must update.",
        body: zodBody(updateReleaseSchema),
        response: { 200: okResponse({ id: { type: "string" } }) },
      },
    },
    async (request) => {
      const input = updateReleaseSchema.parse(request.body);
      const changes = {
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.forceUpdate !== undefined ? { force_update: input.forceUpdate } : {}),
      };
      await db.updateTable("releases").set(changes).where("id", "=", request.params.id).execute();
      await audit(request, "release.update", "release", request.params.id, changes);
      return { ok: true, id: request.params.id };
    },
  );
}
