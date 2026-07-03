import { AdminShell } from "../../../components/admin-shell";
import { AdminEmpty } from "../../../components/admin-empty";
import { RuntimePacksTable } from "../../../components/admin-tables";
import { safeApiGet } from "../../../lib/api";
import { getI18n } from "../../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

export default async function RuntimePacksPage() {
  const { t } = await getI18n();
  const data = await safeApiGet("/api/admin/runtime-packs", { runtimePacks: [] });
  const runtimes = data.runtimePacks || [];

  return (
    <AdminShell title={t.admin.pages.runtimePacks[0]} subtitle={t.admin.pages.runtimePacks[1]}>
      <RuntimePacksTable rows={runtimes} empty={<AdminEmpty title={t.admin.pages.runtimePacks[0]} description={t.admin.pages.runtimePacks[1]} />} />
    </AdminShell>
  );
}
