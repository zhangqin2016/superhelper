import { z } from "zod";
import { sql } from "kysely";
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

// A request was "new" forever: the column existed and nothing could move it, so
// 34 requests read the same whether answered or not. Two states are the whole
// workflow an inbox needs.
export const CONTACT_STATUSES = ["new", "handled"];
const contactListQuerySchema = pageQuerySchema.extend({
  status: z.enum([...CONTACT_STATUSES, "all"]).optional().default("new"),
});
const updateContactSchema = z.object({ status: z.enum(CONTACT_STATUSES) });

export function registerAdminContactRoutes(app, { audit } = {}) {
  app.get(
    "/api/admin/contact-requests",
    {
      schema: {
        tags: ["admin:contacts"],
        summary: "List contact/support requests",
        description: "Lists contact requests in a status (default: new — the ones still waiting) with their normalized attachments, plus the count in each status.",
        querystring: zodBody(contactListQuerySchema),
        response: { 200: okResponse({ ...pageResponseSchema("contacts"), status: { type: "string" }, counts: { type: "object", additionalProperties: { type: "number" } } }) },
      },
    },
    async (request) => {
    const { status } = contactListQuerySchema.parse(request?.query || {});
    const inStatus = (builder) => (status === "all" ? builder : builder.where("status", "=", status));
    const [page, countRows] = await Promise.all([
      listPage(request, {
        key: "contacts",
        query: () => inStatus(db.selectFrom("contact_requests").selectAll()),
        countQuery: () => inStatus(db.selectFrom("contact_requests").select((eb) => eb.fn.count("id").as("count"))),
        sortColumn: "created_at",
      }),
      db.selectFrom("contact_requests").select(["status", sql`count(*)::int`.as("n")]).groupBy("status").execute().catch(() => []),
    ]);
    const counts = Object.fromEntries(CONTACT_STATUSES.map((key) => [key, 0]));
    for (const row of countRows) counts[row.status] = Number(row.n || 0);
    counts.all = countRows.reduce((sum, row) => sum + Number(row.n || 0), 0);
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
      status,
      counts,
      contacts: contacts.map((contact) => ({
        ...contact,
        attachments: byContactId.get(contact.id) || [],
      })),
    };
  });

  app.patch(
    "/api/admin/contact-requests/:id",
    {
      schema: {
        tags: ["admin:contacts"],
        summary: "Mark a contact request handled, or reopen it",
        body: zodBody(updateContactSchema),
        response: { 200: okResponse({ id: { type: "string" } }) },
      },
    },
    async (request, reply) => {
      const input = updateContactSchema.parse(request.body);
      const result = await db.updateTable("contact_requests").set({ status: input.status }).where("id", "=", request.params.id).executeTakeFirst();
      if (!Number(result?.numUpdatedRows || 0)) return reply.code(404).send({ ok: false, error: "not_found" });
      await audit?.(request, "contact.update", "contact_request", request.params.id, { status: input.status });
      return { ok: true, id: request.params.id };
    },
  );
}
