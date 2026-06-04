import { AdminShell } from "../../../components/admin-shell";
import { AdminEmpty } from "../../../components/admin-empty";
import { safeApiGet } from "../../../lib/api";
import { getI18n } from "../../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

function formatTime(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export default async function ContactsPage() {
  const { t } = await getI18n();
  const data = await safeApiGet("/api/admin/contact-requests", { contacts: [] });
  const contacts = data.contacts || [];
  return (
    <AdminShell title={t.admin.pages.contacts[0]} subtitle={t.admin.pages.contacts[1]}>
      <div className="table-card p-6">
        {contacts.length ? (
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                {["时间", "联系人", "公司", "主题", "内容", "来源"].map((heading) => (
                  <th key={heading} className="px-5 py-4">{heading}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {contacts.map((contact) => (
                <tr key={contact.id} className="border-t border-slate-100 align-top">
                  <td className="whitespace-nowrap px-5 py-4 text-slate-500">{formatTime(contact.created_at)}</td>
                  <td className="px-5 py-4">
                    <div className="font-semibold text-slate-950">{contact.name}</div>
                    <div className="mt-1 text-slate-500">{contact.email}</div>
                    {contact.phone ? <div className="mt-1 text-slate-500">{contact.phone}</div> : null}
                  </td>
                  <td className="px-5 py-4">{contact.company || "-"}</td>
                  <td className="px-5 py-4">{contact.subject || "-"}</td>
                  <td className="max-w-xl px-5 py-4 leading-6 text-slate-600">{contact.message}</td>
                  <td className="px-5 py-4">{contact.source || "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <AdminEmpty title="暂无联系咨询" description="官网联系表单提交后会显示在这里。" />
        )}
      </div>
    </AdminShell>
  );
}
