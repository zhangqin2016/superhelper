import Link from "next/link";
import { AdminShell } from "../../../components/admin-shell";
import { AdminEmpty } from "../../../components/admin-empty";
import { safeApiGet } from "../../../lib/api";
import { getI18n } from "../../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

function fmt(value, locale = "zh") {
  return Number(value || 0).toLocaleString(locale === "zh" ? "zh-CN" : locale);
}

function money(cents) {
  return `¥ ${(Number(cents || 0) / 100).toFixed(2)}`;
}

function date(value, locale = "zh") {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "-";
  return parsed.toLocaleString(locale === "zh" ? "zh-CN" : locale);
}

function queryString(searchParams = {}) {
  const params = new URLSearchParams();
  params.set("limit", searchParams.limit || "100");
  for (const key of ["q", "status"]) {
    if (searchParams[key]) params.set(key, searchParams[key]);
  }
  return params.toString();
}

export default async function AdminUsersPage({ searchParams }) {
  const { locale, t } = await getI18n();
  const c = t.admin.usersView;
  const filters = await searchParams;
  const data = await safeApiGet(`/api/admin/users?${queryString(filters)}`, { users: [], stats: {} });
  const users = data.users || [];
  const stats = data.stats || {};

  return (
    <AdminShell title={t.admin.pages.users[0]} subtitle={t.admin.pages.users[1]}>
      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-6">
        {[
          [c.stats[0], fmt(stats.totalUsers, locale)],
          [c.stats[1], fmt(stats.activeUsers, locale)],
          [c.stats[2], fmt(stats.usersToday, locale)],
          [c.stats[3], fmt(stats.paidUsers, locale)],
          [c.stats[4], fmt(stats.paidOrders, locale)],
          [c.stats[5], money(stats.revenueCents)],
        ].map(([label, value]) => (
          <div key={label} className="metric-card rounded-xl p-5">
            <div className="font-mono text-2xl font-semibold">{value}</div>
            <div className="mt-2 text-sm text-slate-500">{label}</div>
          </div>
        ))}
      </div>

      <form className="table-card my-6 grid gap-4 p-6 lg:grid-cols-[1fr_160px_120px_120px]">
        <label className="grid gap-2 text-sm font-medium text-slate-600">
          {c.filters.search}
          <input name="q" defaultValue={filters?.q || ""} className="rounded-lg border border-slate-200 px-3 py-2" placeholder="+8613800000000" />
        </label>
        <label className="grid gap-2 text-sm font-medium text-slate-600">
          {c.filters.status}
          <select name="status" defaultValue={filters?.status || ""} className="rounded-lg border border-slate-200 bg-white px-3 py-2">
            <option value="">{c.filters.all}</option>
            <option value="active">{c.filters.active}</option>
            <option value="disabled">{c.filters.disabled}</option>
          </select>
        </label>
        <label className="grid gap-2 text-sm font-medium text-slate-600">
          {c.filters.limit}
          <input name="limit" defaultValue={filters?.limit || "100"} className="rounded-lg border border-slate-200 px-3 py-2" />
        </label>
        <div className="flex items-end">
          <button className="w-full rounded-lg bg-brand px-5 py-2.5 font-semibold text-white">{c.filters.apply}</button>
        </div>
      </form>

      <div className="table-card p-6">
        {users.length ? (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  {c.table.map((header) => (
                    <th key={header} className="px-5 py-4">{header}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id} className="border-t border-slate-100">
                    <td className="px-5 py-4">
                      <Link href={`/admin/users/${user.id}`} className="font-semibold text-brand hover:underline">{user.phoneMasked || user.phoneE164}</Link>
                      <div className="mt-1 font-mono text-xs text-slate-400">{user.id}</div>
                    </td>
                    <td className="px-5 py-4">{user.status}</td>
                    <td className="px-5 py-4">{date(user.createdAt, locale)}</td>
                    <td className="px-5 py-4">{date(user.lastLoginAt, locale)}</td>
                    <td className="px-5 py-4">{fmt(user.paidOrderCount, locale)} / {fmt(user.orderCount, locale)}</td>
                    <td className="px-5 py-4">{money(user.totalPaidCents)}</td>
                    <td className="px-5 py-4">
                      <div>Token {fmt(user.tokenRemaining, locale)}</div>
                      <div className="text-xs text-slate-500">{c.image} {fmt(user.imageRemaining, locale)} · {c.video} {fmt(user.videoRemaining, locale)}</div>
                    </td>
                    <td className="px-5 py-4">{fmt(user.activeSessionCount, locale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <AdminEmpty title={c.emptyTitle} description={c.emptyDesc} />
        )}
      </div>
    </AdminShell>
  );
}
