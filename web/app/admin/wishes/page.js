import Link from "next/link";
import { AdminShell } from "../../../components/admin-shell";
import { AdminEmpty } from "../../../components/admin-empty";
import { Badge } from "../../../components/ui/badge";
import { safeApiGet } from "../../../lib/api";
import { getI18n } from "../../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

export default async function AdminWishesPage({ searchParams }) {
  const { t } = await getI18n();
  const copy = t.admin.wishes;
  const params = await searchParams;
  const query = new URLSearchParams();
  if (params?.status) query.set("status", params.status);
  if (params?.category) query.set("category", params.category);
  const data = await safeApiGet(`/api/admin/wishes${query.size ? `?${query}` : ""}`, { wishes: [] });
  const wishes = data.wishes || [];

  return (
    <AdminShell title={copy.title} subtitle={copy.subtitle}>
      <form className="table-card mb-6 grid gap-4 p-5 md:grid-cols-[1fr_1fr_auto]">
        <select name="status" defaultValue={params?.status || ""} className="rounded-lg border border-slate-200 px-3 py-2.5 text-sm">
          <option value="">{copy.allStatuses}</option>
          {Object.entries(copy.statuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <select name="category" defaultValue={params?.category || ""} className="rounded-lg border border-slate-200 px-3 py-2.5 text-sm">
          <option value="">{copy.allCategories}</option>
          {Object.entries(copy.categories).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <button className="rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-white">{copy.filter}</button>
      </form>
      {wishes.length ? (
        <div className="table-card overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-500"><tr>{copy.columns.map((item) => <th key={item} className="px-5 py-4">{item}</th>)}</tr></thead>
            <tbody>{wishes.map((wish) => (
              <tr key={wish.id} className="border-t border-slate-100">
                <td className="px-5 py-4"><Link className="font-semibold text-brand hover:underline" href={`/admin/wishes/${wish.id}`}>{wish.public_title || wish.title}</Link><div className="mt-1 font-mono text-xs text-slate-400">{wish.id}</div></td>
                <td className="px-5 py-4"><Badge variant={wish.status === "shipped" ? "success" : "brand"}>{copy.statuses[wish.status] || wish.status}</Badge></td>
                <td className="px-5 py-4">{copy.categories[wish.category] || wish.category}</td>
                <td className="px-5 py-4">{Number(wish.support_count || 0)}</td>
                <td className="px-5 py-4">{wish.updated_at ? new Date(wish.updated_at).toLocaleString() : "-"}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : <AdminEmpty title={copy.emptyTitle} description={copy.emptyDesc} />}
    </AdminShell>
  );
}
