import { z } from "zod";
import { config } from "../../config.js";
import { db } from "../../db.js";
import { zodBody, okResponse } from "../../openapi.js";
import { buildClientBootstrapPolicy } from "../../services/client-bootstrap.js";
import {
  DEFAULT_EFFECTIVE_CONFIG,
  clearConfigProfileDeleted,
  configProfileWasDeleted,
  deepMerge,
  decideConfigProfileUpsert,
  expandModelProviderMenu,
  isGatewayBaseUrl,
  parseGatewayProvider,
  recordConfigProfileDeleted,
  recordEnvManagedConfigProfileDeleted,
  rolloutAllows,
  withGatewayRuntimeConfig,
} from "../../services/client-config.js";
import { getMediaDeliveryMode, getModelDeliveryMode } from "../../services/app-settings.js";
import { resolveConfigProfileTarget, targetErrorResponse } from "../../services/config-profile-target.js";
import {
  finalizeAdminPreviewEffectiveConfig,
  invalidConfigProfile,
  summarizeEffectiveConfig,
  validateConfigProfileConfig,
} from "../../services/config-profile-validation.js";
export { finalizeAdminPreviewEffectiveConfig, validateConfigProfileConfig };

const configProfileSchema = z.object({
  id: z.string().min(2).max(80),
  name: z.string().min(1).max(160),
  scope: z.enum(["global", "group", "license", "device", "user", "organization"]).default("global"),
  targetId: z.string().max(160).optional().nullable(),
  priority: z.number().int().min(-100000).max(100000).default(0),
  rolloutPercent: z.number().int().min(0).max(100).default(100),
  enabled: z.boolean().default(true),
  config: z.record(z.any()).default({}),
});

const updateConfigProfileSchema = z.object({
  name: z.string().min(1).max(160).optional(),
  scope: z.enum(["global", "group", "license", "device", "user", "organization"]).optional(),
  targetId: z.string().max(160).optional().nullable(),
  priority: z.number().int().min(-100000).max(100000).optional(),
  rolloutPercent: z.number().int().min(0).max(100).optional(),
  enabled: z.boolean().optional(),
  config: z.record(z.any()).optional(),
});

const effectivePreviewSchema = z.object({
  deviceId: z.string().max(160).optional().default(""),
  licenseId: z.string().max(160).optional().default(""),
  groupId: z.string().max(160).optional().default(""),
});

