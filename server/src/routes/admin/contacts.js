import { db } from "../../db.js";

export function registerAdminContactRoutes(app) {
  app.get("/api/admin/contact-requests", async () => ({
    contacts: await db
      .selectFrom("contact_requests")
      .selectAll()
      .orderBy("created_at", "desc")
      .limit(300)
      .execute(),
  }));
}
