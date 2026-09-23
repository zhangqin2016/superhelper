import Link from "next/link";
import { AdminShell } from "../../../../components/admin-shell";
import { AdminEmpty } from "../../../../components/admin-empty";
import { loadAdmin } from "../../../../lib/api";
import { getI18n } from "../../../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

// The trace is the record: it was inlined into every row of the list (up to
// 40 KB each). It lives here, with everything needed to act on it.
export default async function DiagnosticDetailPage({ params }) {
  const { id } = await params;
  const { locale, t } = await getI18n();
  const c = t.admin.diag;
  const data = await loadAdmin(`/api/admin/diagnostics/${id}`, null);
  const row = data?.diagnostic;
  if (!row) {
    return (
      <AdminShell title={c.notFound} subtitle={id}>
        <AdminEmpty title={c.notFound} description={c.notFoundDesc} />
      </AdminShell>
    );
  }
  const fields = [
    [c.time, new Date(row.created_at).toLocaleString(locale === "zh" ? "zh-CN" : locale, { hour12: false })],
    [c.severity, c.severities[row.severity] || row.severity],
    [c.kind, <Link key="k" href={`/admin/diagnostics?kind=${encodeURIComponent(row.normalized_kind || "")}`} className="font-mono text-brand hover:underline">{row.normalized_kind || "-"}</Link>],
    [c.event, <span key="e" className="font-mono">{[row.event_type, row.event_subtype].filter(Boolean).join("/") || "-"}</span>],
    [c.phase, row.turn_phase || "-"],
    [c.sessionState, row.session_state || "-"],
    [c.device, <Link key="d" href={`/admin/devices/${row.device_id}`} className="break-all font-mono text-brand hover:underline">{row.device_id}</Link>],
    [t.admin.nav.licenses, row.license_id ? <Link key="l" href={`/admin/licenses/${row.license_id}`} className="font-mono text-brand hover:underline">{row.license_id}</Link> : "-"],
    [c.app, `${[row.platform, row.arch].filter(Boolean).join("-") || "-"} · ${row.app_version || "-"}`],
  ];
  return (
    <AdminShell title={row.normalized_kind || c.traces} subtitle={row.id}>
      <div className="mb-3 text-sm">
        <Link href="/admin/diagnostics" className="text-brand hover:underline">← {c.traces}</Link>
        <span className="mx-2 text-slate-300">|</span>
        <Link href={`/admin/diagnostics?deviceId=${encodeURIComponent(row.device_id)}&days=30`} className="text-brand hover:underline">{c.sameDevice}</Link>
      </div>
      <div className="table-card mb-4 p-5">
        <p className="mb-4 whitespace-pre-wrap break-words text-slate-800">{row.summary || "-"}</p>
        <dl className="grid gap-x-8 gap-y-2 text-sm md:grid-cols-3">
          {fields.map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="text-xs text-slate-500">{label}</dt>
              <dd className="truncate text-slate-900">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="table-card p-4">
        <h2 className="mb-2 text-sm font-semibold">{c.trace}</h2>
        <pre className="max-h-[calc(100vh-360px)] overflow-auto rounded-lg bg-slate-950 p-4 text-xs leading-5 text-slate-100">{JSON.stringify(row.trace || {}, null, 2)}</pre>
      </div>
    </AdminShell>
  );
}
