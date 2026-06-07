import { db } from "../../db.js";

export function registerAdminDiagnosticsRoutes(app) {
  app.get("/api/admin/diagnostics", async (request) => {
    const days = Math.min(Number(request.query?.days || 30), 120);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    let query = db
      .selectFrom("runtime_diagnostics")
      .selectAll()
      .where("created_at", ">=", since)
      .orderBy("created_at", "desc");
    const deviceId = String(request.query?.deviceId || "").trim();
    const kind = String(request.query?.kind || "").trim();
    const severity = String(request.query?.severity || "").trim();
    if (deviceId) query = query.where("device_id", "=", deviceId);
    if (kind) query = query.where("normalized_kind", "=", kind);
    if (severity) query = query.where("severity", "=", severity);
    const [diagnostics, byKind] = await Promise.all([
      query.limit(300).execute(),
      db
        .selectFrom("runtime_diagnostics")
        .select((eb) => [
          "normalized_kind",
          "severity",
          eb.fn.count("id").as("count"),
        ])
        .where("created_at", ">=", since)
        .groupBy(["normalized_kind", "severity"])
        .orderBy("count", "desc")
        .limit(20)
        .execute(),
    ]);
    return {
      diagnostics,
      byKind: byKind.map((row) => ({
        kind: row.normalized_kind || "unknown",
        severity: row.severity || "warning",
        count: Number(row.count || 0),
      })),
    };
  });

  app.get("/api/admin/diagnostics/:id", async (request, reply) => {
    const diagnostic = await db
      .selectFrom("runtime_diagnostics")
      .selectAll()
      .where("id", "=", request.params.id)
      .executeTakeFirst();
    if (!diagnostic) return reply.code(404).send({ ok: false, code: "DIAGNOSTIC_NOT_FOUND" });
    return { diagnostic };
  });
}
