import { z } from "zod";
import { db } from "../../db.js";

const configProfileSchema = z.object({
  id: z.string().min(2).max(80),
  name: z.string().min(1).max(160),
  scope: z.enum(["global", "license", "device"]).default("global"),
  targetId: z.string().max(160).optional().nullable(),
  priority: z.number().int().min(-100000).max(100000).default(0),
  rolloutPercent: z.number().int().min(0).max(100).default(100),
  enabled: z.boolean().default(true),
  config: z.record(z.any()).default({}),
});

const updateConfigProfileSchema = z.object({
  name: z.string().min(1).max(160).optional(),
  scope: z.enum(["global", "license", "device"]).optional(),
  targetId: z.string().max(160).optional().nullable(),
  priority: z.number().int().min(-100000).max(100000).optional(),
  rolloutPercent: z.number().int().min(0).max(100).optional(),
  enabled: z.boolean().optional(),
  config: z.record(z.any()).optional(),
});

async function saveConfigProfileRevision(profileId) {
  const profile = await db
    .selectFrom("config_profiles")
    .selectAll()
    .where("id", "=", profileId)
    .executeTakeFirst();
  if (!profile) return;
  await db
    .insertInto("config_profile_revisions")
    .values({
      profile_id: profile.id,
      name: profile.name,
      scope: profile.scope,
      target_id: profile.target_id || null,
      priority: profile.priority,
      rollout_percent: profile.rollout_percent ?? 100,
      enabled: profile.enabled,
      config: JSON.stringify(profile.config || {}),
    })
    .execute();
}

export function registerAdminConfigProfileRoutes(app, { audit }) {
  app.get("/api/admin/config-profiles", async () => ({
    profiles: await db
      .selectFrom("config_profiles")
      .selectAll()
      .orderBy("scope", "asc")
      .orderBy("priority", "desc")
      .orderBy("updated_at", "desc")
      .limit(300)
      .execute(),
  }));

  app.post("/api/admin/config-profiles", async (request, reply) => {
    const input = configProfileSchema.parse(request.body);
    await db
      .insertInto("config_profiles")
      .values({
        id: input.id,
        name: input.name,
        scope: input.scope,
        target_id: input.scope === "global" ? null : input.targetId || null,
        priority: input.priority,
        rollout_percent: input.rolloutPercent,
        enabled: input.enabled,
        config: JSON.stringify(input.config || {}),
        updated_at: new Date(),
      })
      .onConflict((oc) =>
        oc.column("id").doUpdateSet({
          name: input.name,
          scope: input.scope,
          target_id: input.scope === "global" ? null : input.targetId || null,
          priority: input.priority,
          rollout_percent: input.rolloutPercent,
          enabled: input.enabled,
          config: JSON.stringify(input.config || {}),
          updated_at: new Date(),
        }),
      )
      .execute();
    await audit(request, "config_profile.upsert", "config_profile", input.id, {
      scope: input.scope,
      targetId: input.targetId || null,
      priority: input.priority,
      rolloutPercent: input.rolloutPercent,
      enabled: input.enabled,
    });
    await saveConfigProfileRevision(input.id);
    return reply.code(201).send({ ok: true, id: input.id });
  });

  app.patch("/api/admin/config-profiles/:id", async (request, reply) => {
    const input = updateConfigProfileSchema.parse(request.body);
    const existing = await db
      .selectFrom("config_profiles")
      .selectAll()
      .where("id", "=", request.params.id)
      .executeTakeFirst();
    if (!existing) return reply.code(404).send({ ok: false, code: "CONFIG_PROFILE_NOT_FOUND" });
    const scope = input.scope || existing.scope;
    const updates = {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.scope !== undefined ? { scope: input.scope } : {}),
      ...(input.targetId !== undefined ? { target_id: scope === "global" ? null : input.targetId || null } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.rolloutPercent !== undefined ? { rollout_percent: input.rolloutPercent } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.config !== undefined ? { config: JSON.stringify(input.config || {}) } : {}),
      updated_at: new Date(),
    };
    await db.updateTable("config_profiles").set(updates).where("id", "=", request.params.id).execute();
    await audit(request, "config_profile.update", "config_profile", request.params.id, updates);
    await saveConfigProfileRevision(request.params.id);
    return { ok: true, id: request.params.id };
  });

  app.post("/api/admin/config-profiles/:id/rollback", async (request, reply) => {
    const revisions = await db
      .selectFrom("config_profile_revisions")
      .selectAll()
      .where("profile_id", "=", request.params.id)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(2)
      .execute();
    const previous = revisions[1];
    if (!previous) return reply.code(404).send({ ok: false, code: "CONFIG_PROFILE_PREVIOUS_REVISION_NOT_FOUND" });
    await db
      .updateTable("config_profiles")
      .set({
        name: previous.name,
        scope: previous.scope,
        target_id: previous.target_id || null,
        priority: previous.priority,
        rollout_percent: previous.rollout_percent,
        enabled: previous.enabled,
        config: JSON.stringify(previous.config || {}),
        updated_at: new Date(),
      })
      .where("id", "=", request.params.id)
      .execute();
    await audit(request, "config_profile.rollback", "config_profile", request.params.id, { revisionId: previous.id });
    await saveConfigProfileRevision(request.params.id);
    return { ok: true, id: request.params.id, revisionId: previous.id };
  });
}
