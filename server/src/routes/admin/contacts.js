import { db } from "../../db.js";

export function registerAdminContactRoutes(app) {
  app.get("/api/admin/contact-requests", async () => {
    const contacts = await db
      .selectFrom("contact_requests")
      .selectAll()
      .orderBy("created_at", "desc")
      .limit(300)
      .execute();
    const ids = contacts.map((contact) => contact.id);
    const attachments = ids.length
      ? await db
          .selectFrom("contact_request_attachments")
          .selectAll()
          .where("contact_request_id", "in", ids)
          .orderBy("created_at", "asc")
          .execute()
      : [];
    const byContactId = new Map();
    for (const attachment of attachments) {
      const list = byContactId.get(attachment.contact_request_id) || [];
      list.push(attachment);
      byContactId.set(attachment.contact_request_id, list);
    }
    return {
      contacts: contacts.map((contact) => ({
        ...contact,
        attachments: byContactId.get(contact.id) || [],
      })),
    };
  });
}
