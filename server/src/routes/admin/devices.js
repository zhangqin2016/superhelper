import { z } from "zod";
import { db } from "../../db.js";
import { zodBody, okResponse } from "../../openapi.js";
import { sql } from "kysely";
import { listPage, pageQuerySchema, pageResponseSchema } from "../../services/admin-pagination.js";
import { latestReleases } from "../../services/release-versions.js";

// 1,210 installs, 85% unseen for a month: an unfiltered list is mostly the
// dead. Default to the fleet that is actually running; "all" is one click away.
const SEEN_WINDOWS = { "7d": "7 days", "30d": "30 days" };
const deviceListQuerySchema = pageQuerySchema.extend({
  seen: z.enum(["7d", "30d", "all"]).optional().default("30d"),
});

function seenSince(seen) {
  const window = SEEN_WINDOWS[seen];
  return window ? sql`now() - ${sql.raw(`interval '${window}'`)}` : null;
}

const updateDeviceBindingSchema = z.object({
  status: z.enum(["active", "disabled"]),
});

export function registerAdminDeviceRoutes(app, { audit }) {
  app.get(
    "/api/admin/devices",
    {
      schema: {
        tags: ["admin:devices"],
        summary: "List devices",
        description: "Returns a page of devices seen within the window (default 30d) with their license binding, most recently seen first, plus the latest enabled release per platform-arch.",
        querystring: zodBody(deviceListQuerySchema),
        response: { 200: okResponse({ ...pageResponseSchema("devices"), seen: { type: "string" }, latest: { type: "object", additionalProperties: { type: "string" } } }) },
      },
    },
    async (request) => {
      const { seen } = deviceListQuerySchema.parse(request?.query || {});
      const since = seenSince(seen);
      const inWindow = (builder) => (since ? builder.where("devices.last_seen_at", ">", since) : builder);
      const [page, releases] = await Promise.all([
        listPage(request, {
      key: "devices",
      query: () => inWindow(db
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
        ])),
      countQuery: () => inWindow(db.selectFrom("devices").select((eb) => eb.fn.count("devices.id").as("count"))),
      sortColumn: "devices.last_seen_at",
      idColumn: "devices.id",
        }),
        db.selectFrom("releases").select(["platform", "version"]).where("enabled", "=", true).execute().catch(() => []),
      ]);
      const latest = Object.fromEntries(latestReleases(releases).map((row) => [row.platform, row.latest]));
      return { ...page, seen, latest };
    },
  );

  app.get(
    "/api/admin/devices/:id",
    {
      schema: {
        tags: ["admin:devices"],
        summary: "Get a device with its licenses and usage",
        description: "Returns the device record plus its license bindings and recent daily usage.",
        response: { 200: okResponse({ device: { type: "object" }, licenses: { type: "array" }, usage: { type: "array" } }) },
      },
    },
    async (request, reply) => {
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

  app.patch(
    "/api/admin/license-devices/:id",
    {
      schema: {
        tags: ["admin:devices"],
        summary: "Update a license-device binding status",
        description: "Sets the binding's status (active or disabled) and refreshes its last-seen timestamp.",
        body: zodBody(updateDeviceBindingSchema),
        response: { 200: okResponse({ id: { type: "string" } }) },
      },
    },
    async (request) => {
    const input = updateDeviceBindingSchema.parse(request.body);
    await db
      .updateTable("license_devices")
      .set({ status: input.status, last_seen_at: new Date() })
      .where("id", "=", request.params.id)
      .execute();
    await audit(request, "license_device.update", "license_device", request.params.id, { status: input.status });
    return { ok: true, id: request.params.id };
  });

  app.delete(
    "/api/admin/license-devices/:id",
    {
      schema: {
        tags: ["admin:devices"],
        summary: "Delete a license-device binding",
        description: "Removes the license-device binding record.",
        response: { 200: okResponse({ id: { type: "string" } }) },
      },
    },
    async (request) => {
    await db.deleteFrom("license_devices").where("id", "=", request.params.id).execute();
    await audit(request, "license_device.delete", "license_device", request.params.id);
    return { ok: true, id: request.params.id };
  });
}
