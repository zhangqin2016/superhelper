import { AdminShell } from "../../../components/admin-shell";
import { AdminEmpty } from "../../../components/admin-empty";
import { safeApiGet } from "../../../lib/api";
import { getI18n } from "../../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

function queryString(searchParams = {}) {
  const params = new URLSearchParams();
  params.set("days", searchParams.days || "30");
  for (const key of ["deviceId", "kind", "severity"]) {
    if (searchParams[key]) params.set(key, searchParams[key]);
  }
  return params.toString();
}

function fmtDate(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function severityClass(value) {
  if (value === "error") return "bg-rose-50 text-rose-700";
  if (value === "info") return "bg-slate-100 text-slate-600";
  return "bg-amber-50 text-amber-700";
}

export default async function DiagnosticsPage({ searchParams }) {
  const { t } = await getI18n();
  const filters = await searchParams;
  const data = await safeApiGet(`/api/admin/diagnostics?${queryString(filters)}`, {
    diagnostics: [],
    byKind: [],
  });
  const rows = data.diagnostics || [];
  const summary = data.byKind || [];
  const c = t.admin.diag;

  return (
    <AdminShell title={t.admin.pages.diagnostics[0]} subtitle={t.admin.pages.diagnostics[1]}>
      <form className="table-card mb-6 grid gap-4 p-6 lg:grid-cols-5">
        <label className="grid gap-2 text-sm font-medium text-slate-600">
          {c.days}
          <input name="days" defaultValue={filters?.days || "30"} className="rounded-lg border border-slate-200 px-3 py-2" />
        </label>
        <label className="grid gap-2 text-sm font-medium text-slate-600">
          {c.device}
          <input name="deviceId" defaultValue={filters?.deviceId || ""} className="rounded-lg border border-slate-200 px-3 py-2" />
        </label>
        <label className="grid gap-2 text-sm font-medium text-slate-600">
          {c.kind}
          <input name="kind" defaultValue={filters?.kind || ""} className="rounded-lg border border-slate-200 px-3 py-2" />
        </label>
        <label className="grid gap-2 text-sm font-medium text-slate-600">
          {c.severity}
          <input name="severity" defaultValue={filters?.severity || ""} className="rounded-lg border border-slate-200 px-3 py-2" />
        </label>
        <div className="flex items-end">
          <button className="rounded-lg bg-brand px-5 py-2.5 font-semibold text-white">{c.apply}</button>
        </div>
      </form>

      <div className="grid gap-5 lg:grid-cols-3">
        {summary.slice(0, 6).map((item) => (
          <div key={`${item.kind}-${item.severity}`} className="metric-card rounded-xl p-5">
            <div className="font-mono text-3xl font-semibold">{Number(item.count || 0).toLocaleString("en-US")}</div>
            <div className="mt-2 text-slate-500">{item.kind}</div>
            <div className={`mt-3 inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${severityClass(item.severity)}`}>
              {item.severity}
            </div>
          </div>
        ))}
      </div>

      <div className="table-card mt-6 p-6">
        <h2 className="mb-5 text-xl font-semibold">{c.traces}</h2>
        {rows.length ? (
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-500">
              <tr>{[c.time, c.severity, c.kind, c.event, c.device, c.app, c.claude, c.summary].map((h) => <th key={h} className="px-5 py-4">{h}</th>)}</tr>
            </thead>
            <tbody>{rows.map((row) => (
              <tr key={row.id} className="border-t border-slate-100 align-top">
                <td className="whitespace-nowrap px-5 py-4">{fmtDate(row.created_at)}</td>
                <td className="px-5 py-4">
                  <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${severityClass(row.severity)}`}>{row.severity}</span>
                </td>
                <td className="px-5 py-4 font-mono text-xs">{row.normalized_kind || "-"}</td>
                <td className="px-5 py-4 font-mono text-xs">{row.event_type || "-"}{row.event_subtype ? `/${row.event_subtype}` : ""}</td>
                <td className="px-5 py-4 font-mono text-xs">{row.device_id}</td>
                <td className="px-5 py-4">{row.app_version || "-"}</td>
                <td className="px-5 py-4">{row.claude_version || "-"}</td>
                <td className="max-w-md px-5 py-4">
                  <div>{row.summary || "-"}</div>
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs font-semibold text-brand">{c.trace}</summary>
                    <pre className="mt-2 max-h-72 overflow-auto rounded-lg bg-slate-950 p-3 text-xs text-slate-100">
                      {JSON.stringify(row.trace || {}, null, 2)}
                    </pre>
                  </details>
                </td>
              </tr>
            ))}</tbody>
          </table>
        ) : <AdminEmpty title={c.emptyTitle} description={c.emptyDesc} />}
      </div>
    </AdminShell>
  );
}
