const SHA256_RE = /^[0-9a-f]{64}$/i;
const TRUSTED_ARTIFACT_PROTOCOLS = new Set(["https:"]);
export const MAX_SKILL_PACKAGE_BYTES = 200 * 1024 * 1024;
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

export const SKILL_CATEGORIES = [
  { id: "core", label: "核心能力", label_i18n: { en: "Core", ar: "القدرات الأساسية" } },
  { id: "coding", label: "编程创作", label_i18n: { en: "Development", ar: "التطوير" } },
  { id: "design", label: "设计交互", label_i18n: { en: "Design & UI", ar: "التصميم والواجهات" } },
  { id: "media", label: "媒体创意", label_i18n: { en: "Media & Creative", ar: "الوسائط والإبداع" } },
  { id: "office", label: "办公文档", label_i18n: { en: "Office Documents", ar: "مستندات المكتب" } },
  { id: "research", label: "联网研究", label_i18n: { en: "Research", ar: "البحث" } },
  { id: "quality", label: "质量评测", label_i18n: { en: "Quality Review", ar: "مراجعة الجودة" } },
  { id: "professional", label: "专业扩展", label_i18n: { en: "Professional", ar: "احترافي" } },
];

const CATEGORY_IDS = new Set(SKILL_CATEGORIES.map((category) => category.id));
const SKILL_ID_RE = /^[a-z][a-z0-9-]{1,99}$/;
const CAPABILITY_KINDS = new Set(["workflow", "quality", "tool", "connector", "runtime", "router"]);
const CONFIRMATION_POLICIES = new Set(["none", "before_mutation", "always"]);

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

function normalizeStringMap(raw) {
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = {};
  for (const [locale, value] of Object.entries(raw)) {
    if (!locale || typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) out[String(locale)] = trimmed;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function uniqueStrings(value) {
  const values = Array.isArray(value) ? value : [];
  return [...new Set(values.map((item) => String(item || "").trim()).filter(Boolean))];
}

function parseJsonObject(raw) {
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
}

function normalizeCapabilityContract(raw, row) {
  const source = parseJsonObject(raw) || {};
  const riskLevel = ["low", "medium", "high"].includes(String(source.risk?.level || ""))
    ? String(source.risk.level)
    : String(row.risk_level || "low");
  const defaultConfirmation =
    riskLevel === "high" ? "always" : riskLevel === "medium" ? "before_mutation" : "none";
  const confirmation = CONFIRMATION_POLICIES.has(String(source.risk?.confirmation || ""))
    ? String(source.risk.confirmation)
    : defaultConfirmation;
  const kind = CAPABILITY_KINDS.has(String(source.kind || ""))
    ? String(source.kind)
    : CAPABILITY_KINDS.has(String(row.capability_layer || ""))
      ? String(row.capability_layer)
      : "workflow";
  return {
    schemaVersion: 1,
    kind,
    intents: uniqueStrings(source.intents),
    avoidIntents: uniqueStrings(source.avoidIntents),
    primaryTools: uniqueStrings(source.primaryTools),
    runtimeDependencies: uniqueStrings(source.runtimeDependencies),
    inputModes: uniqueStrings(source.inputModes).length ? uniqueStrings(source.inputModes) : ["text"],
    outputModes: uniqueStrings(source.outputModes).length ? uniqueStrings(source.outputModes) : ["text"],
    risk: { level: riskLevel, confirmation },
    verification: {
      required: Boolean(source.verification?.required),
      methods: uniqueStrings(source.verification?.methods),
    },
    failure: {
      recovery: uniqueStrings(source.failure?.recovery),
    },
  };
}

export function skillPackageToRegistryEntry(row) {
  return {
    id: row.skill_id,
    name: row.name,
    name_i18n: normalizeStringMap(row.name_i18n),
    description: row.description || "",
    description_i18n: normalizeStringMap(row.description_i18n),
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
    categoryLabel_i18n: normalizeStringMap(row.category_label_i18n),
    publisher: row.publisher || "Lily Workbench",
    sourceRepo: row.source_repo || null,
    capabilityLayer: row.capability_layer || "core",
    riskLevel: row.risk_level || "low",
    defaultEligible: Boolean(row.default_eligible),
    featured: Boolean(row.featured),
    displayInCatalog: row.display_in_catalog !== false,
    capability: normalizeCapabilityContract(row.capability || row.capability_contract, row),
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
