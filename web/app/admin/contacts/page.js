import { AdminShell } from "../../../components/admin-shell";
import { AdminContactAttachments } from "../../../components/admin-contact-attachments";
import { AdminContactDiagnostics } from "../../../components/admin-contact-diagnostics";
import { AdminEmpty } from "../../../components/admin-empty";
import { Pagination } from "../../../components/pagination";
import { ListFilter } from "../../../components/list-filter";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { setContactStatusAction } from "../actions";
import { loadAdmin } from "../../../lib/api";
import { getI18n } from "../../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

function formatTime(value, locale) {
  if (!value) return "";
  const intlLocale = locale === "zh" ? "zh-CN" : locale;
  return new Intl.DateTimeFormat(intlLocale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export default async function ContactsPage({ searchParams }) {
  const { locale, t } = await getI18n();
  const params = await searchParams;
  const cursor = String(params?.cursor || "");
  const status = ["new", "handled", "all"].includes(params?.status) ? params.status : "new";
  const query = new URLSearchParams({ status });
  if (cursor) query.set("cursor", cursor);
  const data = await loadAdmin(`/api/admin/contact-requests?${query}`, { contacts: [], nextCursor: "", total: null, counts: {} });
  const contacts = data.contacts || [];
  const counts = data.counts || {};
  const copy = t.admin.contacts;
  const withCount = (label, key) => (Number.isFinite(counts[key]) ? `${label} ${counts[key]}` : label);
  return (
    <AdminShell title={t.admin.pages.contacts[0]} subtitle={t.admin.pages.contacts[1]}>
      <ListFilter
        basePath="/admin/contacts"
        searchParams={params || {}}
        param="status"
        value={status}
        options={[
          { value: "new", label: withCount(copy.statusNew, "new") },
          { value: "handled", label: withCount(copy.statusHandled, "handled") },
          { value: "all", label: withCount(copy.statusAll, "all") },
        ]}
      />
      <div className="table-card p-4">
        {contacts.length ? (
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                {copy.headings.map((heading) => (
                  <th key={heading} className="px-4 py-2">{heading}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {contacts.map((contact) => (
                <tr key={contact.id} className="border-t border-slate-100 align-top">
                  <td className="whitespace-nowrap px-4 py-2 text-slate-500">{formatTime(contact.created_at, locale)}</td>
                  <td className="px-4 py-2">
                    <div className="font-semibold text-slate-950">{contact.name}</div>
                    <div className="mt-1 text-slate-500">{contact.email}</div>
                    {contact.phone ? <div className="mt-1 text-slate-500">{contact.phone}</div> : null}
                  </td>
                  <td className="px-4 py-2">{contact.company || "-"}</td>
                  <td className="px-4 py-2">{contact.subject || "-"}</td>
                  <td className="max-w-xl whitespace-pre-wrap px-4 py-2 leading-6 text-slate-600">{contact.message}</td>
                  <td className="px-4 py-2">
                    <AdminContactAttachments attachments={contact.attachments || []} />
                    <AdminContactDiagnostics contactId={contact.id} diagnostics={contact.diagnostics} copy={copy} />
                  </td>
                  <td className="px-4 py-2">{contact.source || "-"}</td>
                  <td className="px-4 py-2">
                    <div className="flex flex-col items-start gap-2">
                      <Badge variant={contact.status === "handled" ? "success" : "warning"}>{contact.status === "handled" ? copy.statusHandled : copy.statusNew}</Badge>
                      <form action={setContactStatusAction}>
                        <input type="hidden" name="id" value={contact.id} />
                        <input type="hidden" name="status" value={contact.status === "handled" ? "new" : "handled"} />
                        <Button variant="outline" size="sm">{contact.status === "handled" ? copy.reopen : copy.markHandled}</Button>
                      </form>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <AdminEmpty title={copy.emptyTitle} description={copy.emptyDesc} />
        )}
      </div>
      <Pagination
        basePath="/admin/contacts"
        searchParams={params || {}}
        shown={contacts.length}
        total={data.total ?? null}
        nextCursor={data.nextCursor || ""}
        cursor={cursor}
        copy={t.admin.paging}
      />
    </AdminShell>
  );
}
