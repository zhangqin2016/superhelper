import { AdminShell } from "../../../components/admin-shell";
import { AdminEmpty } from "../../../components/admin-empty";
import { ConfigProfileForm } from "../../../components/config-profile-form";
import { ConfigProfilesTable } from "../../../components/admin-tables";
import { safeApiGet } from "../../../lib/api";
import { getI18n } from "../../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

export default async function ConfigProfilesPage() {
  const { t } = await getI18n();
  const copy = t.admin.configProfiles;
  const data = await safeApiGet("/api/admin/config-profiles", { profiles: [] });
  const rows = data.profiles || [];
  return (
    <AdminShell title={copy.title} subtitle={copy.subtitle}>
      <ConfigProfileForm />
      <ConfigProfilesTable rows={rows} empty={<AdminEmpty title={copy.title} description={copy.subtitle} />} />
    </AdminShell>
  );
}
