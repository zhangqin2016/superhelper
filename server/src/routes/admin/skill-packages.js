import crypto from "node:crypto";
import { z } from "zod";
import { db } from "../../db.js";
import { publicId } from "../../services/ids.js";
import { uploadBufferToQiniu } from "../../services/qiniu-upload.js";
import {
  isValidSkillArtifactUrl,
  isValidSkillSha256,
  skillPackageObjectKey,
  evaluateSkillPackageQuality,
  validateSkillPackageArtifact,
} from "../../services/skill-packages.js";

const createSkillPackageSchema = z.object({
  skillId: z.string().min(2).max(100),
  name: z.string().min(1).max(160),
  description: z.string().max(2000).optional().nullable(),
  version: z.string().min(1).max(40),
  category: z.string().min(1).max(60).default("core"),
  categoryLabel: z.string().max(80).optional().nullable(),
  capabilityLayer: z.string().min(1).max(80).default("core"),
  publisher: z.string().min(1).max(120).default("Lily Workbench"),
  sourceKind: z.string().min(1).max(60).default("lily"),
  sourceRepo: z.string().max(160).optional().nullable(),
  artifactUrl: z.string().url(),
  sha256: z.string().min(64).max(64),
  sizeBytes: z.number().int().min(0).optional().nullable(),
  minAppVersion: z.string().max(40).optional().nullable(),
  channel: z.string().min(1).max(40).default("stable"),
  riskLevel: z.enum(["low", "medium", "high"]).default("low"),
  defaultEligible: z.boolean().default(false),
  featured: z.boolean().default(false),
  enabled: z.boolean().default(true),
  notes: z.string().max(2000).optional().nullable(),
});

const updateEnabledSchema = z.object({
  enabled: z.boolean(),
});

function formBool(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value === undefined || value === null || value === "") return fallback;
  return ["true", "1", "on", "yes"].includes(String(value).toLowerCase());
}

function formNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizeCreateInput(raw) {
  return createSkillPackageSchema.parse({
    skillId: raw.skillId,
    name: raw.name,
    description: raw.description || null,
    version: raw.version,
    category: raw.category || "core",
    categoryLabel: raw.categoryLabel || null,
    capabilityLayer: raw.capabilityLayer || "core",
    publisher: raw.publisher || "Lily Workbench",
    sourceKind: raw.sourceKind || "lily",
    sourceRepo: raw.sourceRepo || null,
    artifactUrl: raw.artifactUrl,
    sha256: raw.sha256,
    sizeBytes: formNumber(raw.sizeBytes, null),
    minAppVersion: raw.minAppVersion || null,
    channel: raw.channel || "stable",
    riskLevel: raw.riskLevel || "low",
    defaultEligible: formBool(raw.defaultEligible),
    featured: formBool(raw.featured),
    enabled: formBool(raw.enabled, true),
    notes: raw.notes || null,
  });
}

async function upsertSkillPackage(input, preferredId = publicId("skillpkg")) {
  await db
    .insertInto("skill_packages")
    .values({
      id: preferredId,
      skill_id: input.skillId,
      name: input.name,
      description: input.description || null,
      version: input.version,
      category: input.category,
      category_label: input.categoryLabel || null,
      capability_layer: input.capabilityLayer,
      publisher: input.publisher,
      source_kind: input.sourceKind,
      source_repo: input.sourceRepo || null,
      artifact_url: input.artifactUrl,
      sha256: input.sha256.toLowerCase(),
      size_bytes: input.sizeBytes || null,
      min_app_version: input.minAppVersion || null,
      channel: input.channel,
      risk_level: input.riskLevel,
      default_eligible: input.defaultEligible,
      featured: input.featured,
      enabled: input.enabled,
      notes: input.notes || null,
    })
    .onConflict((oc) =>
      oc.columns(["skill_id", "version", "channel"]).doUpdateSet({
        name: input.name,
        description: input.description || null,
        category: input.category,
        category_label: input.categoryLabel || null,
        capability_layer: input.capabilityLayer,
        publisher: input.publisher,
        source_kind: input.sourceKind,
        source_repo: input.sourceRepo || null,
        artifact_url: input.artifactUrl,
        sha256: input.sha256.toLowerCase(),
        size_bytes: input.sizeBytes || null,
        min_app_version: input.minAppVersion || null,
        risk_level: input.riskLevel,
        default_eligible: input.defaultEligible,
        featured: input.featured,
        enabled: input.enabled,
        notes: input.notes || null,
        updated_at: new Date(),
      }),
    )
    .execute();
  return preferredId;
}

