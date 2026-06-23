import { db } from "../../db.js";
import { okResponse } from "../../openapi.js";

export function registerAdminAuditRoutes(app) {
  app.get(
    "/api/admin/audit-logs",
    {
      schema: {
        tags: ["admin:audit"],
        summary: "List recent admin audit log entries",
        description: "Returns the 300 most recent audit log entries, newest first.",
        response: { 200: okResponse({ logs: { type: "array", items: { type: "object" } } }) },
      },
    },
    async () => ({
      logs: await db.selectFrom("audit_logs").selectAll().orderBy("created_at", "desc").limit(300).execute(),
    }),
  );
}
