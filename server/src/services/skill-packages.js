const SHA256_RE = /^[0-9a-f]{64}$/i;
const TRUSTED_ARTIFACT_PROTOCOLS = new Set(["https:"]);
const MAX_SKILL_PACKAGE_BYTES = 50 * 1024 * 1024;
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

export const SKILL_CATEGORIES = [
  { id: "core", label: "核心能力" },
  { id: "coding", label: "编程创作" },
  { id: "design", label: "设计交互" },
  { id: "media", label: "媒体创意" },
  { id: "office", label: "办公文档" },
  { id: "research", label: "联网研究" },
  { id: "quality", label: "质量评测" },
  { id: "professional", label: "专业扩展" },
];

const CATEGORY_IDS = new Set(SKILL_CATEGORIES.map((category) => category.id));
const SKILL_ID_RE = /^[a-z][a-z0-9-]{1,99}$/;

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

export function isValidSkillArtifactUrl(value) {
  if (!value || typeof value !== "string") return false;
  try {
    const parsed = new URL(value.trim());
    return TRUSTED_ARTIFACT_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}

export function isValidSkillSha256(value) {
  return SHA256_RE.test(String(value || "").trim());
}

export function normalizeSkillPackageFileName(value) {
  const fileName = String(value || "skill.skillpack.zip").trim();
  const cleaned = fileName.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 120) || "skill.skillpack.zip";
}

export function validateSkillPackageArtifact({ buffer, fileName }) {
  if (!Buffer.isBuffer(buffer) || buffer.length <= 0) {
    return { ok: false, code: "EMPTY_SKILL_PACKAGE" };
  }
  if (buffer.length > MAX_SKILL_PACKAGE_BYTES) {
    return { ok: false, code: "SKILL_PACKAGE_TOO_LARGE" };
  }
  const normalizedName = normalizeSkillPackageFileName(fileName);
  if (!normalizedName.endsWith(".skillpack.zip") && !normalizedName.endsWith(".zip")) {
    return { ok: false, code: "INVALID_SKILL_PACKAGE_NAME" };
  }
  if (buffer.length < ZIP_MAGIC.length || !buffer.subarray(0, ZIP_MAGIC.length).equals(ZIP_MAGIC)) {
    return { ok: false, code: "INVALID_SKILL_PACKAGE_ZIP" };
  }
  return { ok: true, fileName: normalizedName, sizeBytes: buffer.length };
}

export function evaluateSkillPackageQuality(input) {
  const issues = [];
  let score = 0;

  if (SKILL_ID_RE.test(String(input.skillId || ""))) score += 5;
  else issues.push("Skill ID must use lowercase kebab-case and start with a letter");

  if (String(input.name || "").trim().length >= 2) score += 4;
  else issues.push("Name is required");

  const description = String(input.description || "").trim();
  if (description.length >= 80) score += 5;
  else if (description.length >= 40) score += 3;
  else issues.push("Description must explain when to use the skill and what capability it improves");

  if (String(input.version || "").trim()) score += 3;
  else issues.push("Version is required");

  if (CATEGORY_IDS.has(String(input.category || ""))) score += 4;
  else issues.push(`Category must be one of: ${[...CATEGORY_IDS].join(", ")}`);

  if (String(input.capabilityLayer || "").trim()) score += 4;
  else issues.push("Capability layer is required");

  if (isValidSkillArtifactUrl(input.artifactUrl)) score += 4;
  else issues.push("Artifact URL must be HTTPS");

  if (isValidSkillSha256(input.sha256)) score += 4;
  else issues.push("SHA256 must be a 64-character hex digest");

  if (["low", "medium", "high"].includes(String(input.riskLevel || ""))) score += 3;
  else issues.push("Risk level must be low, medium, or high");

  if (input.riskLevel === "high" && (input.defaultEligible || input.featured)) {
    issues.push("High-risk skills cannot be default eligible or featured");
  } else {
    score += 4;
  }

  if (input.defaultEligible && input.sourceKind && input.sourceKind !== "lily") {
    issues.push("Only Lily-reviewed skills can be default eligible");
  } else {
    score += 3;
  }

  if (input.featured && !input.defaultEligible) {
    issues.push("Featured skills must also be default eligible");
  } else {
    score += 3;
  }

  const ok = issues.length === 0 && score >= 34;
  return { ok, score, maxScore: 43, issues };
}

export function skillPackageObjectKey({ skillId, version, fileName, id }) {
  const safeSkillId = String(skillId || "skill")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100) || "skill";
  const safeVersion = String(version || "0.0.0")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "0.0.0";
  return `skill-packages/${safeSkillId}/${safeVersion}/${id}-${normalizeSkillPackageFileName(fileName)}`;
}

export function newestSkillPackages(rows = []) {
  const bySkillId = new Map();
  for (const row of rows) {
    if (!row?.enabled) continue;
    const existing = bySkillId.get(row.skill_id);
    if (!existing) {
      bySkillId.set(row.skill_id, row);
      continue;
    }
    const versionOrder = compareVersions(row.version, existing.version);
    if (versionOrder > 0) {
      bySkillId.set(row.skill_id, row);
      continue;
    }
    if (versionOrder === 0) {
      const rowCreated = new Date(row.created_at || 0).getTime();
      const existingCreated = new Date(existing.created_at || 0).getTime();
      if (rowCreated > existingCreated) bySkillId.set(row.skill_id, row);
    }
  }
  return [...bySkillId.values()];
}

export function skillPackageToRegistryEntry(row) {
  return {
    id: row.skill_id,
    name: row.name,
    description: row.description || "",
    latestVersion: row.version,
    minAppVersion: row.min_app_version || null,
    sizeBytes: Number(row.size_bytes || 0) || null,
    changelog: row.notes || "",
    channel: row.channel || "stable",
    sourceType: "zip",
    downloadUrl: row.artifact_url,
    sha256: String(row.sha256 || "").toLowerCase(),
    category: row.category || "core",
    categoryLabel: row.category_label || row.category || "core",
    publisher: row.publisher || "Lily Workbench",
    sourceRepo: row.source_repo || null,
    capabilityLayer: row.capability_layer || "core",
    riskLevel: row.risk_level || "low",
    defaultEligible: Boolean(row.default_eligible),
    featured: Boolean(row.featured),
  };
}

export function buildSkillRegistry(rows = [], { registryUrl = "" } = {}) {
  return {
    schemaVersion: 1,
    publisher: "Lily Workbench",
    registryUrl: registryUrl || null,
    updatedAt: new Date().toISOString(),
    categories: SKILL_CATEGORIES,
    skills: newestSkillPackages(rows).map(skillPackageToRegistryEntry),
  };
}
