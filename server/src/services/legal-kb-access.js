import { db } from "../db.js";
import { planRank } from "./entitlements.js";
import { LEGAL_KB_CHARACTER_ID, LEGAL_KB_PACK_ID, legalPackArtifactForViewer } from "./legal-knowledge-packs.js";

// The best active plan on this device, and when the licence carrying it ends.
export async function resolveViewerEntitlement(deviceId) {
  const rows = await db.selectFrom("license_devices")
    .innerJoin("licenses", "licenses.id", "license_devices.license_id")
    .select(["licenses.plan as plan", "licenses.expires_at as expires_at"])
    .where("license_devices.device_id", "=", deviceId)
    .where("license_devices.status", "=", "active")
    .where("licenses.status", "=", "active").execute();
  const now = Date.now();
  return rows.reduce((best, row) => {
    const ends = new Date(row.expires_at).getTime();
    if (ends <= now) return best;
    const plan = String(row.plan || "free");
    if (planRank(plan) > planRank(best.plan) || (planRank(plan) === planRank(best.plan) && ends > (best.until || 0))) {
      return { plan, until: ends };
    }
    return best;
  }, { plan: "free", until: 0 });
}

export async function enabledLegalPackRows(characterId = LEGAL_KB_CHARACTER_ID) {
  return db.selectFrom("legal_knowledge_packs").selectAll()
    .where("pack_id", "=", LEGAL_KB_PACK_ID)
    .where("character_id", "=", characterId)
    .where("enabled", "=", true).orderBy("created_at", "desc").limit(100).execute();
}

/**
 * May this device read the legal corpus? The same rule that governs the pack
 * download: an enabled pack registration whose plan the device holds. So the
 * admin's switch (disable a version, raise its plan) governs the served corpus
 * too — the search endpoint used to check only the device signature.
 */
export async function legalSearchAccess(deviceId, { rows, entitlement } = {}) {
  const packRows = rows || await enabledLegalPackRows();
  const viewer = entitlement || await resolveViewerEntitlement(deviceId);
  const result = legalPackArtifactForViewer(packRows, { characterId: LEGAL_KB_CHARACTER_ID, viewerPlan: viewer.plan });
  return result.ok
    ? { ok: true, plan: viewer.plan, version: result.artifact.version }
    : { ok: false, code: result.code === "NOT_ENTITLED" ? "LEGAL_KB_NOT_ENTITLED" : "LEGAL_KB_DISABLED", ...(result.requiredPlan ? { requiredPlan: result.requiredPlan } : {}) };
}
