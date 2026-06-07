import { z } from "zod";
import { db } from "../../db.js";
import { publicId } from "../../services/ids.js";

const contactRequestSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email().max(160),
  company: z.string().max(160).optional().nullable(),
  phone: z.string().max(80).optional().nullable(),
  subject: z.string().max(160).optional().nullable(),
  message: z.string().min(8).max(4000),
  source: z.string().max(80).optional().nullable(),
});

async function createContactRequest(request, reply) {
  const input = contactRequestSchema.parse(request.body);
  const id = publicId("contact");
  await db
    .insertInto("contact_requests")
    .values({
      id,
      name: input.name,
      email: input.email,
      company: input.company || null,
      phone: input.phone || null,
      subject: input.subject || null,
      message: input.message,
      source: input.source || null,
      ip: request.ip || null,
      user_agent: request.headers["user-agent"] || null,
    })
    .execute();
  return reply.code(201).send({ ok: true, id });
}

export async function publicCatalogRoutes(app) {
  app.post("/api/contact-requests", createContactRequest);
  app.post("/api/contact", createContactRequest);

  app.get("/api/releases/latest", async (request) => {
    const platform = String(request.query?.platform || "");
    const currentVersion = String(request.query?.version || "");
    const release = await db
      .selectFrom("releases")
      .selectAll()
      .where("platform", "=", platform)
      .where("enabled", "=", true)
      .orderBy("created_at", "desc")
      .executeTakeFirst();

    if (!release) return { hasUpdate: false };
    return {
      hasUpdate: release.version !== currentVersion,
      version: release.version,
      platform: release.platform,
      url: release.url,
      sha256: release.sha256,
      sizeBytes: Number(release.size_bytes || 0),
      notes: release.notes || "",
      force: release.force_update,
    };
  });

  app.get("/api/releases", async (request) => {
    const platform = String(request.query?.platform || "").trim();
    let query = db
      .selectFrom("releases")
      .selectAll()
      .where("enabled", "=", true)
      .orderBy("created_at", "desc");
    if (platform) query = query.where("platform", "=", platform);
    const releases = await query.limit(50).execute();
    return {
      releases: releases.map((release) => ({
        id: release.id,
        version: release.version,
        platform: release.platform,
        url: release.url,
        sha256: release.sha256,
        sizeBytes: Number(release.size_bytes || 0),
        notes: release.notes || "",
        force: release.force_update,
        createdAt: release.created_at,
      })),
    };
  });

  app.get("/api/plugins", async () => {
    const plugins = await db
      .selectFrom("plugins")
      .selectAll()
      .where("enabled", "=", true)
      .orderBy("created_at", "desc")
      .execute();
    return {
      plugins: plugins.map((plugin) => ({
        id: plugin.id,
        name: plugin.name,
        version: plugin.version,
        type: plugin.type,
        description: plugin.description || "",
        manifestUrl: plugin.manifest_url,
        sha256: plugin.sha256 || "",
        enabled: plugin.enabled,
      })),
    };
  });

  app.get("/api/plugins/registry", async (request) => {
    const baseUrl = `${request.protocol}://${request.hostname}`;
    const plugins = await db
      .selectFrom("plugins")
      .selectAll()
      .where("enabled", "=", true)
      .where("type", "=", "skill")
      .where("sha256", "is not", null)
      .orderBy("created_at", "desc")
      .execute();

    return {
      schemaVersion: 1,
      publisher: "Lily Workbench",
      registryUrl: `${baseUrl}/api/plugins/registry`,
      updatedAt: new Date().toISOString(),
      categories: [
        { id: "office", label: "Office" },
        { id: "dev", label: "Engineering" },
        { id: "pm", label: "Product" },
        { id: "marketing", label: "Marketing" },
        { id: "security", label: "Security" },
      ],
      skills: plugins.map((plugin) => ({
        id: plugin.id,
        name: plugin.name,
        description: plugin.description || "",
        latestVersion: plugin.version,
        sourceType: "zip",
        downloadUrl: plugin.manifest_url,
        sha256: plugin.sha256,
        category: "dev",
        categoryLabel: "Engineering",
        publisher: "Lily Workbench",
        changelog: plugin.description || "",
      })),
    };
  });
}
