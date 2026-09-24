import { AdminShell } from "../../../../components/admin-shell";
import { ConfigAdminNav } from "../../../../components/config-admin-nav";
import { SmsSettingsPanel } from "../../../../components/config-basics-panel";
import { loadAdmin } from "../../../../lib/api";
import { getI18n } from "../../../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

export default async function ConfigSmsPage() {
  const { t } = await getI18n();
  const data = await loadAdmin("/api/admin/settings", { settings: { licenseTrialDays: 3, qiniu: {} } });

  return (
    <AdminShell title={t.admin.configTabs.sms || "短信登录"} subtitle={t.admin.configPurpose.sms}>
      <ConfigAdminNav labels={t.admin.configTabs} current="sms" />
      <SmsSettingsPanel settings={data.settings || {}} t={t} />
    </AdminShell>
  );
}
