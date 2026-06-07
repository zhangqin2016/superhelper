import { z } from "zod";
import { db } from "../../db.js";
import { publicId } from "../../services/ids.js";
import { hashLicenseKey, signLicensePayload } from "../../services/security.js";
import {
  requireSignedDeviceRequest,
  trialPayload,
  upsertDevice,
  upsertDevicePublicKey,
} from "../../services/device-identity.js";
import { registerDeviceSchema } from "./devices.js";

const activateSchema = registerDeviceSchema.extend({
  licenseKey: z.string().min(8).max(120),
});

const verifySchema = registerDeviceSchema.extend({
  licenseId: z.string().min(3).max(80),
});

export function registerPublicLicenseRoutes(app) {
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
    const input = verifySchema.parse(request.body);
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
