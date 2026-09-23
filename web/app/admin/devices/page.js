import { AdminShell } from "../../../components/admin-shell";
import { AdminEmpty } from "../../../components/admin-empty";
import { DevicesTable } from "../../../components/admin-tables";
import { Pagination } from "../../../components/pagination";
import { loadAdmin } from "../../../lib/api";
import { getI18n } from "../../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

export default async function DevicesPage({ searchParams }) {
  const { t } = await getI18n();
  const params = await searchParams;
  const cursor = String(params?.cursor || "");
  const data = await loadAdmin(`/api/admin/devices${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, { devices: [], nextCursor: "", total: null });
  const rows = data.devices || [];
  return (
    <AdminShell title={t.admin.pages.devices[0]} subtitle={t.admin.pages.devices[1]}>
      <DevicesTable rows={rows} empty={<AdminEmpty title={t.admin.pages.devices[0]} description={t.admin.pages.devices[1]} />} />
          <Pagination
        basePath="/admin/devices"
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
