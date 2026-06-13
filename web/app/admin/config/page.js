import { AdminShell } from "../../../components/admin-shell";
import { AdminEmpty } from "../../../components/admin-empty";
import { ConfigCenterPanels } from "../../../components/config-center-panels";
import { ConfigGroupsPanel } from "../../../components/config-groups-panel";
import { ConfigProfileForm } from "../../../components/config-profile-form";
import { ConfigProfilesTable } from "../../../components/admin-tables";
import { safeApiGet } from "../../../lib/api";
import { getI18n } from "../../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

export default async function ConfigProfilesPage({ searchParams }) {
  const params = await searchParams;
  const deviceId = String(params?.deviceId || "").trim();
  const licenseId = String(params?.licenseId || "").trim();
  const { locale, t } = await getI18n();
  const copy = t.admin.configProfiles;
  const previewQuery = new URLSearchParams();
  if (deviceId) previewQuery.set("deviceId", deviceId);
  if (licenseId) previewQuery.set("licenseId", licenseId);
  const [data, health, preview, groupsData] = await Promise.all([
    safeApiGet("/api/admin/config-profiles", { profiles: [] }),
    safeApiGet("/api/admin/health", { checks: [], runtime: {}, status: "unknown" }),
    safeApiGet(
      `/api/admin/config-profiles/effective-preview${previewQuery.size ? `?${previewQuery.toString()}` : ""}`,
      null,
    ),
    safeApiGet("/api/admin/config-groups", { groups: [] }),
  ]);
  const rows = data.profiles || [];
  return (
    <AdminShell title={copy.title} subtitle={copy.subtitle}>
      <ConfigCenterPanels rows={rows} health={health} preview={preview} locale={locale} deviceId={deviceId} licenseId={licenseId} />
      <ConfigGroupsPanel groups={groupsData.groups || []} />
      <ConfigProfileForm />
      <ConfigProfilesTable rows={rows} empty={<AdminEmpty title={copy.title} description={copy.subtitle} />} />
    </AdminShell>
  );
}
