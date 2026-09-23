import Link from "next/link";
import { AdminShell } from "../../../components/admin-shell";
import { AdminEmpty } from "../../../components/admin-empty";
import { Badge } from "../../../components/ui/badge";
import { loadAdmin } from "../../../lib/api";
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
  const data = await loadAdmin(`/api/admin/users?${queryString(filters)}`, { users: [], stats: {} });
  const users = data.users || [];
  const stats = data.stats || {};
  // With no order anywhere, paid/orders/revenue are three zeros on every row —
  // noise that pushes the columns people read off screen. They appear the day
  // the first order does.
  const billing = Number(stats.paidOrders || 0) > 0 || users.some((user) => Number(user.orderCount || 0) > 0);
  const BILLING_COLUMNS = [4, 5];
  const headers = c.table.filter((_, index) => billing || !BILLING_COLUMNS.includes(index));

  return (
    <AdminShell title={t.admin.pages.users[0]} subtitle={t.admin.pages.users[1]}>
      <div className={`grid shrink-0 gap-4 md:grid-cols-3 ${billing ? "xl:grid-cols-6" : ""}`}>
        {[
          [c.stats[0], fmt(stats.totalUsers, locale)],
          [c.stats[1], fmt(stats.activeUsers, locale)],
          [c.stats[2], fmt(stats.usersToday, locale)],
          ...(billing ? [
            [c.stats[3], fmt(stats.paidUsers, locale)],
            [c.stats[4], fmt(stats.paidOrders, locale)],
            [c.stats[5], money(stats.revenueCents)],
          ] : []),
        ].map(([label, value]) => (
          <div key={label} className="metric-card rounded-xl px-5 py-3">
            <div className="font-mono text-2xl font-semibold">{value}</div>
            <div className="mt-2 text-sm text-slate-500">{label}</div>
          </div>
        ))}
      </div>

      <form className="table-card my-4 grid shrink-0 gap-4 px-5 py-3 lg:grid-cols-[1fr_160px_120px_120px]">
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

      <div className="table-card p-4">
        {users.length ? (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  {headers.map((header) => (
                    <th key={header} className="px-4 py-2">{header}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id} className="border-t border-slate-100">
                    <td className="px-4 py-2">
                      <Link href={`/admin/users/${user.id}`} className="font-semibold text-brand hover:underline">{user.phoneMasked || user.phoneE164}</Link>
                      <div className="mt-1 font-mono text-xs text-slate-400">{user.id}</div>
                    </td>
                    <td className="px-4 py-2"><Badge variant={user.status === "active" ? "success" : "danger"}>{user.status === "active" ? c.filters.active : user.status === "disabled" ? c.filters.disabled : user.status}</Badge></td>
                    <td className="px-4 py-2">{date(user.createdAt, locale)}</td>
                    <td className="px-4 py-2">{date(user.lastLoginAt, locale)}</td>
                    {billing ? <td className="px-4 py-2 tabular-nums">{fmt(user.paidOrderCount, locale)} / {fmt(user.orderCount, locale)}</td> : null}
                    {billing ? <td className="px-4 py-2 tabular-nums">{money(user.totalPaidCents)}</td> : null}
                    <td className="px-4 py-2">
                      <div>Token {fmt(user.tokenRemaining, locale)}</div>
                      <div className="text-xs text-slate-500">{c.image} {fmt(user.imageRemaining, locale)} · {c.video} {fmt(user.videoRemaining, locale)}</div>
                    </td>
                    <td className="px-4 py-2">{fmt(user.activeSessionCount, locale)}</td>
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
