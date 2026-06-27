import { AdminShell } from "../../../components/admin-shell";
import { AdminEmpty } from "../../../components/admin-empty";
import { ConfigBasicsPanel } from "../../../components/config-basics-panel";
import { ConfigCenterPanels } from "../../../components/config-center-panels";
import { ConfigGroupsPanel } from "../../../components/config-groups-panel";
import { ConfigProfileForm } from "../../../components/config-profile-form";
import { ModelProvidersPanel } from "../../../components/model-providers-panel";
import { ConfigProfilesTable } from "../../../components/admin-tables";
import { ConfigTabs } from "../../../components/config-tabs";
import { safeApiGet } from "../../../lib/api";
import { getI18n } from "../../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

export default async function ConfigProfilesPage({ searchParams }) {
  const params = await searchParams;
  const deviceId = String(params?.deviceId || "").trim();
  const licenseId = String(params?.licenseId || "").trim();
  const { locale, t } = await getI18n();
  const copy = t.admin.configProfiles;
  const center = t.admin.configCenter;
  const labels = t.admin.configTabs;
  const previewQuery = new URLSearchParams();
  if (deviceId) previewQuery.set("deviceId", deviceId);
  if (licenseId) previewQuery.set("licenseId", licenseId);
  const [data, health, preview, groupsData, providersData, settingsData, skillsData] = await Promise.all([
    safeApiGet("/api/admin/config-profiles", { profiles: [] }),
    safeApiGet("/api/admin/health", { checks: [], runtime: {}, status: "unknown" }),
    safeApiGet(
      `/api/admin/config-profiles/effective-preview${previewQuery.size ? `?${previewQuery.toString()}` : ""}`,
      null,
    ),
    safeApiGet("/api/admin/config-groups", { groups: [] }),
    safeApiGet("/api/admin/model-providers", { providers: [] }),
    safeApiGet("/api/admin/settings", { settings: { licenseTrialDays: 3, qiniu: {} } }),
    safeApiGet("/api/admin/skill-packages", { skillPackages: [] }),
  ]);
  const rows = data.profiles || [];
  const settings = settingsData.settings || { licenseTrialDays: 3, qiniu: {} };
  const skillPackageOptions = [
    ...new Map((skillsData.skillPackages || []).map((s) => [String(s.skill_id || ""), { id: String(s.skill_id || ""), label: String(s.name || s.skill_id || "") }])).values(),
  ].filter((o) => o.id);

  const tabs = [
    {
      id: "basics",
      label: labels.basics,
      node: <ConfigBasicsPanel settings={settings} t={t} />,
    },
    {
      id: "overview",
      label: labels.overview,
      node: (
        <ConfigCenterPanels
          rows={rows}
          health={health}
          preview={preview}
          locale={locale}
          deviceId={deviceId}
          licenseId={licenseId}
        />
      ),
    },
    {
      id: "providers",
      label: labels.providers,
      node: <ModelProvidersPanel providers={providersData.providers || []} />,
    },
    {
      id: "profiles",
      label: labels.profiles,
      node: (
        <>
          <ConfigProfileForm providers={providersData.gateway || []} skillPackageOptions={skillPackageOptions} />
          <ConfigProfilesTable rows={rows} empty={<AdminEmpty title={copy.title} description={copy.subtitle} />} />
        </>
      ),
    },
    {
      id: "groups",
      label: labels.groups,
      node: <ConfigGroupsPanel groups={groupsData.groups || []} />,
    },
  ];

  return (
    <AdminShell title={center.title} subtitle={center.subtitle}>
      <ConfigTabs tabs={tabs} />
    </AdminShell>
  );
}
