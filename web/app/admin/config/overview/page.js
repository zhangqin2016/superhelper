import { AdminShell } from "../../../../components/admin-shell";
import { ConfigAdminNav } from "../../../../components/config-admin-nav";
import { ConfigCenterPanels } from "../../../../components/config-center-panels";
import { safeApiGet } from "../../../../lib/api";
import { getI18n } from "../../../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

export default async function ConfigOverviewPage({ searchParams }) {
  const params = await searchParams;
  const deviceId = String(params?.deviceId || "").trim();
  const licenseId = String(params?.licenseId || "").trim();
  const { locale, t } = await getI18n();
  const labels = t.admin.configTabs;
  const previewQuery = new URLSearchParams();
  if (deviceId) previewQuery.set("deviceId", deviceId);
  if (licenseId) previewQuery.set("licenseId", licenseId);
  const [data, health, preview] = await Promise.all([
    safeApiGet("/api/admin/config-profiles", { profiles: [] }),
    safeApiGet("/api/admin/health", { checks: [], runtime: {}, status: "unknown" }),
    safeApiGet(`/api/admin/config-profiles/effective-preview${previewQuery.size ? `?${previewQuery.toString()}` : ""}`, null),
  ]);

  return (
    <AdminShell title={t.admin.configCenter.title} subtitle={t.admin.configCenter.subtitle}>
      <ConfigAdminNav labels={labels} />
      <ConfigCenterPanels
        rows={data.profiles || []}
        health={health}
        preview={preview}
        locale={locale}
        deviceId={deviceId}
        licenseId={licenseId}
      />
    </AdminShell>
  );
}
