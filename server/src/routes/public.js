import { z } from "zod";
import { config } from "../config.js";
import { db } from "../db.js";
import { publicId } from "../services/ids.js";
import {
  hashLicenseKey,
  signConfigPayload,
  signLicensePayload,
} from "../services/security.js";
import {
  DEFAULT_EFFECTIVE_CONFIG,
  deepMerge,
  rolloutAllows,
  withGatewayRuntimeConfig,
} from "../services/client-config.js";
import {
  requireSignedDeviceRequest,
  setDevicePublicKey,
  trialPayload,
  upsertDevice,
  upsertDevicePublicKey,
  validLicenseScope,
} from "../services/device-identity.js";
import { publicCatalogRoutes } from "./public/catalog.js";
import { registerPublicTelemetryRoutes } from "./public/telemetry.js";

const registerDeviceSchema = z.object({
  deviceId: z.string().min(6).max(120),
  fingerprintHash: z.string().max(160).optional().nullable(),
  platform: z.string().max(40).optional().nullable(),
  arch: z.string().max(40).optional().nullable(),
  appVersion: z.string().max(40).optional().nullable(),
  publicKey: z.string().max(2000).optional().nullable(),
  keyAlg: z.string().max(40).optional().nullable(),
});

const activateSchema = registerDeviceSchema.extend({
  licenseKey: z.string().min(8).max(120),
});

const clientConfigSchema = registerDeviceSchema.extend({
  licenseId: z.string().max(80).optional().nullable(),
  publicKey: z.string().max(2000).optional().nullable(),
  keyAlg: z.string().max(40).optional().nullable(),
});

const rotateDeviceKeySchema = registerDeviceSchema.extend({
  newPublicKey: z.string().min(80).max(2000),
  newKeyAlg: z.string().max(40).optional().nullable(),
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

export async function publicRoutes(app) {
  app.get("/health", async () => ({ ok: true }));
  await app.register(publicCatalogRoutes);
  registerPublicTelemetryRoutes(app);

  app.post("/api/devices/register", async (request, reply) => {
    const input = registerDeviceSchema.parse(request.body);
    const device = await upsertDevice(input);
    await upsertDevicePublicKey(input);
    return reply.send({ ok: true, trial: trialPayload(device) });
  });

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
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
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

  app.post("/api/devices/rotate-key", async (request, reply) => {
    const input = rotateDeviceKeySchema.parse(request.body);
    await upsertDevice(input);
    if (!(await requireSignedDeviceRequest(request, reply, input))) return;
    await setDevicePublicKey(input.deviceId, input.newPublicKey, input.newKeyAlg || "ed25519");
    return reply.send({ ok: true, deviceId: input.deviceId, keyAlg: input.newKeyAlg || "ed25519" });
  });

  app.post("/api/licenses/activate", async (request, reply) => {
    const input = activateSchema.parse(request.body);
    await upsertDevice(input);
    await upsertDevicePublicKey(input);

    const license = await db
      .selectFrom("licenses")
      .selectAll()
      .where("license_key_hash", "=", hashLicenseKey(input.licenseKey))
      .executeTakeFirst();

    if (!license) return reply.code(404).send({ ok: false, code: "LICENSE_NOT_FOUND" });
    if (license.status !== "active") return reply.code(403).send({ ok: false, code: "LICENSE_DISABLED" });
    if (new Date(license.expires_at).getTime() <= Date.now()) {
      return reply.code(403).send({ ok: false, code: "LICENSE_EXPIRED" });
    }

    const existingBinding = await db
      .selectFrom("license_devices")
      .selectAll()
      .where("license_id", "=", license.id)
      .where("device_id", "=", input.deviceId)
      .executeTakeFirst();

    if (existingBinding?.status === "disabled") {
      return reply.code(403).send({ ok: false, code: "DEVICE_DISABLED" });
    }

    if (!existingBinding) {
      const count = await db
        .selectFrom("license_devices")
        .select((eb) => eb.fn.count("id").as("count"))
        .where("license_id", "=", license.id)
        .where("status", "=", "active")
        .executeTakeFirst();
      if (Number(count?.count || 0) >= license.seats) {
        return reply.code(403).send({ ok: false, code: "SEAT_LIMIT_REACHED" });
      }
      await db
        .insertInto("license_devices")
        .values({
          id: publicId("ldev"),
          license_id: license.id,
          device_id: input.deviceId,
        })
        .execute();
    } else {
      await db
        .updateTable("license_devices")
        .set({ last_seen_at: new Date() })
        .where("id", "=", existingBinding.id)
        .execute();
    }

    const payload = {
      licenseId: license.id,
      deviceId: input.deviceId,
      plan: license.plan,
      features: license.features || [],
      expiresAt: new Date(license.expires_at).toISOString(),
    };

    return reply.send({
      ok: true,
      license: {
        ...payload,
        signature: signLicensePayload(payload),
      },
    });
  });

  app.post("/api/licenses/verify", async (request, reply) => {
    const input = z.object({
      deviceId: z.string().min(6).max(120),
      licenseId: z.string().min(3).max(80),
      fingerprintHash: z.string().max(160).optional().nullable(),
      platform: z.string().max(40).optional().nullable(),
      arch: z.string().max(40).optional().nullable(),
      appVersion: z.string().max(40).optional().nullable(),
      publicKey: z.string().max(2000).optional().nullable(),
      keyAlg: z.string().max(40).optional().nullable(),
    }).parse(request.body);
    const device = await upsertDevice(input);
    if (!(await requireSignedDeviceRequest(request, reply, input))) return;
    await upsertDevicePublicKey(input);

    const license = await db
      .selectFrom("licenses")
      .selectAll()
      .where("id", "=", input.licenseId)
      .executeTakeFirst();
    if (!license) return reply.code(404).send({ ok: false, code: "LICENSE_NOT_FOUND" });
    if (license.status !== "active") return reply.code(403).send({ ok: false, code: "LICENSE_DISABLED" });
    if (new Date(license.expires_at).getTime() <= Date.now()) {
      return reply.code(403).send({ ok: false, code: "LICENSE_EXPIRED" });
    }

    const binding = await db
      .selectFrom("license_devices")
      .selectAll()
      .where("license_id", "=", input.licenseId)
      .where("device_id", "=", input.deviceId)
      .executeTakeFirst();
    if (!binding) return reply.code(403).send({ ok: false, code: "DEVICE_NOT_ACTIVATED" });
    if (binding.status !== "active") return reply.code(403).send({ ok: false, code: "DEVICE_DISABLED" });

    await db
      .updateTable("license_devices")
      .set({ last_seen_at: new Date() })
      .where("id", "=", binding.id)
      .execute();

    return reply.send({
      ok: true,
      trial: trialPayload(device),
      license: {
        licenseId: license.id,
        deviceId: input.deviceId,
        customer: license.customer_name || license.id,
        plan: license.plan,
        features: license.features || [],
        expiresAt: new Date(license.expires_at).toISOString(),
      },
    });
  });

}
