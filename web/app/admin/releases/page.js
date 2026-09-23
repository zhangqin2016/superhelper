import { AdminShell } from "../../../components/admin-shell";
import { AdminEmpty } from "../../../components/admin-empty";
import { AdminPageActions } from "../../../components/admin-page-actions";
import { ReleasesTable } from "../../../components/admin-tables";
import { Pagination } from "../../../components/pagination";
import { loadAdmin } from "../../../lib/api";
import { getI18n } from "../../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

export default async function ReleasesPage({ searchParams }) {
  const { t } = await getI18n();
  const params = await searchParams;
  const cursor = String(params?.cursor || "");
  const data = await loadAdmin(`/api/admin/releases${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, { releases: [], nextCursor: "", total: null, latest: {} });
  const rows = data.releases || [];
  return (
    <AdminShell title={t.admin.pages.releases[0]} subtitle={t.admin.pages.releases[1]}>
      <AdminPageActions actions={[{ href: "/admin/releases/new", label: "新增版本", variant: "primary" }]} />
      <ReleasesTable rows={rows} latest={data.latest || {}} empty={<AdminEmpty title={t.admin.pages.releases[0]} description={t.admin.pages.releases[1]} />} />
      <Pagination
        basePath="/admin/releases"
        searchParams={params || {}}
        shown={rows.length}
        total={data.total ?? null}
        nextCursor={data.nextCursor || ""}
        cursor={cursor}
        copy={t.admin.paging}
      />
    </AdminShell>
  );
}
