import { z } from "zod";
import { db } from "../../db.js";
import { planRank } from "../../services/entitlements.js";
import { requireSignedDeviceRequest } from "../../services/device-identity.js";
import { getQiniuConfig } from "../../services/app-settings.js";
import { qiniuPrivateDownloadUrlForUrl } from "../../services/qiniu-download.js";
import { zodBody, okResponse } from "../../openapi.js";
import {
  LEGAL_KB_CHARACTER_ID,
  LEGAL_KB_PACK_ID,
  legalPackArtifactForViewer,
} from "../../services/legal-knowledge-packs.js";

const requestSchema = z.object({
  deviceId: z.string().min(6).max(120),
  characterId: z.literal(LEGAL_KB_CHARACTER_ID),
});

// The best active plan on this device, and when the licence carrying it ends:
// the client uses that as the bound on offline use of an installed pack.
async function resolveViewerEntitlement(deviceId) {
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

export function registerPublicLegalKnowledgePackRoutes(app) {
  app.post("/api/legal-kb/artifact", {
    schema: {
      tags: ["public:legal-knowledge-packs"],
      summary: "Resolve the authorized legal knowledge pack",
      description: "Returns a Qiniu artifact only after signed-device and entitlement checks.",
      body: zodBody(requestSchema),
      response: { 200: okResponse({ entitledUntil: { type: "string", description: "When the licence carrying this entitlement ends; the client bounds offline use of an installed pack by it." }, artifact: { type: "object", additionalProperties: true } }) },
    },
  }, async (request, reply) => {
    let input;
    try { input = requestSchema.parse(request.body || {}); } catch { return reply.code(400).send({ ok: false, code: "INVALID_REQUEST" }); }
    if (!(await requireSignedDeviceRequest(request, reply, input))) return;
    const rows = await db.selectFrom("legal_knowledge_packs").selectAll()
      .where("pack_id", "=", LEGAL_KB_PACK_ID)
      .where("character_id", "=", input.characterId)
      .where("enabled", "=", true).orderBy("created_at", "desc").limit(100).execute();
    const entitlement = await resolveViewerEntitlement(input.deviceId);
    const result = legalPackArtifactForViewer(rows, {
      characterId: input.characterId,
      viewerPlan: entitlement.plan,
    });
    if (!result.ok) {
      return reply.code(result.code === "NOT_ENTITLED" ? 403 : 404).send(result);
    }
    const qiniu = await getQiniuConfig();
    return {
      ok: true,
      ...(entitlement.until ? { entitledUntil: new Date(entitlement.until).toISOString() } : {}),
      artifact: {
        ...result.artifact,
        url: qiniuPrivateDownloadUrlForUrl({ url: result.artifact.url, qiniuConfig: qiniu }),
      },
    };
  });
}
