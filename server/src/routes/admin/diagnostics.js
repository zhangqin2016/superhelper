import { sql } from "kysely";
import { db } from "../../db.js";
import { okResponse, zodBody } from "../../openapi.js";
import { pageOf, pageQuerySchema, pageResponseSchema } from "../../services/admin-pagination.js";

const LIST_COLUMNS = [
  "id", "created_at", "severity", "normalized_kind", "event_type", "event_subtype", "summary",
  "device_id", "license_id", "platform", "arch", "app_version", "turn_phase", "session_state",
];

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
        // A trace runs to 40 KB; a page of 50 carried them all inline. The list
        // is the summary; the trace is one click away on the record itself.
        query: () => filtered(db.selectFrom("runtime_diagnostics").select(LIST_COLUMNS)),
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
          // How many machines a failure reaches says more than how often it fires:
          // 108 empty replies on 23 devices is a platform problem, 29 on 4 is not.
          sql`count(distinct device_id)`.as("devices"),
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
        devices: Number(row.devices || 0),
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
