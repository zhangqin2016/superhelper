import { z } from "zod";
import { db } from "../../db.js";
import { publicId } from "../../services/ids.js";

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

export function registerAdminRuntimePackRoutes(app, { audit }) {
  app.get("/api/admin/runtime-packs", async () => ({
    runtimePacks: await db
      .selectFrom("runtime_packs")
      .selectAll()
      .orderBy("created_at", "desc")
      .limit(200)
      .execute(),
  }));

  app.post("/api/admin/runtime-packs", async (request, reply) => {
    const input = createPackSchema.parse(request.body);
    const id = publicId("rpack");
    await db
      .insertInto("runtime_packs")
      .values({
        id,
        pack_id: input.packId,
        platform: input.platform,
        url: input.url,
        sha256: input.sha256,
        version: input.version,
        size_bytes: input.sizeBytes || null,
        enabled: input.enabled,
      })
      .execute();
    await audit(request, "runtime_pack.create", "runtime_pack", id, {
      packId: input.packId,
      platform: input.platform,
      version: input.version,
    });
    return reply.code(201).send({ ok: true, id });
  });

  app.patch("/api/admin/runtime-packs/:id", async (request) => {
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
  });
}
