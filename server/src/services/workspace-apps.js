import JSZip from "jszip";
import { planAllows } from "./entitlements.js";

const SHA256_RE = /^[0-9a-f]{64}$/i;
const TRUSTED_ARTIFACT_PROTOCOLS = new Set(["https:"]);
export const MAX_WORKSPACE_APP_BYTES = 100 * 1024 * 1024;
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const APP_ID_RE = /^[a-z][a-z0-9-]{1,99}$/;
const WORKSPACE_APP_MANIFEST = "lily-workspace.json";
const SUPPORTED_WORKSPACE_APP_SCHEMA = 1;
const SUPPORTED_WORKSPACE_APP_KINDS = new Set(["lily-workspace-pack", "lily-workspace-app"]);

export const WORKSPACE_APP_CATEGORIES = [
  { id: "productivity", label: "效率工具" },
  { id: "office", label: "办公文档" },
  { id: "connectors", label: "连接器" },
  { id: "data", label: "数据分析" },
  { id: "finance", label: "金融投研" },
  { id: "creative", label: "设计创意" },
  { id: "developer", label: "开发工具" },
  { id: "business", label: "业务系统" },
  { id: "education", label: "学习教育" },
];

const CATEGORY_IDS = new Set(WORKSPACE_APP_CATEGORIES.map((category) => category.id));

export function compareVersions(a, b) {
  const pa = String(a || "0").split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = String(b || "0").split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

export function isValidWorkspaceAppArtifactUrl(value) {
  if (!value || typeof value !== "string") return false;
  try {
    const parsed = new URL(value.trim());
    return TRUSTED_ARTIFACT_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}

export function isValidWorkspaceAppSha256(value) {
  return SHA256_RE.test(String(value || "").trim());
}

export function normalizeWorkspaceAppFileName(value) {
  const fileName = String(value || "workspace-app.zip").trim();
  const cleaned = fileName.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 140) || "workspace-app.zip";
}

export function validateWorkspaceAppArtifact({ buffer, fileName }) {
  if (!Buffer.isBuffer(buffer) || buffer.length <= 0) {
    return { ok: false, code: "EMPTY_WORKSPACE_APP" };
  }
  if (buffer.length > MAX_WORKSPACE_APP_BYTES) {
    return { ok: false, code: "WORKSPACE_APP_TOO_LARGE" };
  }
  const normalizedName = normalizeWorkspaceAppFileName(fileName);
  if (!normalizedName.endsWith(".zip")) {
    return { ok: false, code: "INVALID_WORKSPACE_APP_NAME" };
  }
  if (buffer.length < ZIP_MAGIC.length || !buffer.subarray(0, ZIP_MAGIC.length).equals(ZIP_MAGIC)) {
    return { ok: false, code: "INVALID_WORKSPACE_APP_ZIP" };
  }
  return { ok: true, fileName: normalizedName, sizeBytes: buffer.length };
}

export async function inspectWorkspaceAppArtifact(buffer) {
  const checked = validateWorkspaceAppArtifact({ buffer, fileName: "workspace-app.zip" });
  if (!checked.ok) return checked;

  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    return { ok: false, code: "WORKSPACE_APP_ZIP_CORRUPT" };
  }

  const manifestEntry = zip.file(WORKSPACE_APP_MANIFEST);
  if (!manifestEntry) {
    return { ok: false, code: "WORKSPACE_APP_MANIFEST_MISSING" };
  }

  let manifest;
  try {
    manifest = JSON.parse(await manifestEntry.async("string"));
  } catch {
    return { ok: false, code: "WORKSPACE_APP_MANIFEST_CORRUPT" };
  }

  if (!SUPPORTED_WORKSPACE_APP_KINDS.has(String(manifest?.kind || ""))) {
    return { ok: false, code: "WORKSPACE_APP_KIND_UNSUPPORTED" };
  }
  if (!Number.isInteger(manifest.schemaVersion)) {
    return { ok: false, code: "WORKSPACE_APP_SCHEMA_INVALID" };
  }
  if (manifest.schemaVersion > SUPPORTED_WORKSPACE_APP_SCHEMA) {
    return { ok: false, code: "WORKSPACE_APP_SCHEMA_TOO_NEW" };
  }
  const files = Object.values(zip.files).filter((entry) => !entry.dir && entry.name.startsWith("files/"));
  if (files.length === 0) {
    return { ok: false, code: "WORKSPACE_APP_FILES_MISSING" };
  }

  return {
    ok: true,
    manifest: {
      kind: manifest.kind,
      schemaVersion: manifest.schemaVersion,
      name: manifest.name || "",
      folderName: manifest.folderName || "",
      description: manifest.description || "",
      requiredSkills: Array.isArray(manifest.requiredSkills) ? manifest.requiredSkills.filter(Boolean) : [],
      requiredRuntimePacks: Array.isArray(manifest.requiredRuntimePacks) ? manifest.requiredRuntimePacks.filter(Boolean) : [],
    },
  };
}

