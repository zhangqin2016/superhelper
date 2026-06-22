import crypto from "node:crypto";
import { z } from "zod";
import { db } from "../../db.js";
import { publicId } from "../../services/ids.js";
import { uploadBufferToQiniu } from "../../services/qiniu-upload.js";
import {
  evaluateWorkspaceAppQuality,
  inspectWorkspaceAppArtifact,
  isValidWorkspaceAppArtifactUrl,
  isValidWorkspaceAppSha256,
  MAX_WORKSPACE_APP_BYTES,
  parseList,
  validateWorkspaceAppArtifact,
  workspaceAppObjectKey,
} from "../../services/workspace-apps.js";

const WORKSPACE_APP_DOWNLOAD_TIMEOUT_MS = 120_000;

const createWorkspaceAppSchema = z.object({
  appId: z.string().min(2).max(100),
  name: z.string().min(1).max(160),
  summary: z.string().min(1).max(180),
  description: z.string().max(4000).optional().nullable(),
  version: z.string().min(1).max(40),
  category: z.string().min(1).max(60).default("productivity"),
  appType: z.enum(["workspace", "template", "tool", "dashboard", "connector"]).default("workspace"),
  entryKind: z.enum(["zip", "url"]).default("zip"),
  publisher: z.string().min(1).max(120).default("Lily Workbench"),
  sourceKind: z.string().min(1).max(60).default("lily"),
  sourceRepo: z.string().max(160).optional().nullable(),
  artifactUrl: z.string().url(),
  sha256: z.string().min(64).max(64),
  sizeBytes: z.number().int().min(0).optional().nullable(),
  minAppVersion: z.string().max(40).optional().nullable(),
  channel: z.string().min(1).max(40).default("stable"),
  minPlan: z.enum(["free", "pro", "vip"]).default("free"),
  riskLevel: z.enum(["low", "medium", "high"]).default("low"),
  featured: z.boolean().default(false),
  enabled: z.boolean().default(true),
  tags: z.array(z.string()).default([]),
  requiredRuntimePacks: z.array(z.string()).default([]),
  requiredSkillPackages: z.array(z.string()).default([]),
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
  return createWorkspaceAppSchema.parse({
    appId: raw.appId,
    name: raw.name,
    summary: raw.summary,
    description: raw.description || null,
    version: raw.version,
    category: raw.category || "productivity",
    appType: raw.appType || "workspace",
    entryKind: raw.entryKind || "zip",
    publisher: raw.publisher || "Lily Workbench",
    sourceKind: raw.sourceKind || "lily",
    sourceRepo: raw.sourceRepo || null,
    artifactUrl: raw.artifactUrl,
    sha256: raw.sha256,
    sizeBytes: formNumber(raw.sizeBytes, null),
    minAppVersion: raw.minAppVersion || null,
    channel: raw.channel || "stable",
    minPlan: raw.minPlan || "free",
    riskLevel: raw.riskLevel || "low",
    featured: formBool(raw.featured),
    enabled: formBool(raw.enabled, true),
    tags: parseList(raw.tags),
    requiredRuntimePacks: parseList(raw.requiredRuntimePacks),
    requiredSkillPackages: parseList(raw.requiredSkillPackages),
    notes: raw.notes || null,
  });
}

async function upsertWorkspaceApp(input, preferredId = publicId("app")) {
  await db
    .insertInto("workspace_apps")
    .values({
      id: preferredId,
      app_id: input.appId,
      name: input.name,
      summary: input.summary,
      description: input.description || null,
      version: input.version,
      category: input.category,
      app_type: input.appType,
      entry_kind: input.entryKind,
      publisher: input.publisher,
      source_kind: input.sourceKind,
      source_repo: input.sourceRepo || null,
      artifact_url: input.artifactUrl,
      sha256: input.sha256.toLowerCase(),
      size_bytes: input.sizeBytes || null,
      min_app_version: input.minAppVersion || null,
      channel: input.channel,
      min_plan: input.minPlan,
      risk_level: input.riskLevel,
      featured: input.featured,
      enabled: input.enabled,
      tags: JSON.stringify(input.tags),
      required_runtime_packs: JSON.stringify(input.requiredRuntimePacks),
      required_skill_packages: JSON.stringify(input.requiredSkillPackages),
      notes: input.notes || null,
    })
    .onConflict((oc) =>
      oc.columns(["app_id", "version", "channel"]).doUpdateSet({
        name: input.name,
        summary: input.summary,
        description: input.description || null,
        category: input.category,
        app_type: input.appType,
        entry_kind: input.entryKind,
        publisher: input.publisher,
        source_kind: input.sourceKind,
        source_repo: input.sourceRepo || null,
        artifact_url: input.artifactUrl,
        sha256: input.sha256.toLowerCase(),
        size_bytes: input.sizeBytes || null,
        min_app_version: input.minAppVersion || null,
        min_plan: input.minPlan,
        risk_level: input.riskLevel,
        featured: input.featured,
        enabled: input.enabled,
        tags: JSON.stringify(input.tags),
        required_runtime_packs: JSON.stringify(input.requiredRuntimePacks),
        required_skill_packages: JSON.stringify(input.requiredSkillPackages),
        notes: input.notes || null,
        updated_at: new Date(),
      }),
    )
    .execute();
  return preferredId;
}

async function readWorkspaceAppUpload(request) {
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

function enforceWorkspaceAppQuality(input, reply) {
  const quality = evaluateWorkspaceAppQuality(input);
  if (quality.ok) return null;
  return reply.code(400).send({
    ok: false,
    code: "WORKSPACE_APP_QUALITY_GATE_FAILED",
    score: quality.score,
    maxScore: quality.maxScore,
    issues: quality.issues,
  });
}

async function downloadWorkspaceAppForInspection(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WORKSPACE_APP_DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return { ok: false, code: "ARTIFACT_DOWNLOAD_FAILED" };
    const length = Number(response.headers.get("content-length") || 0);
    if (length > MAX_WORKSPACE_APP_BYTES) {
      return { ok: false, code: "WORKSPACE_APP_TOO_LARGE" };
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_WORKSPACE_APP_BYTES) {
      return { ok: false, code: "WORKSPACE_APP_TOO_LARGE" };
    }
    return { ok: true, buffer };
  } catch {
    return { ok: false, code: "ARTIFACT_DOWNLOAD_FAILED" };
  } finally {
    clearTimeout(timer);
  }
}

export function registerAdminWorkspaceAppRoutes(app, { audit }) {
  app.get("/api/admin/workspace-apps", async () => ({
    workspaceApps: await db
      .selectFrom("workspace_apps")
      .selectAll()
      .orderBy("created_at", "desc")
      .limit(300)
      .execute(),
  }));

  app.post("/api/admin/workspace-apps", async (request, reply) => {
    const input = normalizeCreateInput(request.body || {});
    if (!isValidWorkspaceAppArtifactUrl(input.artifactUrl)) {
      return reply.code(400).send({ ok: false, code: "INVALID_ARTIFACT_URL" });
    }
    if (!isValidWorkspaceAppSha256(input.sha256)) {
      return reply.code(400).send({ ok: false, code: "INVALID_SHA256" });
    }
    const artifact = await downloadWorkspaceAppForInspection(input.artifactUrl);
    if (!artifact.ok) return reply.code(400).send({ ok: false, code: artifact.code });
    const actualSha256 = crypto.createHash("sha256").update(artifact.buffer).digest("hex");
    if (actualSha256 !== input.sha256.toLowerCase()) {
      return reply.code(400).send({ ok: false, code: "CHECKSUM_MISMATCH" });
    }
    const manifest = await inspectWorkspaceAppArtifact(artifact.buffer);
    if (!manifest.ok) return reply.code(400).send({ ok: false, code: manifest.code });
    const qualityFailure = enforceWorkspaceAppQuality(input, reply);
    if (qualityFailure) return qualityFailure;

    const id = await upsertWorkspaceApp(input);
    await audit(request, "workspace_app.upsert", "workspace_app", input.appId, {
      version: input.version,
      channel: input.channel,
      enabled: input.enabled,
    });
    return reply.code(201).send({ ok: true, id, appId: input.appId });
  });

  app.post("/api/admin/workspace-apps/upload", async (request, reply) => {
    const { fields, artifact } = await readWorkspaceAppUpload(request);
    if (!artifact) {
      return reply.code(400).send({ ok: false, code: "MISSING_ARTIFACT" });
    }

    const checked = validateWorkspaceAppArtifact({
      buffer: artifact.buffer,
      fileName: artifact.fileName,
    });
    if (!checked.ok) {
      return reply.code(400).send({ ok: false, code: checked.code });
    }
    const manifest = await inspectWorkspaceAppArtifact(artifact.buffer);
    if (!manifest.ok) {
      return reply.code(400).send({ ok: false, code: manifest.code });
    }

    const id = publicId("app");
    const sha256 = crypto.createHash("sha256").update(artifact.buffer).digest("hex");
    const objectKey = workspaceAppObjectKey({
      appId: fields.appId,
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
    const qualityFailure = enforceWorkspaceAppQuality(input, reply);
    if (qualityFailure) return qualityFailure;
    const savedId = await upsertWorkspaceApp(input, id);

    await audit(request, "workspace_app.upload", "workspace_app", input.appId, {
      version: input.version,
      channel: input.channel,
      enabled: input.enabled,
      objectKey: upload.key,
      sizeBytes: checked.sizeBytes,
    });
    return reply.code(201).send({
      ok: true,
      id: savedId,
      appId: input.appId,
      artifactUrl: upload.publicUrl,
      sha256,
      sizeBytes: checked.sizeBytes,
    });
  });

  app.patch("/api/admin/workspace-apps/:id", async (request) => {
    const input = updateEnabledSchema.parse(request.body);
    await db
      .updateTable("workspace_apps")
      .set({ enabled: input.enabled, updated_at: new Date() })
      .where("id", "=", request.params.id)
      .execute();
    await audit(request, "workspace_app.update", "workspace_app", request.params.id, {
      enabled: input.enabled,
    });
    return { ok: true, id: request.params.id };
  });
}
