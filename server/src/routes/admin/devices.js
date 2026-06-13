import { z } from "zod";
import { db } from "../../db.js";

const updateDeviceBindingSchema = z.object({
  status: z.enum(["active", "disabled"]),
});

export function registerAdminDeviceRoutes(app, { audit }) {
  app.get("/api/admin/devices", async () => {
    const devices = await db
      .selectFrom("devices")
      .leftJoin("license_devices", "license_devices.device_id", "devices.id")
      .select([
        "devices.id",
        "devices.platform",
        "devices.arch",
        "devices.app_version",
        "devices.group_id",
        "devices.first_seen_at",
        "devices.last_seen_at",
        "devices.trial_ends_at",
        "license_devices.id as license_device_id",
        "license_devices.license_id",
        "license_devices.status as license_status",
      ])
      .orderBy("devices.last_seen_at", "desc")
      .limit(300)
      .execute();
    return { devices };
  });

  app.get("/api/admin/devices/:id", async (request, reply) => {
    const device = await db
      .selectFrom("devices")
      .selectAll()
      .where("id", "=", request.params.id)
      .executeTakeFirst();
    if (!device) return reply.code(404).send({ ok: false, code: "DEVICE_NOT_FOUND" });
    const [licenses, usage] = await Promise.all([
      db
        .selectFrom("license_devices")
        .leftJoin("licenses", "licenses.id", "license_devices.license_id")
        .select([
          "license_devices.id",
          "license_devices.license_id",
          "license_devices.status",
          "license_devices.activated_at",
          "license_devices.last_seen_at",
          "licenses.customer_name",
          "licenses.plan",
          "licenses.expires_at",
        ])
        .where("license_devices.device_id", "=", request.params.id)
        .orderBy("license_devices.last_seen_at", "desc")
        .execute(),
      db
        .selectFrom("usage_daily")
        .selectAll()
        .where("device_id", "=", request.params.id)
        .orderBy("usage_date", "desc")
        .limit(120)
        .execute(),
    ]);
    return { device, licenses, usage };
  });

  app.patch("/api/admin/license-devices/:id", async (request) => {
    const input = updateDeviceBindingSchema.parse(request.body);
    await db
      .updateTable("license_devices")
      .set({ status: input.status, last_seen_at: new Date() })
      .where("id", "=", request.params.id)
      .execute();
    await audit(request, "license_device.update", "license_device", request.params.id, { status: input.status });
    return { ok: true, id: request.params.id };
  });

  app.delete("/api/admin/license-devices/:id", async (request) => {
    await db.deleteFrom("license_devices").where("id", "=", request.params.id).execute();
    await audit(request, "license_device.delete", "license_device", request.params.id);
    return { ok: true, id: request.params.id };
  });
}
