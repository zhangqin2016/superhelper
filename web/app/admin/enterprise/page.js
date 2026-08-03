import Link from "next/link";
import { AdminShell } from "../../../components/admin-shell";
import { safeApiGet } from "../../../lib/api";
import { getI18n } from "../../../lib/i18n.mjs";
import { toggleOrgStatusAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function AdminEnterprisePage() {
  const { t } = await getI18n();
  const data = await safeApiGet("/api/admin/enterprise/organizations", { organizations: [] });
  const orgs = Array.isArray(data?.organizations) ? data.organizations : [];
  return (
    <AdminShell title={t.admin.pages.enterprise?.[0] || "Enterprise"} subtitle={t.admin.pages.enterprise?.[1] || "Manage organizations, quotas, and usage"}>
      <div className="table-card p-6">
        {orgs.length === 0 ? (
          <p className="text-sm text-slate-500">No organizations yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-500">
                <th className="py-2 pr-4">Name</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2 pr-4">Members</th>
                <th className="py-2 pr-4">Created</th>
                <th className="py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {orgs.map((org) => (
                <tr key={org.id} className="border-t border-slate-100">
                  <td className="py-3 pr-4 font-medium">{org.name}</td>
                  <td className="py-3 pr-4">{org.status === "active" ? "Active" : "Disabled"}</td>
                  <td className="py-3 pr-4">{Number(org.member_count || 0)}</td>
                  <td className="py-3 pr-4">{String(org.created_at || "").slice(0, 10)}</td>
                  <td className="py-3">
                    <div className="flex items-center gap-2">
                      <Link href={`/admin/enterprise/${org.id}`} className="rounded-lg bg-slate-100 px-3 py-1.5 text-slate-700 hover:bg-slate-200">Open</Link>
                      <form action={toggleOrgStatusAction.bind(null, org.id)}>
                        <input type="hidden" name="status" value={org.status === "active" ? "disabled" : "active"} />
                        <button type="submit" className={`rounded-lg px-3 py-1.5 ${org.status === "active" ? "bg-red-50 text-red-600 hover:bg-red-100" : "bg-emerald-50 text-emerald-600 hover:bg-emerald-100"}`}>
                          {org.status === "active" ? "Disable" : "Enable"}
                        </button>
                      </form>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </AdminShell>
  );
}
