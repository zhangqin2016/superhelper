import { db } from "../../db.js";
import { okResponse, zodBody } from "../../openapi.js";
import { listPage, pageQuerySchema, pageResponseSchema } from "../../services/admin-pagination.js";

export function registerAdminAuditRoutes(app) {
  app.get(
    "/api/admin/audit-logs",
    {
      schema: {
        tags: ["admin:audit"],
        summary: "List admin audit log entries",
        description: "Returns one page of audit log entries, newest first, with an opaque cursor for the next page and the exact total.",
        querystring: zodBody(pageQuerySchema),
        response: { 200: okResponse(pageResponseSchema("logs")) },
      },
    },
    async (request) => listPage(request, {
      key: "logs",
      query: () => db.selectFrom("audit_logs").selectAll(),
      countQuery: () => db.selectFrom("audit_logs").select((eb) => eb.fn.count("id").as("count")),
      sortColumn: "created_at",
    }),
  );
}
