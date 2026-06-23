import { sql } from "kysely";
import { db } from "../../db.js";
import { okResponse } from "../../openapi.js";

export function registerAdminSummaryRoutes(app) {
  app.get(
    "/api/admin/summary",
    {
      schema: {
        tags: ["admin:summary"],
        summary: "Get the admin dashboard summary",
        description: "Returns license/device counts, today's usage, top models and a 30-day usage trend.",
        response: {
          200: okResponse({
            licenses: { type: "number" },
            activeLicenses: { type: "number" },
            devices: { type: "number" },
            activeDevicesToday: { type: "number" },
            todayMessages: { type: "number" },
            todayTokens: { type: "number" },
            models: { type: "array", items: { type: "object" } },
            trend: { type: "array", items: { type: "object" } },
          }),
        },
      },
    },
    async () => {
    const today = new Date().toISOString().slice(0, 10);
    const since = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const [licenses, activeLicenses, devices, activeDevices, todayUsage, models, trend] = await Promise.all([
      db.selectFrom("licenses").select((eb) => eb.fn.count("id").as("count")).executeTakeFirst(),
      db.selectFrom("licenses").select((eb) => eb.fn.count("id").as("count")).where("status", "=", "active").executeTakeFirst(),
      db.selectFrom("devices").select((eb) => eb.fn.count("id").as("count")).executeTakeFirst(),
      db
        .selectFrom("usage_daily")
        .select(() => sql`count(distinct device_id)`.as("count"))
        .where("usage_date", "=", today)
        .executeTakeFirst(),
      db
        .selectFrom("usage_daily")
        .select((eb) => [
          eb.fn.sum("message_count").as("messages"),
          eb.fn.sum("input_tokens").as("input_tokens"),
          eb.fn.sum("output_tokens").as("output_tokens"),
        ])
        .where("usage_date", "=", today)
        .executeTakeFirst(),
      db
        .selectFrom("usage_daily")
        .select((eb) => ["model", eb.fn.sum("message_count").as("messages")])
        .groupBy("model")
        .orderBy("messages", "desc")
        .limit(8)
        .execute(),
      db
        .selectFrom("usage_daily")
        .select((eb) => [
          "usage_date",
          eb.fn.sum("message_count").as("messages"),
          sql`count(distinct device_id)`.as("active_devices"),
        ])
        .where("usage_date", ">=", since)
        .groupBy("usage_date")
        .orderBy("usage_date", "asc")
        .execute(),
    ]);
    return {
      licenses: Number(licenses?.count || 0),
      activeLicenses: Number(activeLicenses?.count || 0),
      devices: Number(devices?.count || 0),
      activeDevicesToday: Number(activeDevices?.count || 0),
      todayMessages: Number(todayUsage?.messages || 0),
      todayTokens: Number(todayUsage?.input_tokens || 0) + Number(todayUsage?.output_tokens || 0),
      models: models.map((row) => ({ model: row.model, messages: Number(row.messages || 0) })),
      trend: trend.map((row) => ({
        date: String(row.usage_date).slice(0, 10),
        messages: Number(row.messages || 0),
        activeDevices: Number(row.active_devices || 0),
      })),
    };
  });
}
