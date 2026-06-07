import { z } from "zod";
import { db } from "../../db.js";

const createPluginSchema = z.object({
  id: z.string().min(2).max(80),
  name: z.string().min(1).max(120),
  version: z.string().min(1).max(40),
  type: z.enum(["mcp", "skill", "tool"]),
  description: z.string().max(1000).optional().nullable(),
  manifestUrl: z.string().url(),
  sha256: z.string().max(160).optional().nullable(),
  enabled: z.boolean().default(true),
});

const updateEnabledSchema = z.object({
  enabled: z.boolean(),
});

export function registerAdminPluginRoutes(app, { audit }) {
  app.get("/api/admin/plugins", async () => ({
    plugins: await db.selectFrom("plugins").selectAll().orderBy("created_at", "desc").limit(200).execute(),
  }));

  app.post("/api/admin/plugins", async (request, reply) => {
    const input = createPluginSchema.parse(request.body);
    await db
      .insertInto("plugins")
      .values({
        id: input.id,
        name: input.name,
        version: input.version,
        type: input.type,
        description: input.description || null,
        manifest_url: input.manifestUrl,
        sha256: input.sha256 || null,
        enabled: input.enabled,
      })
      .onConflict((oc) =>
        oc.column("id").doUpdateSet({
          name: input.name,
          version: input.version,
          type: input.type,
          description: input.description || null,
          manifest_url: input.manifestUrl,
          sha256: input.sha256 || null,
          enabled: input.enabled,
          updated_at: new Date(),
        }),
      )
      .execute();
    await audit(request, "plugin.upsert", "plugin", input.id, { version: input.version, type: input.type, enabled: input.enabled });
    return reply.code(201).send({ ok: true, id: input.id });
  });

  app.patch("/api/admin/plugins/:id", async (request) => {
    const input = updateEnabledSchema.parse(request.body);
    await db
      .updateTable("plugins")
      .set({ enabled: input.enabled, updated_at: new Date() })
      .where("id", "=", request.params.id)
      .execute();
    await audit(request, "plugin.update", "plugin", request.params.id, { enabled: input.enabled });
    return { ok: true, id: request.params.id };
  });
}
