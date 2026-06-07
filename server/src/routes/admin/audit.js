import { db } from "../../db.js";

export function registerAdminAuditRoutes(app) {
  app.get("/api/admin/audit-logs", async () => ({
    logs: await db.selectFrom("audit_logs").selectAll().orderBy("created_at", "desc").limit(300).execute(),
  }));
}
