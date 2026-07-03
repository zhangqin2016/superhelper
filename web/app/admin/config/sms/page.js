import { AdminShell } from "../../../../components/admin-shell";
import { ConfigAdminNav } from "../../../../components/config-admin-nav";
import { SmsSettingsPanel } from "../../../../components/config-basics-panel";
import { safeApiGet } from "../../../../lib/api";
import { getI18n } from "../../../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

export default async function ConfigSmsPage() {
  const { t } = await getI18n();
  const data = await safeApiGet("/api/admin/settings", { settings: { licenseTrialDays: 3, qiniu: {} } });

  return (
    <AdminShell title={t.admin.configTabs.sms || "短信登录"} subtitle={t.admin.configCenter.subtitle}>
      <ConfigAdminNav labels={t.admin.configTabs} />
      <SmsSettingsPanel settings={data.settings || {}} t={t} />
    </AdminShell>
  );
}