async function resolveEffectivePreview(input, request) {
  const profiles = await db
    .selectFrom("config_profiles")
    .selectAll()
    .where("enabled", "=", true)
    .orderBy("priority", "asc")
    .orderBy("updated_at", "asc")
    .execute();

  const matching = profiles.filter((profile) => {
    if (input.deviceId && !rolloutAllows(profile, input.deviceId)) return false;
    if (profile.scope === "global") return !profile.target_id;
    if (profile.scope === "group") return input.groupId && profile.target_id === input.groupId;
    if (profile.scope === "license") return input.licenseId && profile.target_id === input.licenseId;
    if (profile.scope === "device") return input.deviceId && profile.target_id === input.deviceId;
    return false;
  });
  const mergedConfig = matching.reduce(
    (acc, profile) => deepMerge(acc, profile.config),
    DEFAULT_EFFECTIVE_CONFIG,
  );
  const effectiveConfig = await finalizeAdminPreviewEffectiveConfig({
    effectiveConfig: mergedConfig,
    input,
    request,
  });
  return {
    target: {
      deviceId: input.deviceId || "",
      licenseId: input.licenseId || "",
      groupId: input.groupId || "",
    },
    appliedProfiles: matching.map((profile) => ({
      id: profile.id,
      name: profile.name,
      scope: profile.scope,
      targetId: profile.target_id || "",
      priority: profile.priority,
      rolloutPercent: profile.rollout_percent,
    })),
    effectiveConfig,
    summary: summarizeEffectiveConfig(effectiveConfig),
  };
}

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
  app.get(
    "/api/admin/config-profiles",
    {
      schema: {
        tags: ["admin:config-profiles"],
        summary: "List config profiles",
        description: "Lists config profiles ordered by scope, priority and last update.",
        response: { 200: okResponse({ profiles: { type: "array", items: { type: "object" } } }) },
      },
    },
    async () => ({
    profiles: await db
      .selectFrom("config_profiles")
      .selectAll()
      .orderBy("scope", "asc")
      .orderBy("priority", "desc")
      .orderBy("updated_at", "desc")
      .limit(300)
      .execute(),
  }));

  app.get(
    "/api/admin/config-profiles/effective-preview",
    {
      schema: {
        tags: ["admin:config-profiles"],
        summary: "Preview the effective config for a target",
        description:
          "Resolves and merges matching profiles for a device/license/group and summarizes the result.",
        querystring: zodBody(effectivePreviewSchema),
      },
    },
    async (request) => {
      const input = effectivePreviewSchema.parse(request.query || {});
      return resolveEffectivePreview(input, request);
    });

  app.post(
    "/api/admin/config-profiles",
    {
      schema: {
        tags: ["admin:config-profiles"],
        summary: "Create or update a config profile",
        description: "Upserts a config profile and records a revision for rollback.",
        body: zodBody(configProfileSchema),
        response: { 201: okResponse({ id: { type: "string" } }) },
      },
    },
    async (request, reply) => {
    const input = configProfileSchema.parse(request.body);
    const configError = validateConfigProfileConfig(input.config || {});
    if (configError) return reply.code(400).send(configError);
    const existing = await db
      .selectFrom("config_profiles")
      .select("id")
      .where("id", "=", input.id)
      .executeTakeFirst();
    const upsertDecision = decideConfigProfileUpsert({
      profileExists: Boolean(existing),
      deleted: await configProfileWasDeleted(input.id),
    });
    if (!upsertDecision.ok) {
      return reply.code(409).send({
        ok: false,
        code: upsertDecision.code,
        message: "This config profile was deleted. Create a new rule with a new ID instead.",
      });
    }
    // A scoped rule that points at nothing saves, lists, and never fires; the
    // license case even looks right because the operator typed the key they own.
    const resolvedTarget = await resolveConfigProfileTarget({ scope: input.scope, targetId: input.targetId });
    if (!resolvedTarget.ok) return reply.code(400).send(targetErrorResponse(resolvedTarget));
    await db
      .insertInto("config_profiles")
      .values({
        id: input.id,
        name: input.name,
        scope: input.scope,
        target_id: resolvedTarget.targetId,
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
          target_id: resolvedTarget.targetId,
          priority: input.priority,
          rollout_percent: input.rolloutPercent,
          enabled: input.enabled,
          config: JSON.stringify(input.config || {}),
          updated_at: new Date(),
        }),
      )
      .execute();
    await clearConfigProfileDeleted(input.id);
    await audit(request, "config_profile.upsert", "config_profile", input.id, {
      scope: input.scope,
      targetId: resolvedTarget.targetId,
      targetResolvedFrom: resolvedTarget.resolvedFrom,
      priority: input.priority,
      rolloutPercent: input.rolloutPercent,
      enabled: input.enabled,
    });
    await saveConfigProfileRevision(input.id);
    return reply.code(201).send({ ok: true, id: input.id });
  });

  app.patch(
    "/api/admin/config-profiles/:id",
    {
      schema: {
        tags: ["admin:config-profiles"],
        summary: "Update a config profile",
        description: "Applies partial updates to a config profile and records a revision.",
        body: zodBody(updateConfigProfileSchema),
        response: { 200: okResponse({ id: { type: "string" } }) },
      },
    },
    async (request, reply) => {
    const input = updateConfigProfileSchema.parse(request.body);
    const existing = await db
      .selectFrom("config_profiles")
      .selectAll()
      .where("id", "=", request.params.id)
      .executeTakeFirst();
    if (!existing) return reply.code(404).send({ ok: false, code: "CONFIG_PROFILE_NOT_FOUND" });
    if (input.config !== undefined) {
      const configError = validateConfigProfileConfig(input.config || {});
      if (configError) return reply.code(400).send(configError);
    }
    const scope = input.scope || existing.scope;
    // Re-resolve whenever either half of (scope, target) moves: a scope change
    // alone can leave a target that no longer refers to anything.
    let resolvedTarget = null;
    if (input.targetId !== undefined || input.scope !== undefined) {
      const targetId = input.targetId !== undefined ? input.targetId : existing.target_id;
      resolvedTarget = await resolveConfigProfileTarget({ scope, targetId });
      if (!resolvedTarget.ok) return reply.code(400).send(targetErrorResponse(resolvedTarget));
    }
    const updates = {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.scope !== undefined ? { scope: input.scope } : {}),
      ...(resolvedTarget ? { target_id: resolvedTarget.targetId } : {}),
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

  app.delete(
    "/api/admin/config-profiles/:id",
    {
      schema: {
        tags: ["admin:config-profiles"],
        summary: "Delete a config profile",
        description: "Deletes a config profile. Stored revisions are removed by the database cascade.",
        response: { 200: okResponse({ id: { type: "string" } }) },
      },
    },
    async (request, reply) => {
    const existing = await db
      .selectFrom("config_profiles")
      .select(["id", "scope", "target_id", "priority", "enabled"])
      .where("id", "=", request.params.id)
      .executeTakeFirst();
    if (!existing) return reply.code(404).send({ ok: false, code: "CONFIG_PROFILE_NOT_FOUND" });
    await db.deleteFrom("config_profiles").where("id", "=", request.params.id).execute();
    await recordConfigProfileDeleted(request.params.id);
    const recordedDefaultDeletion = await recordEnvManagedConfigProfileDeleted(request.params.id);
    await audit(request, "config_profile.delete", "config_profile", request.params.id, {
      scope: existing.scope,
      targetId: existing.target_id || null,
      priority: existing.priority,
      enabled: existing.enabled,
      defaultSeedSuppressed: recordedDefaultDeletion,
    });
    return { ok: true, id: request.params.id };
  });

  app.post(
    "/api/admin/config-profiles/:id/rollback",
    {
      schema: {
        tags: ["admin:config-profiles"],
        summary: "Roll back a config profile to its previous revision",
        description: "Restores the config profile to the revision before the current one.",
        response: { 200: okResponse({ id: { type: "string" }, revisionId: { type: "integer" } }) },
      },
    },
    async (request, reply) => {
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
