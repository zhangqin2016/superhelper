import { config } from "../../config.js";
import { db } from "../../db.js";
import { okResponse, zodBody } from "../../openapi.js";
import { listPage, pageQuerySchema, pageResponseSchema } from "../../services/admin-pagination.js";

function publicUrlFromObjectKey(objectKey) {
  const key = String(objectKey || "").trim().replace(/^\/+/, "");
  const base = String(config.qiniuPublicBaseUrl || "").trim().replace(/\/+$/, "");
  if (!key.startsWith("feedback/") || !base) return "";
  return `${base}/${key}`;
}

export function normalizeAttachmentForAdmin(attachment) {
  const derivedUrl = publicUrlFromObjectKey(attachment.object_key);
  const storedUrl = String(attachment.public_url || "").trim();
  const publicUrl = derivedUrl || storedUrl;
  return {
    ...attachment,
    public_url: publicUrl,
    publicUrl,
  };
}

export function registerAdminContactRoutes(app) {
  app.get(
    "/api/admin/contact-requests",
    {
      schema: {
        tags: ["admin:contacts"],
        summary: "List contact/support requests",
        description: "Lists recent contact requests with their normalized attachments.",
        querystring: zodBody(pageQuerySchema),
        response: { 200: okResponse(pageResponseSchema("contacts")) },
      },
    },
    async (request) => {
    const page = await listPage(request, {
      key: "contacts",
      query: () => db.selectFrom("contact_requests").selectAll(),
      countQuery: () => db.selectFrom("contact_requests").select((eb) => eb.fn.count("id").as("count")),
      sortColumn: "created_at",
    });
    const contacts = page.contacts;
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
      list.push(normalizeAttachmentForAdmin(attachment));
      byContactId.set(attachment.contact_request_id, list);
    }
    return {
      ...page,
      contacts: contacts.map((contact) => ({
        ...contact,
        attachments: byContactId.get(contact.id) || [],
      })),
    };
  });
}
