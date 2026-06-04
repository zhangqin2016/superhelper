import { AdminShell } from "../../../components/admin-shell";
import { AdminEmpty } from "../../../components/admin-empty";
import { safeApiGet } from "../../../lib/api";
import { getI18n } from "../../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

function sum(rows, key) {
  return rows.reduce((total, row) => total + Number(row[key] || 0), 0);
}

function fmt(value) {
  return Number(value || 0).toLocaleString("en-US");
}

function queryString(searchParams = {}) {
  const params = new URLSearchParams();
  params.set("days", searchParams.days || "30");
  for (const key of ["licenseId", "deviceId", "model"]) {
    if (searchParams[key]) params.set(key, searchParams[key]);
  }
  return params.toString();
}

export default async function UsagePage({ searchParams }) {
  const { t } = await getI18n();
  const filters = await searchParams;
  const data = await safeApiGet(`/api/admin/usage?${queryString(filters)}`, { usage: [] });
  const rows = data.usage || [];
  return (
    <AdminShell title={t.admin.pages.usage[0]} subtitle={t.admin.pages.usage[1]}>
      <form className="table-card mb-6 grid gap-4 p-6 lg:grid-cols-5">
        <label className="grid gap-2 text-sm font-medium text-slate-600">
          Days
          <input name="days" defaultValue={filters?.days || "30"} className="rounded-lg border border-slate-200 px-3 py-2" />
        </label>
        <label className="grid gap-2 text-sm font-medium text-slate-600">
          License
          <input name="licenseId" defaultValue={filters?.licenseId || ""} className="rounded-lg border border-slate-200 px-3 py-2" />
        </label>
        <label className="grid gap-2 text-sm font-medium text-slate-600">
          Device
          <input name="deviceId" defaultValue={filters?.deviceId || ""} className="rounded-lg border border-slate-200 px-3 py-2" />
        </label>
        <label className="grid gap-2 text-sm font-medium text-slate-600">
          Model
          <input name="model" defaultValue={filters?.model || ""} className="rounded-lg border border-slate-200 px-3 py-2" />
        </label>
        <div className="flex items-end">
          <button className="rounded-lg bg-brand px-5 py-2.5 font-semibold text-white">Apply filters</button>
        </div>
      </form>
      <div className="grid gap-5 lg:grid-cols-3">
        {[
          ["Messages", sum(rows, "message_count")],
          ["Images", sum(rows, "image_count")],
          ["Tool calls", sum(rows, "tool_call_count")],
        ].map(([label, value]) => (
          <div key={label} className="metric-card rounded-xl p-5">
            <div className="font-mono text-3xl font-semibold">{fmt(value)}</div>
            <div className="mt-2 text-slate-500">{label}</div>
          </div>
        ))}
      </div>
      <div className="table-card mt-6 p-6">
        <h2 className="mb-5 text-xl font-semibold">Daily usage</h2>
        {rows.length ? (
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-500">
              <tr>{["Date", "Device", "Model", "Messages", "Images", "Tools", "Tokens"].map((h) => <th key={h} className="px-5 py-4">{h}</th>)}</tr>
            </thead>
            <tbody>{rows.map((row) => (
              <tr key={row.id} className="border-t border-slate-100">
                <td className="px-5 py-4">{String(row.usage_date).slice(0, 10)}</td>
                <td className="px-5 py-4 font-mono">{row.device_id}</td>
                <td className="px-5 py-4">{row.model}</td>
                <td className="px-5 py-4">{fmt(row.message_count)}</td>
                <td className="px-5 py-4">{fmt(row.image_count)}</td>
                <td className="px-5 py-4">{fmt(row.tool_call_count)}</td>
                <td className="px-5 py-4">{fmt(Number(row.input_tokens || 0) + Number(row.output_tokens || 0))}</td>
              </tr>
            ))}</tbody>
          </table>
        ) : <AdminEmpty title="No usage yet" description="Usage appears after clients report aggregated counts." />}
      </div>
    </AdminShell>
  );
}
