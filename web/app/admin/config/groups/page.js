import { AdminShell } from "../../../../components/admin-shell";
import { AdminPageActions } from "../../../../components/admin-page-actions";
import { ConfigAdminNav } from "../../../../components/config-admin-nav";
import { ConfigGroupsPanel } from "../../../../components/config-groups-panel";
import { safeApiGet } from "../../../../lib/api";
import { getI18n } from "../../../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

export default async function ConfigGroupsPage() {
  const { t } = await getI18n();
  const data = await safeApiGet("/api/admin/config-groups", { groups: [] });

  return (
    <AdminShell title={t.admin.configTabs.groups} subtitle={t.admin.configCenter.subtitle}>
      <ConfigAdminNav labels={t.admin.configTabs} />
      <AdminPageActions
        actions={[
          { href: "/admin/config/groups/new", label: "新增 / 更新设备组", variant: "primary" },
          { href: "/admin/config/groups/assign", label: "成员归组" },
        ]}
      />
      <ConfigGroupsPanel groups={data.groups || []} showCreate={false} showAssign={false} />
    </AdminShell>
  );
}
