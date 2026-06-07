import { z } from "zod";
import { db } from "../../db.js";
import { licenseKey, publicId } from "../../services/ids.js";
import { hashLicenseKey } from "../../services/security.js";

const createLicenseSchema = z.object({
  customerName: z.string().max(160).optional().nullable(),
  plan: z.string().min(1).max(40).default("pro"),
  seats: z.number().int().min(1).max(100000).default(1),
  expiresAt: z.string().datetime(),
  features: z.array(z.string()).default(["updates", "plugins", "usage"]),
});

const updateLicenseSchema = z.object({
  status: z.enum(["active", "disabled"]).optional(),
  seats: z.number().int().min(1).max(100000).optional(),
  expiresAt: z.string().datetime().optional(),
  plan: z.string().min(1).max(40).optional(),
  customerName: z.string().max(160).optional().nullable(),
  features: z.array(z.string()).optional(),
});

export function registerAdminLicenseRoutes(app, { audit }) {
  app.get("/api/admin/licenses", async () => {
    return {
      licenses: await db.selectFrom("licenses").selectAll().orderBy("created_at", "desc").limit(200).execute(),
    };
  });

  app.get("/api/admin/licenses/:id", async (request, reply) => {
    const license = await db
      .selectFrom("licenses")
      .selectAll()
      .where("id", "=", request.params.id)
      .executeTakeFirst();
    if (!license) return reply.code(404).send({ ok: false, code: "LICENSE_NOT_FOUND" });
    const [devices, usage] = await Promise.all([
      db
        .selectFrom("license_devices")
        .leftJoin("devices", "devices.id", "license_devices.device_id")
        .select([
          "license_devices.id",
          "license_devices.device_id",
          "license_devices.status",
          "license_devices.activated_at",
          "license_devices.last_seen_at",
          "devices.platform",
          "devices.arch",
          "devices.app_version",
          "devices.trial_ends_at",
        ])
        .where("license_devices.license_id", "=", request.params.id)
        .orderBy("license_devices.last_seen_at", "desc")
        .execute(),
      db
        .selectFrom("usage_daily")
        .select((eb) => [
          eb.fn.sum("message_count").as("messages"),
          eb.fn.sum("image_count").as("images"),
          eb.fn.sum("tool_call_count").as("tool_calls"),
          eb.fn.sum("plugin_call_count").as("plugin_calls"),
          eb.fn.sum("input_tokens").as("input_tokens"),
          eb.fn.sum("output_tokens").as("output_tokens"),
        ])
        .where("license_id", "=", request.params.id)
        .executeTakeFirst(),
    ]);
    return { license, devices, usage };
  });

  app.post("/api/admin/licenses", async (request, reply) => {
    const input = createLicenseSchema.parse(request.body);
    const key = licenseKey();
    const id = publicId("lic");
    await db
      .insertInto("licenses")
      .values({
        id,
        license_key_hash: hashLicenseKey(key),
        customer_name: input.customerName || null,
        plan: input.plan,
        seats: input.seats,
        expires_at: input.expiresAt,
        features: JSON.stringify(input.features),
      })
      .execute();
    await audit(request, "license.create", "license", id, { customerName: input.customerName, plan: input.plan, seats: input.seats });
    return reply.code(201).send({ ok: true, licenseId: id, licenseKey: key });
  });

  app.patch("/api/admin/licenses/:id", async (request) => {
    const input = updateLicenseSchema.parse(request.body);
    const updates = {
      ...(input.status ? { status: input.status } : {}),
      ...(input.seats ? { seats: input.seats } : {}),
      ...(input.expiresAt ? { expires_at: input.expiresAt } : {}),
      ...(input.plan ? { plan: input.plan } : {}),
      ...(input.customerName !== undefined ? { customer_name: input.customerName || null } : {}),
      ...(input.features ? { features: JSON.stringify(input.features) } : {}),
      updated_at: new Date(),
    };
    await db.updateTable("licenses").set(updates).where("id", "=", request.params.id).execute();
    await audit(request, "license.update", "license", request.params.id, updates);
    return { ok: true, id: request.params.id };
  });
}
