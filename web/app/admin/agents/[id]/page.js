import Link from "next/link";
import { AdminShell } from "../../../../components/admin-shell";
import { AdminEmpty } from "../../../../components/admin-empty";
import { AgentPackageForm } from "../../../../components/agent-package-form";
import { safeApiGet } from "../../../../lib/api";
import { getI18n } from "../../../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

// Edit = re-publish. The form is pre-filled from the stored row; saving upserts
// on (agentId, version, channel, scope), so keeping the version updates this
// publication in place and bumping it creates a new one (the registry serves
// the newest enabled version per agent per scope).
export default async function EditAgentPackagePage({ params }) {
  const { id } = await params;
  const { locale, t } = await getI18n();
  const zh = locale === "zh";
  const page = t.admin.pages.agents || ["Agents", ""];
  const data = await safeApiGet(`/api/admin/agent-packages/${id}`, null);
  const row = data?.agentPackage || null;

  if (!row) {
    return (
      <AdminShell title={zh ? "未找到该智能体发布" : "Agent package not found"} subtitle={id}>
        <div className="mb-5">
          <Link href="/admin/agents" className="text-sm font-semibold text-brand">{zh ? `返回${page[0]}列表` : `Back to ${page[0]}`}</Link>
        </div>
        <AdminEmpty
          title={zh ? "没有匹配的记录" : "No matching agent package"}
          description={zh ? "它可能已被删除，或服务端暂时不可用。" : "It may have been removed, or the API is unavailable."}
        />
      </AdminShell>
    );
  }

  return (
    <AdminShell title={`${row.agent_id} · ${row.version}`} subtitle={`${row.channel} · ${row.scope_type}${row.organization_id ? ` · ${row.organization_id}` : ""}`}>
      <div className="mb-5">
        <Link href="/admin/agents" className="text-sm font-semibold text-brand">{zh ? `返回${page[0]}列表` : `Back to ${page[0]}`}</Link>
      </div>
      <AgentPackageForm initial={row} />
    </AdminShell>
  );
}
