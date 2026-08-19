import { z } from "zod";
import { db } from "../../db.js";
import { publicId } from "../../services/ids.js";
import { zodBody, okResponse } from "../../openapi.js";
import { LEGAL_KB_CHARACTER_ID, LEGAL_KB_PACK_ID } from "../../services/legal-knowledge-packs.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i);
const createSchema = z.object({
  packId: z.literal(LEGAL_KB_PACK_ID),
  characterId: z.literal(LEGAL_KB_CHARACTER_ID),
  version: z.string().min(1).max(64),
  url: z.string().url().refine((value) => value.startsWith("https://"), "Qiniu artifact must use HTTPS"),
  sha256: sha256Schema,
  sizeBytes: z.number().int().positive(),
  format: z.literal("zip").default("zip"),
  schemaVersion: z.number().int().min(1).max(1).default(1),
  minPlan: z.enum(["free", "pro", "vip", "enterprise"]).default("free"),
  enabled: z.boolean().default(true),
});
const enabledSchema = z.object({ enabled: z.boolean() });

export function registerAdminLegalKnowledgePackRoutes(app, { audit }) {
  app.get("/api/admin/legal-knowledge-packs", {
    schema: {
      tags: ["admin:legal-knowledge-packs"],
      summary: "List legal knowledge pack releases",
      response: { 200: okResponse({ legalKnowledgePacks: { type: "array" } }) },
    },
  }, async () => ({
    legalKnowledgePacks: await db.selectFrom("legal_knowledge_packs")
      .selectAll().orderBy("created_at", "desc").limit(200).execute(),
  }));

  app.post("/api/admin/legal-knowledge-packs", {
    schema: {
      tags: ["admin:legal-knowledge-packs"],
      summary: "Register a Qiniu legal knowledge pack",
      body: zodBody(createSchema),
      response: { 200: okResponse({ id: { type: "string" } }), 201: okResponse({ id: { type: "string" } }) },
    },
  }, async (request, reply) => {
    const input = createSchema.parse(request.body);
    const values = {
      pack_id: input.packId,
      character_id: input.characterId,
      version: input.version,
      url: input.url,
      sha256: input.sha256.toLowerCase(),
      size_bytes: input.sizeBytes,
      format: input.format,
      schema_version: input.schemaVersion,
      min_plan: input.minPlan,
      enabled: input.enabled,
    };
    const existing = await db.selectFrom("legal_knowledge_packs").select(["id"])
      .where("pack_id", "=", input.packId).where("character_id", "=", input.characterId)
      .where("version", "=", input.version).executeTakeFirst();
    const id = existing?.id || publicId("legalkb");
    if (existing) await db.updateTable("legal_knowledge_packs").set(values).where("id", "=", id).execute();
    else await db.insertInto("legal_knowledge_packs").values({ id, ...values }).execute();
    await audit(request, existing ? "legal_kb.update" : "legal_kb.create", "legal_knowledge_pack", id, {
      packId: input.packId, characterId: input.characterId, version: input.version,
    });
    return reply.code(existing ? 200 : 201).send({ ok: true, id });
  });

  app.patch("/api/admin/legal-knowledge-packs/:id", {
    schema: {
      tags: ["admin:legal-knowledge-packs"],
      summary: "Enable or disable a legal knowledge pack",
      body: zodBody(enabledSchema),
      response: { 200: okResponse({ id: { type: "string" } }) },
    },
  }, async (request) => {
    const input = enabledSchema.parse(request.body);
    await db.updateTable("legal_knowledge_packs").set({ enabled: input.enabled })
      .where("id", "=", request.params.id).execute();
    await audit(request, "legal_kb.update", "legal_knowledge_pack", request.params.id, { enabled: input.enabled });
    return { ok: true, id: request.params.id };
  });
}
