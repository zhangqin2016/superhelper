import { planAllows } from "./entitlements.js";

export const LEGAL_KB_PACK_ID = "legal-cn-enterprise";
export const LEGAL_KB_CHARACTER_ID = "lily-cn-legal-counsel";
const SHA256_RE = /^[a-f0-9]{64}$/i;
const VERSION_PART_RE = /^[A-Za-z0-9]+$/;

export function compareLegalPackVersions(a, b) {
  const left = String(a || "0").replace(/^v/i, "").split(/[.-]/).map((part) => {
    if (/^\d+$/.test(part)) return Number(part);
    return part.toLowerCase();
  });
  const right = String(b || "0").replace(/^v/i, "").split(/[.-]/).map((part) => {
    if (/^\d+$/.test(part)) return Number(part);
    return part.toLowerCase();
  });
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const aPart = left[i] ?? 0;
    const bPart = right[i] ?? 0;
    if (typeof aPart === "number" && typeof bPart === "number") {
      if (aPart !== bPart) return aPart > bPart ? 1 : -1;
    } else {
      const order = String(aPart).localeCompare(String(bPart));
      if (order) return order;
    }
  }
  return 0;
}

export function isValidLegalPackArtifact(row = {}) {
  const version = String(row.version || "").trim();
  return String(row.pack_id || "") === LEGAL_KB_PACK_ID
    && String(row.character_id || "") === LEGAL_KB_CHARACTER_ID
    && /^https:\/\//i.test(String(row.url || ""))
    && SHA256_RE.test(String(row.sha256 || ""))
    && Number.isSafeInteger(Number(row.size_bytes))
    && Number(row.size_bytes) > 0
    && Number(row.schema_version || 0) === 1
    && String(row.format || "zip") === "zip"
    && version.length > 0
    && version.split(/[._+-]/).every((part) => VERSION_PART_RE.test(part));
}

export function newestLegalPack(rows = []) {
  return rows.filter((row) => row?.enabled && isValidLegalPackArtifact(row)).reduce((best, row) => {
    if (!best) return row;
    const order = compareLegalPackVersions(row.version, best.version);
    if (order > 0) return row;
    if (order === 0 && new Date(row.created_at || 0).getTime() > new Date(best.created_at || 0).getTime()) return row;
    return best;
  }, null);
}

export function legalPackArtifactForViewer(rows = [], { characterId, viewerPlan } = {}) {
  if (String(characterId || "") !== LEGAL_KB_CHARACTER_ID) {
    return { ok: false, code: "LEGAL_KB_NOT_FOUND" };
  }
  const pack = newestLegalPack(rows);
  if (!pack) return { ok: false, code: "LEGAL_KB_NOT_FOUND" };
  if (!planAllows(viewerPlan, pack.min_plan || "free")) {
    return { ok: false, code: "NOT_ENTITLED", requiredPlan: String(pack.min_plan || "free") };
  }
  return {
    ok: true,
    artifact: {
      packId: pack.pack_id,
      characterId: pack.character_id,
      version: pack.version,
      url: pack.url,
      sha256: String(pack.sha256).toLowerCase(),
      sizeBytes: Number(pack.size_bytes),
      format: pack.format || "zip",
      schemaVersion: Number(pack.schema_version || 1),
    },
  };
}
