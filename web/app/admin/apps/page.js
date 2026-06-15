import { AdminShell } from "../../../components/admin-shell";
import { AdminEmpty } from "../../../components/admin-empty";
import { WorkspaceAppCreateForm } from "../../../components/workspace-app-create-form";
import { WorkspaceAppsTable } from "../../../components/admin-tables";
import { safeApiGet } from "../../../lib/api";
import { getI18n } from "../../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

export default async function WorkspaceAppsPage() {
  const { t } = await getI18n();
  const data = await safeApiGet("/api/admin/workspace-apps", { workspaceApps: [] });
  const rows = data.workspaceApps || [];
  return (
    <AdminShell title={t.admin.pages.apps[0]} subtitle={t.admin.pages.apps[1]}>
      <WorkspaceAppCreateForm />
      <WorkspaceAppsTable rows={rows} empty={<AdminEmpty title={t.admin.pages.apps[0]} description={t.admin.pages.apps[1]} />} />
    </AdminShell>
  );
}
