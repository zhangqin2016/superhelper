import { AdminShell } from "../../../components/admin-shell";
import { AdminEmpty } from "../../../components/admin-empty";
import { AdminPageActions } from "../../../components/admin-page-actions";
import { AgentPackagesTable } from "../../../components/agent-packages-table";
import { loadAdmin } from "../../../lib/api";
import { getI18n } from "../../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

// 智能体分发 — sits in the distribution group next to 技能包 and mirrors that page:
// one list, one "new" action. Publications are keyed by (agentId, version,
// channel, scope); the table shows every row so an operator can see history and
// re-enable an older version if needed.
export default async function AgentPackagesPage() {
  const { locale, t } = await getI18n();
  const data = await loadAdmin("/api/admin/agent-packages", { agentPackages: [] });
  const rows = data.agentPackages || [];
  const page = t.admin.pages.agents || ["Agents", ""];
  const newLabel = locale === "zh" ? "发布智能体" : "Publish agent";

  return (
    <AdminShell title={page[0]} subtitle={page[1]}>
      <AdminPageActions actions={[{ href: "/admin/agents/new", label: newLabel, variant: "primary" }]} />
      <AgentPackagesTable rows={rows} empty={<AdminEmpty title={page[0]} description={page[1]} />} />
    </AdminShell>
  );
}
