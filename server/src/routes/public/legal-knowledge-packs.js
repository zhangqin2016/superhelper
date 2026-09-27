import { z } from "zod";
import { db } from "../../db.js";
import { resolveViewerEntitlement } from "../../services/legal-kb-access.js";
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
