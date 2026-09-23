import { AdminShell } from "../../../components/admin-shell";
import { AdminEmpty } from "../../../components/admin-empty";
import { AdminPageActions } from "../../../components/admin-page-actions";
import { LicensesTable } from "../../../components/admin-tables";
import { Pagination } from "../../../components/pagination";
import { loadAdmin } from "../../../lib/api";
import { getI18n } from "../../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

export default async function LicensesPage({ searchParams }) {
  const { t } = await getI18n();
  const params = await searchParams;
  const cursor = String(params?.cursor || "");
  const data = await loadAdmin(`/api/admin/licenses${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, { licenses: [], nextCursor: "", total: null });
  const rows = data.licenses || [];
  return (
    <AdminShell title={t.admin.pages.licenses[0]} subtitle={t.admin.pages.licenses[1]}>
      <AdminPageActions actions={[{ href: "/admin/licenses/new", label: "新增授权", variant: "primary" }]} />
      <LicensesTable rows={rows} empty={<AdminEmpty title={t.admin.pages.licenses[0]} description={t.admin.pages.licenses[1]} />} />
          <Pagination
        basePath="/admin/licenses"
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
