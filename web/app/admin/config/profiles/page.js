import { AdminShell } from "../../../../components/admin-shell";
import { AdminEmpty } from "../../../../components/admin-empty";
import { AdminPageActions } from "../../../../components/admin-page-actions";
import { ConfigAdminNav } from "../../../../components/config-admin-nav";
import { ConfigProfilesTable } from "../../../../components/admin-tables";
import { safeApiGet } from "../../../../lib/api";
import { getI18n } from "../../../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

export default async function ConfigProfilesPage() {
  const { t } = await getI18n();
  const copy = t.admin.configProfiles;
  const data = await safeApiGet("/api/admin/config-profiles", { profiles: [] });

  return (
    <AdminShell title={t.admin.configTabs.profiles} subtitle={t.admin.configCenter.subtitle}>
      <ConfigAdminNav labels={t.admin.configTabs} />
      <AdminPageActions actions={[{ href: "/admin/config/profiles/new", label: "新增下发规则", variant: "primary" }]} />
      <ConfigProfilesTable rows={data.profiles || []} empty={<AdminEmpty title={copy.title} description={copy.subtitle} />} />
    </AdminShell>
  );
}
