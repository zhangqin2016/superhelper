import { AdminShell } from "../../../components/admin-shell";
import { AdminEmpty } from "../../../components/admin-empty";
import { ConfigCenterPanels } from "../../../components/config-center-panels";
import { ConfigGroupsPanel } from "../../../components/config-groups-panel";
import { ConfigProfileForm } from "../../../components/config-profile-form";
import { ModelProvidersPanel } from "../../../components/model-providers-panel";
import { ConfigProfilesTable } from "../../../components/admin-tables";
import { ConfigTabs } from "../../../components/config-tabs";
import { safeApiGet } from "../../../lib/api";
import { getI18n } from "../../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

const TAB_LABELS = {
  zh: { overview: "概览", providers: "模型供应商", profiles: "配置下发", groups: "档位组" },
  en: { overview: "Overview", providers: "Model providers", profiles: "Delivery", groups: "Tier groups" },
  ar: { overview: "نظرة عامة", providers: "المزوّدون", profiles: "الإرسال", groups: "المجموعات" },
};

export default async function ConfigProfilesPage({ searchParams }) {
  const params = await searchParams;
  const deviceId = String(params?.deviceId || "").trim();
  const licenseId = String(params?.licenseId || "").trim();
  const { locale, t } = await getI18n();
  const copy = t.admin.configProfiles;
  const labels = TAB_LABELS[locale] || TAB_LABELS.zh;
  const previewQuery = new URLSearchParams();
  if (deviceId) previewQuery.set("deviceId", deviceId);
  if (licenseId) previewQuery.set("licenseId", licenseId);
  const [data, health, preview, groupsData, providersData] = await Promise.all([
    safeApiGet("/api/admin/config-profiles", { profiles: [] }),
    safeApiGet("/api/admin/health", { checks: [], runtime: {}, status: "unknown" }),
    safeApiGet(
      `/api/admin/config-profiles/effective-preview${previewQuery.size ? `?${previewQuery.toString()}` : ""}`,
      null,
    ),
    safeApiGet("/api/admin/config-groups", { groups: [] }),
    safeApiGet("/api/admin/model-providers", { providers: [] }),
  ]);
  const rows = data.profiles || [];

  const tabs = [
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
          <ConfigProfileForm providers={providersData.gateway || []} />
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
    <AdminShell title={copy.title} subtitle={copy.subtitle}>
      <ConfigTabs tabs={tabs} />
    </AdminShell>
  );
}
