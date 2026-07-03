import { AdminShell } from "../../../../components/admin-shell";
import { ConfigAdminNav } from "../../../../components/config-admin-nav";
import { PaymentSettingsPanel } from "../../../../components/config-basics-panel";
import { safeApiGet } from "../../../../lib/api";
import { getI18n } from "../../../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

export default async function ConfigPaymentPage() {
  const { t } = await getI18n();
  const data = await safeApiGet("/api/admin/settings", { settings: { licenseTrialDays: 3, qiniu: {} } });

  return (
    <AdminShell title={t.admin.configTabs.payment || "支付配置"} subtitle={t.admin.configCenter.subtitle}>
      <ConfigAdminNav labels={t.admin.configTabs} />
      <PaymentSettingsPanel settings={data.settings || {}} t={t} />
    </AdminShell>
  );
}
