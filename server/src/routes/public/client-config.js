import { z } from "zod";
import { config } from "../../config.js";
import { db } from "../../db.js";
import { signConfigPayload } from "../../services/security.js";
import {
  buildClientBootstrapPolicy,
} from "../../services/client-bootstrap.js";
import {
  DEFAULT_EFFECTIVE_CONFIG,
  clientConfigTtlMs,
  deepMerge,
  expandModelProviderMenu,
  resolveAccountContextForClientConfig,
  rolloutAllows,
  withGatewayRuntimeConfig,
} from "../../services/client-config.js";
import { discoverLilyMediaProviderContracts } from "../../services/media-provider-contracts.js";
import {
  requireSignedDeviceRequest,
  trialPayload,
  upsertDevice,
  validLicenseScope,
} from "../../services/device-identity.js";
import { registerDeviceSchema } from "./devices.js";
import { zodBody, okResponse } from "../../openapi.js";

const clientConfigSchema = registerDeviceSchema.extend({
  licenseId: z.string().max(80).optional().nullable(),
  accountAccessToken: z.string().max(4096).optional().nullable(),
  publicKey: registerDeviceSchema.shape.publicKey,
  keyAlg: registerDeviceSchema.shape.keyAlg,
});

/**
 * The group a device belongs to for config delivery: its own group_id wins,
 * else it inherits the group of its license (the customer/tier group). Null when
 * neither is set.
 */
async function resolveDeviceGroupId(deviceId, licenseId) {
  if (deviceId) {
    const device = await db
      .selectFrom("devices")
      .select("group_id")
      .where("id", "=", deviceId)
      .executeTakeFirst();
    if (device?.group_id) return device.group_id;
  }
  if (licenseId) {
    const license = await db
      .selectFrom("licenses")
      .select("group_id")
      .where("id", "=", licenseId)
      .executeTakeFirst();
    if (license?.group_id) return license.group_id;
  }
  return null;
}

async function resolveEffectiveConfig(input) {
  const licenseId = await validLicenseScope(input);
  const groupId = await resolveDeviceGroupId(input.deviceId, licenseId);
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
    if (profile.scope === "group") return groupId && profile.target_id === groupId;
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
  app.get("/api/client/bootstrap", {
    schema: {
      tags: ["public:client-config"],
      summary: "Resolve the runtime region and gateway policy for a client",
      response: {
        200: okResponse({
          schemaVersion: { type: "number" },
          configVersion: { type: "string" },
          region: { type: "string" },
          gatewayBaseUrl: { type: "string" },
          apiBaseUrl: { type: "string" },
          modelGatewayBaseUrl: { type: "string" },
          features: { type: "object", additionalProperties: true },
          routing: { type: "object", additionalProperties: true },
          ttlSeconds: { type: "number" },
          expiresAt: { type: "string" },
        }),
      },
    },
  }, async (request, reply) => reply.send(buildClientBootstrapPolicy(request)));

  app.post("/api/client/config", {
    schema: {
      tags: ["public:client-config"],
      summary: "Resolve a device's effective client configuration",
      description:
        "Upserts the device, verifies the signed request, and returns the signed effective config and trial status.",
      body: zodBody(clientConfigSchema),
      response: {
        200: okResponse({
          schemaVersion: { type: "number" },
          configVersion: { type: "string" },
          expiresAt: { type: "string" },
          effectiveConfig: { type: "object", additionalProperties: true },
          deviceId: { type: "string" },
          trial: { type: "object", additionalProperties: true },
          appliedProfileIds: { type: "array", items: { type: "string" } },
          signature: { type: "string" },
        }),
      },
    },
  }, async (request, reply) => {
    const input = clientConfigSchema.parse(request.body);
    const device = await upsertDevice(input);
    if (!(await requireSignedDeviceRequest(request, reply, input))) return;

    const resolved = await resolveEffectiveConfig(input);
    const { getMediaDeliveryMode, getModelDeliveryMode } = await import("../../services/app-settings.js");
    const modelDeliveryMode = await getModelDeliveryMode();
    // Expand any per-scope `models.providers` directive into its preset menu
    // before tokens are injected.
    const scopedConfig = expandModelProviderMenu(resolved.effectiveConfig, {
      deliveryMode: modelDeliveryMode,
    });
    const account = await resolveAccountContextForClientConfig(input, db);
    const bootstrapPolicy = buildClientBootstrapPolicy(request);
    const mediaDeliveryMode = await getMediaDeliveryMode();
    const scopedPreview = withGatewayRuntimeConfig(scopedConfig, request, input, {
      publicBaseUrl: config.publicBaseUrl,
      policyBaseUrl: bootstrapPolicy.apiBaseUrl,
      mediaDeliveryMode,
      modelDeliveryMode,
      account,
    });
    const selectedMedia = {
      image: scopedPreview.media?.image?.default || "",
      video: scopedPreview.media?.video?.default || "",
      speech: scopedPreview.media?.speech?.default || "",
    };
    const availableMedia = {
      image: scopedPreview.media?.image?.providers || [],
      video: scopedPreview.media?.video?.providers || [],
      speech: scopedPreview.media?.speech?.providers || [],
    };
    const mediaContracts = await discoverLilyMediaProviderContracts({
      serverConfig: config,
      selected: selectedMedia,
      available: availableMedia,
    });
    const effectiveConfig = withGatewayRuntimeConfig(scopedConfig, request, input, {
      publicBaseUrl: config.publicBaseUrl,
      policyBaseUrl: bootstrapPolicy.apiBaseUrl,
      mediaDeliveryMode,
      modelDeliveryMode,
      account,
      mediaContracts,
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
