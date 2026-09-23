import Link from "next/link";
import { AdminShell } from "../../../components/admin-shell";
import { AdminEmpty } from "../../../components/admin-empty";
import { ListFilter } from "../../../components/list-filter";
import { Pagination } from "../../../components/pagination";
import { loadAdmin } from "../../../lib/api";
import { getI18n } from "../../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

const DAY_WINDOWS = ["1", "7", "30", "90"];
const SEVERITIES = ["error", "warning", "info"];

function readFilters(params = {}) {
  return {
    days: DAY_WINDOWS.includes(params.days) ? params.days : "7",
    kind: String(params.kind || "").trim(),
    severity: SEVERITIES.includes(params.severity) ? params.severity : "",
    deviceId: String(params.deviceId || "").trim(),
    cursor: String(params.cursor || ""),
  };
}

function hrefWith(filters, patch) {
  const next = { ...filters, cursor: "", ...patch };
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(next)) if (value) params.set(key, value);
  return `/admin/diagnostics?${params}`;
}

function fmtDate(value, locale) {
  if (!value) return "-";
  return new Date(value).toLocaleString(locale === "zh" ? "zh-CN" : locale, { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function severityClass(value) {
  if (value === "error") return "bg-rose-50 text-rose-700";
  if (value === "info") return "bg-slate-100 text-slate-600";
  return "bg-amber-50 text-amber-700";
}

// dev_5a2b5f4e-4b7a-4311-b447-2602b0cb1631 → dev_5a2b5f4e: enough to tell
// machines apart in a column, the full id is on hover and one click away.
function shortDevice(id) {
  const value = String(id || "");
  return value.length > 14 ? `${value.slice(0, 12)}…` : value || "-";
}

export default async function DiagnosticsPage({ searchParams }) {
  const { locale, t } = await getI18n();
  const params = (await searchParams) || {};
  const filters = readFilters(params);
  const query = new URLSearchParams();
  for (const key of ["days", "kind", "severity", "deviceId", "cursor"]) if (filters[key]) query.set(key, filters[key]);
  const data = await loadAdmin(`/api/admin/diagnostics?${query}`, { diagnostics: [], byKind: [], nextCursor: "", total: null });
  const rows = data.diagnostics || [];
  const c = t.admin.diag;

  // One row per kind, severities folded in: the ranking answers "what is
  // failing, and on how many machines", not "which kind/severity pair".
  const kinds = new Map();
  for (const item of data.byKind || []) {
    const entry = kinds.get(item.kind) || { kind: item.kind, count: 0, devices: 0, severity: item.severity };
    entry.count += Number(item.count || 0);
    entry.devices = Math.max(entry.devices, Number(item.devices || 0));
    if (item.severity === "error") entry.severity = "error";
    kinds.set(item.kind, entry);
  }
  const ranking = [...kinds.values()].sort((a, b) => b.count - a.count);
  const top = ranking[0]?.count || 1;
  const filtering = Boolean(filters.kind || filters.severity || filters.deviceId);

  return (
    <AdminShell title={t.admin.pages.diagnostics[0]} subtitle={t.admin.pages.diagnostics[1]}>
      <div className="mb-1 flex flex-wrap items-center gap-x-6">
        <ListFilter
          basePath="/admin/diagnostics"
          searchParams={params}
          param="days"
          value={filters.days}
          label={c.window}
          options={DAY_WINDOWS.map((value) => ({ value, label: c.windowDays.replace("{n}", value) }))}
        />
        <ListFilter
          basePath="/admin/diagnostics"
          searchParams={params}
          param="severity"
          value={filters.severity || "all"}
          label={c.severity}
          options={[{ value: "", label: c.all }, ...SEVERITIES.map((value) => ({ value, label: c.severities[value] }))].map((option) => ({ ...option, value: option.value || "all" }))}
        />
        <form action="/admin/diagnostics" className="mb-3 flex items-center gap-2 text-sm">
          {["days", "kind", "severity"].map((key) => (filters[key] ? <input key={key} type="hidden" name={key} value={filters[key]} /> : null))}
          <input name="deviceId" defaultValue={filters.deviceId} placeholder={c.devicePlaceholder} className="w-64 rounded-lg border border-slate-300 px-3 py-1.5 font-mono text-xs" />
          <button className="rounded-lg border border-slate-300 px-3 py-1.5 font-medium hover:bg-slate-50">{c.apply}</button>
        </form>
        {filtering ? <Link href={hrefWith({ days: filters.days }, {})} className="mb-3 text-sm text-brand hover:underline">{c.clear}</Link> : null}
      </div>

      {ranking.length ? (
        <div className="table-card mb-4 p-4">
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-slate-900">{c.byKind}</h2>
            <span className="text-xs text-slate-500">{c.byKindHint}</span>
          </div>
          <div className="grid gap-x-8 gap-y-1 md:grid-cols-2">
            {ranking.slice(0, 10).map((item) => {
              const active = filters.kind === item.kind;
              return (
                <Link
                  key={item.kind}
                  href={hrefWith(filters, { kind: active ? "" : item.kind })}
                  aria-current={active ? "true" : undefined}
                  className={`grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 rounded-md px-2 py-1 text-sm hover:bg-slate-50 ${active ? "bg-slate-100" : ""}`}
                >
                  <span className="min-w-0">
                    <span className="flex items-center gap-2">
                      <span className={`h-2 w-2 shrink-0 rounded-full ${item.severity === "error" ? "bg-rose-500" : "bg-amber-400"}`} />
                      <span className="truncate font-mono text-xs text-slate-800" title={item.kind}>{item.kind}</span>
                    </span>
                    <span className="mt-1 block h-1 rounded bg-slate-100">
                      <span className="block h-1 rounded bg-slate-400" style={{ width: `${Math.max(2, Math.round((item.count / top) * 100))}%` }} />
                    </span>
                  </span>
                  <span className="tabular-nums font-semibold text-slate-900">{item.count.toLocaleString("en-US")}</span>
                  <span className="w-20 text-right text-xs tabular-nums text-slate-500">{c.onDevices.replace("{n}", String(item.devices))}</span>
                </Link>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="table-card p-4">
        {rows.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[880px] table-fixed text-left text-sm">
              <colgroup>
                <col className="w-[104px]" />
                <col className="w-[84px]" />
                <col className="w-[270px]" />
                <col />
                <col className="w-[200px]" />
                <col className="w-[64px]" />
              </colgroup>
              <thead className="bg-slate-50 text-slate-500">
                <tr>{[c.time, c.severity, c.kind, c.summary, c.device, ""].map((h, i) => <th key={`${h}-${i}`} className="px-3 py-2 font-medium">{h}</th>)}</tr>
              </thead>
              <tbody>{rows.map((row) => (
                <tr key={row.id} className="border-t border-slate-100 align-top">
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums text-slate-500">{fmtDate(row.created_at, locale)}</td>
                  <td className="px-3 py-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${severityClass(row.severity)}`}>{c.severities[row.severity] || row.severity}</span>
                  </td>
                  <td className="px-3 py-2">
                    <Link href={hrefWith(filters, { kind: row.normalized_kind || "" })} className="block truncate font-mono text-xs text-slate-800 hover:text-brand" title={row.normalized_kind || ""}>{row.normalized_kind || "-"}</Link>
                    {row.turn_phase ? <div className="truncate text-xs text-slate-400">{row.turn_phase}</div> : null}
                  </td>
                  <td className="px-3 py-2">
                    <div className="line-clamp-2 break-words text-slate-700" title={row.summary || ""}>{row.summary || "-"}</div>
                  </td>
                  <td className="px-3 py-2">
                    <Link href={hrefWith(filters, { deviceId: row.device_id })} className="block truncate font-mono text-xs text-slate-800 hover:text-brand" title={row.device_id}>{shortDevice(row.device_id)}</Link>
                    <div className="truncate text-xs text-slate-400">{[row.platform, row.arch].filter(Boolean).join("-")}{row.app_version ? ` · ${row.app_version}` : ""}</div>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Link href={`/admin/diagnostics/${row.id}`} className="text-xs font-semibold text-brand hover:underline">{c.trace}</Link>
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : <AdminEmpty title={c.emptyTitle} description={c.emptyDesc} />}
      </div>
      <Pagination
        basePath="/admin/diagnostics"
        searchParams={params}
        shown={rows.length}
        total={data.total ?? null}
        nextCursor={data.nextCursor || ""}
        cursor={filters.cursor}
        copy={t.admin.paging}
      />
    </AdminShell>
  );
}
