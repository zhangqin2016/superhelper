import { AdminShell } from "../../../components/admin-shell";
import { AdminEmpty } from "../../../components/admin-empty";
import { DevicesTable } from "../../../components/admin-tables";
import { safeApiGet } from "../../../lib/api";
import { getI18n } from "../../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

export default async function DevicesPage() {
  const { t } = await getI18n();
  const data = await safeApiGet("/api/admin/devices", { devices: [] });
  const rows = data.devices || [];
  return (
    <AdminShell title={t.admin.pages.devices[0]} subtitle={t.admin.pages.devices[1]}>
      <DevicesTable rows={rows} empty={<AdminEmpty title={t.admin.pages.devices[0]} description={t.admin.pages.devices[1]} />} />
    </AdminShell>
  );
}
