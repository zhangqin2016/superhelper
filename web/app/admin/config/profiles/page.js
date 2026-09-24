import { AdminShell } from "../../../../components/admin-shell";
import { AdminPageActions } from "../../../../components/admin-page-actions";
import { ConfigAdminNav } from "../../../../components/config-admin-nav";
import { ConfigRulesList } from "../../../../components/config-rules-list";
import { loadAdmin } from "../../../../lib/api";
import { getI18n } from "../../../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

export default async function ConfigProfilesPage() {
  const { t } = await getI18n();
  const [data, providers, media] = await Promise.all([
    loadAdmin("/api/admin/config-profiles", { profiles: [] }),
    // Names only: a failed read shows ids, as the list did before.
    loadAdmin("/api/admin/model-providers", { providers: [] }),
    loadAdmin("/api/admin/media-providers", { mediaProviders: [] }),
  ]);

  return (
    <AdminShell title={t.admin.configTabs.profiles} subtitle={t.admin.configPurpose.profiles}>
      <ConfigAdminNav labels={t.admin.configTabs} current="profiles" />
      <AdminPageActions actions={[{ href: "/admin/config/profiles/new", label: t.admin.configRules.add, variant: "primary" }]} />
      <ConfigRulesList rules={data.profiles || []} providers={providers.providers || []} mediaProviders={media.mediaProviders || []} />
    </AdminShell>
  );
}
