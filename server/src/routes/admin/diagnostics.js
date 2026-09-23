import { db } from "../../db.js";
import { okResponse, zodBody } from "../../openapi.js";
import { pageOf, pageQuerySchema, pageResponseSchema } from "../../services/admin-pagination.js";

export function registerAdminDiagnosticsRoutes(app) {
  app.get(
    "/api/admin/diagnostics",
    {
      schema: {
        tags: ["admin:diagnostics"],
        summary: "List runtime diagnostics with a breakdown by kind",
        description: "Returns recent runtime diagnostics over the requested window plus aggregate counts grouped by kind and severity.",
        querystring: zodBody(pageQuerySchema.passthrough()),
        response: { 200: okResponse({ ...pageResponseSchema("diagnostics"), byKind: { type: "array", items: { type: "object", additionalProperties: true } } }) },
      },
    },
    async (request) => {
    const days = Math.min(Number(request.query?.days || 30), 120);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const deviceId = String(request.query?.deviceId || "").trim();
    const kind = String(request.query?.kind || "").trim();
    const severity = String(request.query?.severity || "").trim();
    // One filter definition for the page and its count, so the total belongs to
    // what the reader filtered.
    const filtered = (builder) => {
      let q = builder.where("created_at", ">=", since);
      if (deviceId) q = q.where("device_id", "=", deviceId);
      if (kind) q = q.where("normalized_kind", "=", kind);
      if (severity) q = q.where("severity", "=", severity);
      return q;
    };
    const [diagnostics, byKind] = await Promise.all([
      pageOf({
        query: () => filtered(db.selectFrom("runtime_diagnostics").selectAll()),
        countQuery: () => filtered(db.selectFrom("runtime_diagnostics").select((eb) => eb.fn.count("id").as("count"))),
        sortColumn: "created_at",
        ...pageQuerySchema.parse(request.query || {}),
      }),
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
      diagnostics: diagnostics.items,
      nextCursor: diagnostics.nextCursor,
      total: diagnostics.total,
      pageSize: diagnostics.pageSize,
      byKind: byKind.map((row) => ({
        kind: row.normalized_kind || "unknown",
        severity: row.severity || "warning",
        count: Number(row.count || 0),
      })),
    };
  });

  app.get(
    "/api/admin/diagnostics/:id",
    {
      schema: {
        tags: ["admin:diagnostics"],
        summary: "Get a single runtime diagnostic",
        description: "Returns one runtime diagnostic record by id.",
        response: { 200: okResponse({ diagnostic: { type: "object" } }) },
      },
    },
    async (request, reply) => {
    const diagnostic = await db
      .selectFrom("runtime_diagnostics")
      .selectAll()
      .where("id", "=", request.params.id)
      .executeTakeFirst();
    if (!diagnostic) return reply.code(404).send({ ok: false, code: "DIAGNOSTIC_NOT_FOUND" });
    return { diagnostic };
  });
}
