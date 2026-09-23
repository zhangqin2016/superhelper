import { z } from "zod";
import { db } from "../../db.js";
import { okResponse, zodBody } from "../../openapi.js";
import { usageAnalytics } from "../../services/usage-analytics.js";
import { listPage, pageOf, pageQuerySchema, pageResponseSchema } from "../../services/admin-pagination.js";

const analyticsQuerySchema = z.object({ days: z.coerce.number().int().min(1).max(365).optional().default(30) });

export function registerAdminUsageRoutes(app) {
  app.get(
    "/api/admin/usage/analytics",
    {
      schema: {
        tags: ["admin:usage"],
        summary: "Token spend distribution, concentration and coverage",
        description: "Answers how token spend is SHAPED — percentiles over daily per-device/model spend, which devices, licenses and models carry it, and how much of the window actually carries token data — instead of a single sum.",
        querystring: zodBody(analyticsQuerySchema),
        response: { 200: okResponse({ analytics: { type: "object", additionalProperties: true } }) },
      },
    },
    async (request) => {
      const { days } = analyticsQuerySchema.parse(request.query || {});
      return { ok: true, analytics: await usageAnalytics({ days }) };
    },
  );

  app.get(
    "/api/admin/usage",
    {
      schema: {
        tags: ["admin:usage"],
        summary: "List daily usage rows",
        description: "Returns legacy daily aggregates, filtered by license, device, or model. Supplying providerID selects provider detail instead; historical and old-server usage is unknown.",
        querystring: zodBody(pageQuerySchema.passthrough()),
        response: { 200: okResponse(pageResponseSchema("usage")) },
      },
    },
    async (request) => {
    const days = Math.min(Number(request.query?.days || 30), 120);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const providerID = String(request.query?.providerID || "");
    const licenseId = String(request.query?.licenseId || "").trim();
    const deviceId = String(request.query?.deviceId || "").trim();
    const model = String(request.query?.model || "").trim();
    const table = providerID ? "usage_provider_breakdown" : "usage_daily";
    // The filters apply to both the page and its count, so the total a reader
    // sees is the total of what they filtered — not of the whole table.
    const filtered = (builder) => {
      let q = builder.where("usage_date", ">=", since);
      if (licenseId) q = q.where("license_id", "=", licenseId);
      if (deviceId) q = q.where("device_id", "=", deviceId);
      if (model) q = q.where("model", "=", model);
      if (providerID) q = q.where("provider_id", "=", providerID);
      return q;
    };
    const { cursor, limit } = pageQuerySchema.parse(request.query || {});
    const page = await pageOf({
      query: () => filtered(db.selectFrom(table).selectAll()),
      countQuery: () => filtered(db.selectFrom(table).select((eb) => eb.fn.count("id").as("count"))),
      sortColumn: "usage_date",
      cursor,
      limit,
    });
    return { usage: page.items, nextCursor: page.nextCursor, total: page.total, pageSize: page.pageSize };
  });
}
