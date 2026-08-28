import { db } from "../../db.js";
import { okResponse } from "../../openapi.js";

export function registerAdminUsageRoutes(app) {
  app.get(
    "/api/admin/usage",
    {
      schema: {
        tags: ["admin:usage"],
        summary: "List daily usage rows",
        description: "Returns legacy daily aggregates, filtered by license, device, or model. Supplying providerID selects provider detail instead; historical and old-server usage is unknown.",
        response: { 200: okResponse({ usage: { type: "array" } }) },
      },
    },
    async (request) => {
    const days = Math.min(Number(request.query?.days || 30), 120);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const providerID = String(request.query?.providerID || "");
    let query = db
      .selectFrom(providerID ? "usage_provider_breakdown" : "usage_daily")
      .selectAll()
      .where("usage_date", ">=", since)
      .orderBy("usage_date", "desc");
    const licenseId = String(request.query?.licenseId || "").trim();
    const deviceId = String(request.query?.deviceId || "").trim();
    const model = String(request.query?.model || "").trim();
    if (licenseId) query = query.where("license_id", "=", licenseId);
    if (deviceId) query = query.where("device_id", "=", deviceId);
    if (model) query = query.where("model", "=", model);
    if (providerID) query = query.where("provider_id", "=", providerID);
    const usage = await query.limit(1000).execute();
    return { usage };
  });
}
