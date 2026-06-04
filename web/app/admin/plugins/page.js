import { AdminShell } from "../../../components/admin-shell";
import { AdminEmpty } from "../../../components/admin-empty";
import { PluginCreateForm } from "../../../components/plugin-create-form";
import { PluginsTable } from "../../../components/admin-tables";
import { safeApiGet } from "../../../lib/api";
import { getI18n } from "../../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

export default async function PluginsPage() {
  const { t } = await getI18n();
  const data = await safeApiGet("/api/admin/plugins", { plugins: [] });
  const rows = data.plugins || [];
  return (
    <AdminShell title={t.admin.pages.plugins[0]} subtitle={t.admin.pages.plugins[1]}>
      <PluginCreateForm />
      <PluginsTable rows={rows} empty={<AdminEmpty title={t.admin.pages.plugins[0]} description={t.admin.pages.plugins[1]} />} />
    </AdminShell>
  );
}
