import { db } from "../../db.js";

export function registerAdminUsageRoutes(app) {
  app.get("/api/admin/usage", async (request) => {
    const days = Math.min(Number(request.query?.days || 30), 120);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    let query = db
      .selectFrom("usage_daily")
      .selectAll()
      .where("usage_date", ">=", since)
      .orderBy("usage_date", "desc");
    const licenseId = String(request.query?.licenseId || "").trim();
    const deviceId = String(request.query?.deviceId || "").trim();
    const model = String(request.query?.model || "").trim();
    if (licenseId) query = query.where("license_id", "=", licenseId);
    if (deviceId) query = query.where("device_id", "=", deviceId);
    if (model) query = query.where("model", "=", model);
    const usage = await query.limit(1000).execute();
    return { usage };
  });
}
