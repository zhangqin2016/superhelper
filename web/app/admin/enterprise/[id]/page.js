import Link from "next/link";
import IssuedCredentials from "../../../../components/issued-credentials";
import { AdminShell } from "../../../../components/admin-shell";
import { safeApiGet } from "../../../../lib/api";
import { getI18n } from "../../../../lib/i18n.mjs";
import { adjustOrgGrantAction, toggleOrgStatusAction } from "../actions";

export const dynamic = "force-dynamic";

function fmt(value) {
  return Number(value || 0).toLocaleString("en-US");
}

export default async function AdminOrgDetailPage({ params }) {
  const { id } = await params;
  const { t } = await getI18n();
  const org = await safeApiGet(`/api/admin/enterprise/organizations/${id}`, null);
  if (!org?.id) return <AdminShell title="Enterprise">
      <IssuedCredentials /><p className="text-sm text-slate-500">Organization not found.</p></AdminShell>;
  const usage = await safeApiGet(`/api/admin/enterprise/organizations/${id}/usage?days=30`, { usage: { byMember: [], byModel: [] } });
  const byMember = usage?.usage?.byMember || [];
  return (
    <AdminShell title={org.name} subtitle={`Status: ${org.status}`}>
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="table-card p-6">
          <h2 className="mb-3 font-medium">Quota transfer</h2>
          <form action={adjustOrgGrantAction.bind(null, id)} className="grid gap-3">
            <select name="resourceType" defaultValue="token" className="rounded-lg border border-slate-200 px-3 py-2 text-sm">
              <option value="token">Token</option>
              <option value="image_generation">Image generation</option>
              <option value="video_generation">Video generation</option>
            </select>
            <input name="unitTotal" type="number" min={1} required placeholder="Units" className="rounded-lg border border-slate-200 px-3 py-2 text-sm" />
            <input name="expiresDays" type="number" min={1} max={3650} defaultValue={365} className="rounded-lg border border-slate-200 px-3 py-2 text-sm" />
            <button type="submit" className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700">Transfer</button>
          </form>
        </section>
        <section className="table-card p-6">
          <h2 className="mb-3 font-medium">Org status</h2>
          <p className="mb-3 text-sm text-slate-600">Disabling blocks org-pool consumption (members keep personal grants).</p>
          <form action={toggleOrgStatusAction.bind(null, id)}>
            <input type="hidden" name="status" value={org.status === "active" ? "disabled" : "active"} />
            <button type="submit" className="rounded-lg bg-red-50 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-100">
              {org.status === "active" ? "Disable org" : "Enable org"}
            </button>
          </form>
        </section>
      </div>
      <section className="table-card mt-4 p-6">
        <h2 className="mb-3 font-medium">Usage by member (30d)</h2>
        {byMember.length === 0 ? (
          <p className="text-sm text-slate-500">No usage yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead><tr className="text-left text-slate-500"><th className="py-2 pr-4">User</th><th className="py-2">Units</th></tr></thead>
            <tbody>
              {byMember.map((row) => (
                <tr key={row.user_id} className="border-t border-slate-100">
                  <td className="py-2">{row.user_id}</td>
                  <td className="py-2">{fmt(row.units)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </AdminShell>
  );
}
