import { AdminShell } from "../../../../components/admin-shell";
import { ConfigAdminNav } from "../../../../components/config-admin-nav";
import { ConfigDeliveryPanel } from "../../../../components/config-basics-panel";
import { safeApiGet } from "../../../../lib/api";
import { getI18n } from "../../../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

export default async function ConfigSettingsPage() {
  const { t } = await getI18n();
  const data = await safeApiGet("/api/admin/settings", { settings: { licenseTrialDays: 3, qiniu: {} } });

  return (
    <AdminShell title={t.admin.configTabs.basics} subtitle={t.admin.configCenter.subtitle}>
      <ConfigAdminNav labels={t.admin.configTabs} />
      <ConfigDeliveryPanel settings={data.settings || {}} t={t} />
    </AdminShell>
  );
}
