import { z } from "zod";
import { config } from "../../config.js";
import { db } from "../../db.js";
import { signConfigPayload } from "../../services/security.js";
import {
  DEFAULT_EFFECTIVE_CONFIG,
  clientConfigTtlMs,
  deepMerge,
  rolloutAllows,
  withGatewayRuntimeConfig,
} from "../../services/client-config.js";
import {
  requireSignedDeviceRequest,
  trialPayload,
  upsertDevice,
  validLicenseScope,
} from "../../services/device-identity.js";
import { registerDeviceSchema } from "./devices.js";

const clientConfigSchema = registerDeviceSchema.extend({
  licenseId: z.string().max(80).optional().nullable(),
  publicKey: registerDeviceSchema.shape.publicKey,
  keyAlg: registerDeviceSchema.shape.keyAlg,
});

async function resolveEffectiveConfig(input) {
  const licenseId = await validLicenseScope(input);
  const profiles = await db
    .selectFrom("config_profiles")
    .selectAll()
    .where("enabled", "=", true)
    .orderBy("priority", "asc")
    .orderBy("updated_at", "asc")
    .execute();

  const matching = profiles.filter((profile) => {
    if (!rolloutAllows(profile, input.deviceId)) return false;
    if (profile.scope === "global") return !profile.target_id;
    if (profile.scope === "license") return licenseId && profile.target_id === licenseId;
    if (profile.scope === "device") return profile.target_id === input.deviceId;
    return false;
  });

  const effectiveConfig = matching.reduce(
    (acc, profile) => deepMerge(acc, profile.config),
    DEFAULT_EFFECTIVE_CONFIG,
  );
  const latest = matching
    .map((profile) => new Date(profile.updated_at).getTime())
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => b - a)[0];

  return {
    effectiveConfig,
    configVersion: latest ? new Date(latest).toISOString() : "packaged",
    appliedProfileIds: matching.map((profile) => profile.id),
  };
}

export function registerPublicClientConfigRoutes(app) {
  app.post("/api/client/config", async (request, reply) => {
    const input = clientConfigSchema.parse(request.body);
    const device = await upsertDevice(input);
    if (!(await requireSignedDeviceRequest(request, reply, input))) return;

    const resolved = await resolveEffectiveConfig(input);
    const effectiveConfig = withGatewayRuntimeConfig(resolved.effectiveConfig, request, input, {
      publicBaseUrl: config.publicBaseUrl,
    });
    const payload = {
      schemaVersion: 1,
      configVersion: resolved.configVersion,
      expiresAt: new Date(Date.now() + clientConfigTtlMs(config)).toISOString(),
      effectiveConfig,
    };

    return reply.send({
      ok: true,
      ...payload,
      deviceId: input.deviceId,
      trial: trialPayload(device),
      appliedProfileIds: resolved.appliedProfileIds,
      signature: signConfigPayload(payload),
    });
  });
}
