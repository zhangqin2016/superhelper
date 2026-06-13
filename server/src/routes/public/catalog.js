import { z } from "zod";
import { db } from "../../db.js";
import { publicId } from "../../services/ids.js";
import {
  createFeedbackUploadToken,
  normalizeFeedbackAttachmentInput,
  normalizeSubmittedAttachment,
} from "../../services/qiniu-upload.js";

const contactRequestSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email().max(160),
  company: z.string().max(160).optional().nullable(),
  phone: z.string().max(80).optional().nullable(),
  subject: z.string().max(160).optional().nullable(),
  message: z.string().min(8).max(4000),
  source: z.string().max(80).optional().nullable(),
  attachments: z.array(z.unknown()).max(5).optional(),
});

const attachmentUploadSchema = z.object({
  draftId: z.string().max(120).optional().nullable(),
  fileName: z.string().min(1).max(160),
  mimeType: z.string().min(1).max(80),
  sizeBytes: z.number().int().positive(),
});

async function createContactRequest(request, reply) {
  const input = contactRequestSchema.parse(request.body);
  const id = publicId("contact");
  const attachments = (input.attachments || []).map(normalizeSubmittedAttachment).filter(Boolean);
  await db.transaction().execute(async (trx) => {
    await trx
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
    if (attachments.length) {
      await trx
        .insertInto("contact_request_attachments")
        .values(attachments.map((attachment) => ({ ...attachment, contact_request_id: id })))
        .execute();
    }
  });
  return reply.code(201).send({ ok: true, id });
}

async function createContactAttachmentUploadToken(request, reply) {
  const input = attachmentUploadSchema.parse(request.body);
  const normalized = normalizeFeedbackAttachmentInput(input);
  if (!normalized.ok) return reply.code(400).send({ ok: false, code: normalized.code });
  try {
    return createFeedbackUploadToken({
      deviceId: request.headers["x-lily-device-id"] || "anonymous",
      draftId: input.draftId,
      fileName: normalized.fileName,
      mimeType: normalized.mimeType,
      sizeBytes: normalized.sizeBytes,
    });
  } catch (error) {
    if (error?.code === "QINIU_UPLOAD_NOT_CONFIGURED") {
      return reply.code(503).send({ ok: false, code: "QINIU_UPLOAD_NOT_CONFIGURED" });
    }
    return reply.code(400).send({ ok: false, code: error?.code || "UPLOAD_TOKEN_FAILED" });
  }
}

function compareVersions(a, b) {
  const pa = String(a || "0").split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = String(b || "0").split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

function newestRelease(releases) {
  return (releases || []).reduce((best, release) => {
    if (!best) return release;
    const versionOrder = compareVersions(release.version, best.version);
    if (versionOrder > 0) return release;
    if (versionOrder === 0 && new Date(release.created_at).getTime() > new Date(best.created_at).getTime()) {
      return release;
    }
    return best;
  }, null);
}

export async function publicCatalogRoutes(app) {
  app.post("/api/contact-requests", createContactRequest);
  app.post("/api/contact", createContactRequest);
  app.post("/api/contact-attachments/upload-token", createContactAttachmentUploadToken);

  app.get("/api/releases/latest", async (request) => {
    const platform = String(request.query?.platform || "");
    const currentVersion = String(request.query?.version || "");
    const releases = await db
      .selectFrom("releases")
      .selectAll()
      .where("platform", "=", platform)
      .where("enabled", "=", true)
      .orderBy("created_at", "desc")
      .limit(200)
      .execute();

    const release = newestRelease(releases);
    if (!release) return { hasUpdate: false };
    return {
      hasUpdate: compareVersions(release.version, currentVersion) > 0,
      version: release.version,
      platform: release.platform,
      url: release.url,
      sha256: release.sha256,
      sizeBytes: Number(release.size_bytes || 0),
      notes: release.notes || "",
      force: release.force_update,
    };
  });

  app.get("/api/document-packs/artifact", async (request) => {
    const packId = String(request.query?.pack || "");
    const platform = String(request.query?.platform || "");
    if (!packId || !platform) return { artifact: null };
    const rows = await db
      .selectFrom("document_packs")
      .selectAll()
      .where("pack_id", "=", packId)
      .where("platform", "=", platform)
      .where("enabled", "=", true)
      .orderBy("created_at", "desc")
      .limit(200)
      .execute();
    // Reuse newest-by-version selection; document_packs has no created_at tie
    // semantics beyond recency, which newestRelease already handles.
    const pack = newestRelease(rows);
    if (!pack) return { artifact: null };
    return {
      artifact: {
        url: pack.url,
        sha256: pack.sha256,
        version: pack.version,
        sizeBytes: Number(pack.size_bytes || 0),
      },
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