export function parseList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (value === undefined || value === null) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function evaluateWorkspaceAppQuality(input) {
  const issues = [];
  let score = 0;

  if (APP_ID_RE.test(String(input.appId || ""))) score += 5;
  else issues.push("App ID must use lowercase kebab-case and start with a letter");

  if (String(input.name || "").trim().length >= 2) score += 4;
  else issues.push("Name is required");

  const summary = String(input.summary || "").trim();
  if (summary.length >= 20 && summary.length <= 180) score += 5;
  else issues.push("Summary must describe the app in 20-180 characters");

  const description = String(input.description || "").trim();
  if (!description || description.length >= 60) score += 4;
  else issues.push("Description must explain user workflow, inputs, outputs, and limits");

  if (String(input.version || "").trim()) score += 3;
  else issues.push("Version is required");

  if (CATEGORY_IDS.has(String(input.category || ""))) score += 4;
  else issues.push(`Category must be one of: ${[...CATEGORY_IDS].join(", ")}`);

  if (["workspace", "template", "tool", "dashboard", "connector"].includes(String(input.appType || ""))) score += 3;
  else issues.push("App type must be workspace, template, tool, dashboard, or connector");

  if (["zip", "url"].includes(String(input.entryKind || ""))) score += 3;
  else issues.push("Entry kind must be zip or url");

  if (isValidWorkspaceAppArtifactUrl(input.artifactUrl)) score += 4;
  else issues.push("Artifact URL must be HTTPS");

  if (isValidWorkspaceAppSha256(input.sha256)) score += 4;
  else issues.push("SHA256 must be a 64-character hex digest");

  if (["low", "medium", "high"].includes(String(input.riskLevel || ""))) score += 3;
  else issues.push("Risk level must be low, medium, or high");

  if (input.riskLevel === "high" && input.featured) {
    issues.push("High-risk apps cannot be featured");
  } else {
    score += 4;
  }

  if (input.featured && input.sourceKind && input.sourceKind !== "lily") {
    issues.push("Only Lily-reviewed apps can be featured");
  } else {
    score += 3;
  }

  const ok = issues.length === 0 && score >= 38;
  return { ok, score, maxScore: 46, issues };
}

export function workspaceAppObjectKey({ appId, version, fileName, id }) {
  const safeAppId = String(appId || "workspace-app")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100) || "workspace-app";
  const safeVersion = String(version || "0.0.0")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "0.0.0";
  return `workspace-apps/${safeAppId}/${safeVersion}/${id}-${normalizeWorkspaceAppFileName(fileName)}`;
}

export function newestWorkspaceApps(rows = []) {
  const byAppId = new Map();
  for (const row of rows) {
    if (!row?.enabled) continue;
    const existing = byAppId.get(row.app_id);
    if (!existing) {
      byAppId.set(row.app_id, row);
      continue;
    }
    const versionOrder = compareVersions(row.version, existing.version);
    if (versionOrder > 0) {
      byAppId.set(row.app_id, row);
      continue;
    }
    if (versionOrder === 0) {
      const rowCreated = new Date(row.created_at || 0).getTime();
      const existingCreated = new Date(existing.created_at || 0).getTime();
      if (rowCreated > existingCreated) byAppId.set(row.app_id, row);
    }
  }
  return [...byAppId.values()];
}

export function workspaceAppToCatalogEntry(row) {
  const minPlan = String(row.min_plan || "free");
  // Gated apps never expose their artifact URL in the catalog — the client must
  // obtain it from the signed, entitlement-checked POST /api/apps/:id/download.
  // Free apps keep the inline URL (direct install, no round-trip).
  const gated = minPlan !== "free";
  return {
    id: row.app_id,
    name: row.name,
    summary: row.summary,
    description: row.description || "",
    latestVersion: row.version,
    minAppVersion: row.min_app_version || null,
    sizeBytes: Number(row.size_bytes || 0) || null,
    changelog: row.notes || "",
    channel: row.channel || "stable",
    sourceType: row.entry_kind || "zip",
    downloadUrl: gated ? null : row.artifact_url,
    minPlan,
    gated,
    sha256: String(row.sha256 || "").toLowerCase(),
    signature: String(row.signature || ""),
    category: row.category || "productivity",
    appType: row.app_type || "workspace",
    publisher: row.publisher || "Lily Workbench",
    sourceRepo: row.source_repo || null,
    riskLevel: row.risk_level || "low",
    featured: Boolean(row.featured),
    tags: Array.isArray(row.tags) ? row.tags : [],
    requiredRuntimePacks: Array.isArray(row.required_runtime_packs) ? row.required_runtime_packs : [],
    requiredSkillPackages: Array.isArray(row.required_skill_packages) ? row.required_skill_packages : [],
  };
}

export function buildWorkspaceAppCatalog(rows = [], { catalogUrl = "", viewerPlan = "free" } = {}) {
  // Server-side visibility filter: an app the viewer's plan can't reach is
  // dropped entirely, so VIP apps never appear for non-VIP viewers. (The client
  // applies the same filter offline from its signed license; the hard gate is
  // the entitlement check at download time.)
  const apps = newestWorkspaceApps(rows)
    .map(workspaceAppToCatalogEntry)
    .filter((app) => planAllows(viewerPlan, app.minPlan));
  return {
    schemaVersion: 1,
    publisher: "Lily Workbench",
    catalogUrl: catalogUrl || null,
    updatedAt: new Date().toISOString(),
    categories: WORKSPACE_APP_CATEGORIES,
    apps,
  };
}
