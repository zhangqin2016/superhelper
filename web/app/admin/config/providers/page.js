import { AdminShell } from "../../../../components/admin-shell";
import { AdminPageActions } from "../../../../components/admin-page-actions";
import { ConfigAdminNav } from "../../../../components/config-admin-nav";
import { ModelProvidersPanel } from "../../../../components/model-providers-panel";
import { safeApiGet } from "../../../../lib/api";
import { getI18n } from "../../../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

export default async function ConfigProvidersPage() {
  const { t } = await getI18n();
  const data = await safeApiGet("/api/admin/model-providers", { providers: [] });

  return (
    <AdminShell title={t.admin.configTabs.providers} subtitle={t.admin.configCenter.subtitle}>
      <ConfigAdminNav labels={t.admin.configTabs} />
      <AdminPageActions actions={[{ href: "/admin/config/providers/new", label: "新增 / 更新供应商", variant: "primary" }]} />
      <ModelProvidersPanel providers={data.providers || []} showForm={false} />
    </AdminShell>
  );
}
