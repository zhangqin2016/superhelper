import { AdminShell } from "../../../components/admin-shell";
import { AdminEmpty } from "../../../components/admin-empty";
import { AdminPageActions } from "../../../components/admin-page-actions";
import { ReleasesTable } from "../../../components/admin-tables";
import { safeApiGet } from "../../../lib/api";
import { getI18n } from "../../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

export default async function ReleasesPage() {
  const { t } = await getI18n();
  const data = await safeApiGet("/api/admin/releases", { releases: [] });
  const rows = data.releases || [];
  return (
    <AdminShell title={t.admin.pages.releases[0]} subtitle={t.admin.pages.releases[1]}>
      <AdminPageActions actions={[{ href: "/admin/releases/new", label: "新增版本", variant: "primary" }]} />
      <ReleasesTable rows={rows} empty={<AdminEmpty title={t.admin.pages.releases[0]} description={t.admin.pages.releases[1]} />} />
    </AdminShell>
  );
}
