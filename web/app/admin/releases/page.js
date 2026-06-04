import { AdminShell } from "../../../components/admin-shell";
import { AdminEmpty } from "../../../components/admin-empty";
import { ReleaseCreateForm } from "../../../components/release-create-form";
import { ReleasesTable } from "../../../components/admin-tables";
import { safeApiGet } from "../../../lib/api";
import { getI18n } from "../../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

export default async function ReleasesPage() {
  const { t } = await getI18n();
  const data = await safeApiGet("/api/admin/releases", { releases: [] });
  const rows = data.releases || [];
  const cdnBaseUrl =
    process.env.RELEASE_CDN_BASE_URL ||
    process.env.NEXT_PUBLIC_RELEASE_CDN_BASE_URL ||
    process.env.QINIU_PUBLIC_BASE_URL ||
    "https://qny.lanrensoft.cn";
  const cdnPrefix =
    process.env.RELEASE_CDN_PREFIX ||
    process.env.NEXT_PUBLIC_RELEASE_CDN_PREFIX ||
    "app/updates";
  return (
    <AdminShell title={t.admin.pages.releases[0]} subtitle={t.admin.pages.releases[1]}>
      <ReleaseCreateForm cdnBaseUrl={cdnBaseUrl} cdnPrefix={cdnPrefix} />
      <ReleasesTable rows={rows} empty={<AdminEmpty title={t.admin.pages.releases[0]} description={t.admin.pages.releases[1]} />} />
    </AdminShell>
  );
}
