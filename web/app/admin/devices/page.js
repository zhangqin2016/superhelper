import { AdminShell } from "../../../components/admin-shell";
import { AdminEmpty } from "../../../components/admin-empty";
import { DevicesTable } from "../../../components/admin-tables";
import { Pagination } from "../../../components/pagination";
import { ListFilter } from "../../../components/list-filter";
import { loadAdmin } from "../../../lib/api";
import { getI18n } from "../../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

export default async function DevicesPage({ searchParams }) {
  const { t } = await getI18n();
  const params = await searchParams;
  const cursor = String(params?.cursor || "");
  const seen = ["7d", "30d", "all"].includes(params?.seen) ? params.seen : "30d";
  const query = new URLSearchParams({ seen });
  if (cursor) query.set("cursor", cursor);
  const data = await loadAdmin(`/api/admin/devices?${query}`, { devices: [], nextCursor: "", total: null, latest: {} });
  const rows = data.devices || [];
  const copy = t.admin.devicesList;
  return (
    <AdminShell title={t.admin.pages.devices[0]} subtitle={t.admin.pages.devices[1]}>
      <ListFilter
        basePath="/admin/devices"
        searchParams={params || {}}
        param="seen"
        value={seen}
        label={copy.seenLabel}
        options={[{ value: "7d", label: copy.seen7d }, { value: "30d", label: copy.seen30d }, { value: "all", label: copy.seenAll }]}
      />
      <DevicesTable rows={rows} latest={data.latest || {}} empty={<AdminEmpty title={t.admin.pages.devices[0]} description={t.admin.pages.devices[1]} />} />
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