async function readSkillPackageUpload(request) {
  const fields = {};
  let artifact = null;
  for await (const part of request.parts()) {
    if (part.type === "file") {
      if (part.fieldname !== "artifact") continue;
      artifact = {
        fileName: part.filename,
        mimeType: part.mimetype || "application/zip",
        buffer: await part.toBuffer(),
      };
    } else {
      fields[part.fieldname] = part.value;
    }
  }
  return { fields, artifact };
}

function enforceSkillPackageQuality(input, reply) {
  const quality = evaluateSkillPackageQuality(input);
  if (quality.ok) return null;
  return reply.code(400).send({
    ok: false,
    code: "SKILL_QUALITY_GATE_FAILED",
    score: quality.score,
    maxScore: quality.maxScore,
    issues: quality.issues,
  });
}

export function registerAdminSkillPackageRoutes(app, { audit }) {
  app.get("/api/admin/skill-packages", async () => ({
    skillPackages: await db
      .selectFrom("skill_packages")
      .selectAll()
      .orderBy("created_at", "desc")
      .limit(300)
      .execute(),
  }));

  app.post("/api/admin/skill-packages", async (request, reply) => {
    const input = normalizeCreateInput(request.body || {});
    if (!isValidSkillArtifactUrl(input.artifactUrl)) {
      return reply.code(400).send({ ok: false, code: "INVALID_ARTIFACT_URL" });
    }
    if (!isValidSkillSha256(input.sha256)) {
      return reply.code(400).send({ ok: false, code: "INVALID_SHA256" });
    }
    const qualityFailure = enforceSkillPackageQuality(input, reply);
    if (qualityFailure) return qualityFailure;

    const id = await upsertSkillPackage(input);
    await audit(request, "skill_package.upsert", "skill_package", input.skillId, {
      version: input.version,
      channel: input.channel,
      enabled: input.enabled,
    });
    return reply.code(201).send({ ok: true, id, skillId: input.skillId });
  });

  app.post("/api/admin/skill-packages/upload", async (request, reply) => {
    const { fields, artifact } = await readSkillPackageUpload(request);
    if (!artifact) {
      return reply.code(400).send({ ok: false, code: "MISSING_ARTIFACT" });
    }

    const checked = validateSkillPackageArtifact({
      buffer: artifact.buffer,
      fileName: artifact.fileName,
    });
    if (!checked.ok) {
      return reply.code(400).send({ ok: false, code: checked.code });
    }

    const id = publicId("skillpkg");
    const sha256 = crypto.createHash("sha256").update(artifact.buffer).digest("hex");
    const objectKey = skillPackageObjectKey({
      skillId: fields.skillId,
      version: fields.version,
      fileName: checked.fileName,
      id,
    });
    const upload = await uploadBufferToQiniu({
      key: objectKey,
      buffer: artifact.buffer,
      fileName: checked.fileName,
      mimeType: artifact.mimeType || "application/zip",
    });
    const input = normalizeCreateInput({
      ...fields,
      artifactUrl: upload.publicUrl,
      sha256,
      sizeBytes: checked.sizeBytes,
      sourceKind: fields.sourceKind || "lily",
      enabled: !formBool(fields.disabled),
    });
    const qualityFailure = enforceSkillPackageQuality(input, reply);
    if (qualityFailure) return qualityFailure;
    const savedId = await upsertSkillPackage(input, id);

    await audit(request, "skill_package.upload", "skill_package", input.skillId, {
      version: input.version,
      channel: input.channel,
      enabled: input.enabled,
      objectKey: upload.key,
      sizeBytes: checked.sizeBytes,
    });
    return reply.code(201).send({
      ok: true,
      id: savedId,
      skillId: input.skillId,
      artifactUrl: upload.publicUrl,
      sha256,
      sizeBytes: checked.sizeBytes,
    });
  });

  app.patch("/api/admin/skill-packages/:id", async (request) => {
    const input = updateEnabledSchema.parse(request.body);
    await db
      .updateTable("skill_packages")
      .set({ enabled: input.enabled, updated_at: new Date() })
      .where("id", "=", request.params.id)
      .execute();
    await audit(request, "skill_package.update", "skill_package", request.params.id, {
      enabled: input.enabled,
    });
    return { ok: true, id: request.params.id };
  });
}
