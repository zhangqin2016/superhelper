import { z } from "zod";
import { db } from "../../db.js";
import { publicId } from "../../services/ids.js";
import { zodBody, okResponse } from "../../openapi.js";

const createPackSchema = z.object({
  packId: z.string().min(1).max(60),
  platform: z.string().min(1).max(40),
  url: z.string().url(),
  sha256: z.string().min(16).max(160),
  version: z.string().min(1).max(40),
  sizeBytes: z.number().int().min(0).optional().nullable(),
  enabled: z.boolean().default(true),
});

const updateEnabledSchema = z.object({
  enabled: z.boolean(),
});

export function decideRuntimePackUpsert(existingPack) {
  return existingPack?.id ? { action: "update", id: existingPack.id } : { action: "create", id: null };
}

export function registerAdminRuntimePackRoutes(app, { audit }) {
  app.get(
    "/api/admin/runtime-packs",
    {
      schema: {
        tags: ["admin:runtime-packs"],
        summary: "List runtime packs",
        description: "Returns the most recent runtime packs ordered by creation time.",
        response: { 200: okResponse({ runtimePacks: { type: "array" } }) },
      },
    },
    async () => ({
      runtimePacks: await db
        .selectFrom("runtime_packs")
        .selectAll()
        .orderBy("created_at", "desc")
        .limit(200)
        .execute(),
    }),
  );

  app.post(
    "/api/admin/runtime-packs",
    {
      schema: {
        tags: ["admin:runtime-packs"],
        summary: "Create or update a runtime pack",
        description: "Upserts a runtime-pack artifact record for a pack/platform/version.",
        body: zodBody(createPackSchema),
        response: { 201: okResponse({ id: { type: "string" } }) },
      },
    },
    async (request, reply) => {
      const input = createPackSchema.parse(request.body);
      const values = {
        pack_id: input.packId,
        platform: input.platform,
        url: input.url,
        sha256: input.sha256,
        version: input.version,
        size_bytes: input.sizeBytes || null,
        enabled: input.enabled,
      };
      const existing = await db
        .selectFrom("runtime_packs")
        .select(["id"])
        .where("pack_id", "=", input.packId)
        .where("platform", "=", input.platform)
        .where("version", "=", input.version)
        .executeTakeFirst();
      const decision = decideRuntimePackUpsert(existing);
      const id = decision.id || publicId("rpack");
      if (decision.action === "update") {
        await db.updateTable("runtime_packs").set(values).where("id", "=", id).execute();
      } else {
        await db.insertInto("runtime_packs").values({ id, ...values }).execute();
      }
      await audit(request, decision.action === "update" ? "runtime_pack.update" : "runtime_pack.create", "runtime_pack", id, {
        packId: input.packId,
        platform: input.platform,
        version: input.version,
      });
      return reply.code(decision.action === "update" ? 200 : 201).send({ ok: true, id });
    },
  );

  app.patch(
    "/api/admin/runtime-packs/:id",
    {
      schema: {
        tags: ["admin:runtime-packs"],
        summary: "Enable or disable a runtime pack",
        description: "Toggles the enabled flag on an existing runtime pack.",
        body: zodBody(updateEnabledSchema),
        response: { 200: okResponse({ id: { type: "string" } }) },
      },
    },
    async (request) => {
      const input = updateEnabledSchema.parse(request.body);
      await db
        .updateTable("runtime_packs")
        .set({ enabled: input.enabled })
        .where("id", "=", request.params.id)
        .execute();
      await audit(request, "runtime_pack.update", "runtime_pack", request.params.id, {
        enabled: input.enabled,
      });
      return { ok: true, id: request.params.id };
    },
  );
}
