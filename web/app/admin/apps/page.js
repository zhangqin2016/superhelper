import { AdminShell } from "../../../components/admin-shell";
import { AdminEmpty } from "../../../components/admin-empty";
import { AdminPageActions } from "../../../components/admin-page-actions";
import { WorkspaceAppsTable } from "../../../components/admin-tables";
import { safeApiGet } from "../../../lib/api";
import { getI18n } from "../../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

export default async function AppsPage() {
  const { t } = await getI18n();
  const data = await safeApiGet("/api/admin/workspace-apps", { workspaceApps: [] });
  const apps = data.workspaceApps || [];

  return (
    <AdminShell title={t.admin.pages.apps[0]} subtitle={t.admin.pages.apps[1]}>
      <AdminPageActions actions={[{ href: "/admin/apps/new", label: "新增应用", variant: "primary" }]} />
      <WorkspaceAppsTable rows={apps} empty={<AdminEmpty title={t.admin.pages.apps[0]} description={t.admin.pages.apps[1]} />} />
    </AdminShell>
  );
}
