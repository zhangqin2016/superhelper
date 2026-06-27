import { AdminShell } from "../../../components/admin-shell";
import { AdminEmpty } from "../../../components/admin-empty";
import { Badge } from "../../../components/ui/badge";
import { safeApiGet } from "../../../lib/api";
import { getI18n } from "../../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

function hasMeta(value) {
  if (!value) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return Object.keys(value).length > 0;
}

function metaText(value) {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

export default async function AuditPage() {
  const { t } = await getI18n();
  const c = t.admin.audit;
  const data = await safeApiGet("/api/admin/audit-logs", { logs: [] });
  const rows = data.logs || [];
  return (
    <AdminShell title={t.admin.pages.audit[0]} subtitle={t.admin.pages.audit[1]}>
      <div className="table-card p-6">
        {rows.length ? (
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-500">
              <tr>{[c.time, c.actor, c.action, c.target, c.ip, c.metadata].map((h) => <th key={h} className="px-5 py-4">{h}</th>)}</tr>
            </thead>
            <tbody>{rows.map((row) => (
              <tr key={row.id} className="border-t border-slate-100 align-top">
                <td className="px-5 py-4">{row.created_at ? new Date(row.created_at).toLocaleString() : "-"}</td>
                <td className="px-5 py-4">{row.actor}</td>
                <td className="px-5 py-4"><Badge variant="brand">{row.action}</Badge></td>
                <td className="px-5 py-4 font-mono">{row.target_type}:{row.target_id || "-"}</td>
                <td className="px-5 py-4">{row.ip || "-"}</td>
                <td className="max-w-[360px] px-5 py-4 text-xs text-slate-500">
                  {hasMeta(row.metadata) ? (
                    <details>
                      <summary className="cursor-pointer font-semibold text-brand">{c.viewMeta}</summary>
                      <pre className="mt-2 max-h-72 overflow-auto rounded-lg bg-slate-950 p-3 text-xs text-slate-100">{metaText(row.metadata)}</pre>
                    </details>
                  ) : "-"}
                </td>
              </tr>
            ))}</tbody>
          </table>
        ) : <AdminEmpty title={t.admin.pages.audit[0]} description={t.admin.pages.audit[1]} />}
      </div>
    </AdminShell>
  );
}
