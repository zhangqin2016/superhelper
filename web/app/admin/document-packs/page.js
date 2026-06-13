import { AdminShell } from "../../../components/admin-shell";
import { AdminEmpty } from "../../../components/admin-empty";
import { DocumentPacksTable } from "../../../components/admin-tables";
import { safeApiGet } from "../../../lib/api";
import { getI18n } from "../../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

export default async function DocumentPacksPage() {
  const { t } = await getI18n();
  const data = await safeApiGet("/api/admin/document-packs", { documentPacks: [] });
  const rows = data.documentPacks || [];
  return (
    <AdminShell title={t.admin.pages.documentPacks[0]} subtitle={t.admin.pages.documentPacks[1]}>
      <DocumentPacksTable
        rows={rows}
        empty={<AdminEmpty title={t.admin.pages.documentPacks[0]} description={t.admin.pages.documentPacks[1]} />}
      />
    </AdminShell>
  );
}
