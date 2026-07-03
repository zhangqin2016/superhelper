import { AdminShell } from "../../../../components/admin-shell";
import { ConfigAdminNav } from "../../../../components/config-admin-nav";
import { QiniuSettingsPanel } from "../../../../components/config-basics-panel";
import { safeApiGet } from "../../../../lib/api";
import { getI18n } from "../../../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

export default async function ConfigStoragePage() {
  const { t } = await getI18n();
  const data = await safeApiGet("/api/admin/settings", { settings: { licenseTrialDays: 3, qiniu: {} } });

  return (
    <AdminShell title={t.admin.configTabs.storage || "对象存储"} subtitle={t.admin.configCenter.subtitle}>
      <ConfigAdminNav labels={t.admin.configTabs} />
      <QiniuSettingsPanel settings={data.settings || {}} t={t} />
    </AdminShell>
  );
}
