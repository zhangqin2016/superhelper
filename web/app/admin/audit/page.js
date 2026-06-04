import { AdminShell } from "../../../components/admin-shell";
import { AdminEmpty } from "../../../components/admin-empty";
import { Badge } from "../../../components/ui/badge";
import { safeApiGet } from "../../../lib/api";
import { getI18n } from "../../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

function shortJson(value) {
  if (!value) return "{}";
  if (typeof value === "string") return value.length > 160 ? `${value.slice(0, 160)}...` : value;
  const text = JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 160)}...` : text;
}

export default async function AuditPage() {
  const { t } = await getI18n();
  const data = await safeApiGet("/api/admin/audit-logs", { logs: [] });
  const rows = data.logs || [];
  return (
    <AdminShell title={t.admin.pages.audit[0]} subtitle={t.admin.pages.audit[1]}>
      <div className="table-card p-6">
        {rows.length ? (
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-500">
              <tr>{["Time", "Actor", "Action", "Target", "IP", "Metadata"].map((h) => <th key={h} className="px-5 py-4">{h}</th>)}</tr>
            </thead>
            <tbody>{rows.map((row) => (
              <tr key={row.id} className="border-t border-slate-100 align-top">
                <td className="px-5 py-4">{row.created_at ? new Date(row.created_at).toLocaleString() : "-"}</td>
                <td className="px-5 py-4">{row.actor}</td>
                <td className="px-5 py-4"><Badge variant="brand">{row.action}</Badge></td>
                <td className="px-5 py-4 font-mono">{row.target_type}:{row.target_id || "-"}</td>
                <td className="px-5 py-4">{row.ip || "-"}</td>
                <td className="max-w-[360px] px-5 py-4 font-mono text-xs text-slate-500">{shortJson(row.metadata)}</td>
              </tr>
            ))}</tbody>
          </table>
        ) : <AdminEmpty title={t.admin.pages.audit[0]} description={t.admin.pages.audit[1]} />}
      </div>
    </AdminShell>
  );
}
