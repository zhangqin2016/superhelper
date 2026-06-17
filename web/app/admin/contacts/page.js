import { AdminShell } from "../../../components/admin-shell";
import { AdminContactAttachments } from "../../../components/admin-contact-attachments";
import { AdminEmpty } from "../../../components/admin-empty";
import { safeApiGet } from "../../../lib/api";
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

export default async function ContactsPage() {
  const { locale, t } = await getI18n();
  const data = await safeApiGet("/api/admin/contact-requests", { contacts: [] });
  const contacts = data.contacts || [];
  const copy = t.admin.contacts;
  return (
    <AdminShell title={t.admin.pages.contacts[0]} subtitle={t.admin.pages.contacts[1]}>
      <div className="table-card p-6">
        {contacts.length ? (
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                {copy.headings.map((heading) => (
                  <th key={heading} className="px-5 py-4">{heading}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {contacts.map((contact) => (
                <tr key={contact.id} className="border-t border-slate-100 align-top">
                  <td className="whitespace-nowrap px-5 py-4 text-slate-500">{formatTime(contact.created_at, locale)}</td>
                  <td className="px-5 py-4">
                    <div className="font-semibold text-slate-950">{contact.name}</div>
                    <div className="mt-1 text-slate-500">{contact.email}</div>
                    {contact.phone ? <div className="mt-1 text-slate-500">{contact.phone}</div> : null}
                  </td>
                  <td className="px-5 py-4">{contact.company || "-"}</td>
                  <td className="px-5 py-4">{contact.subject || "-"}</td>
                  <td className="max-w-xl whitespace-pre-wrap px-5 py-4 leading-6 text-slate-600">{contact.message}</td>
                  <td className="px-5 py-4">
                    <AdminContactAttachments attachments={contact.attachments || []} />
                  </td>
                  <td className="px-5 py-4">{contact.source || "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <AdminEmpty title={copy.emptyTitle} description={copy.emptyDesc} />
        )}
      </div>
    </AdminShell>
  );
}
