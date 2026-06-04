import { AdminShell } from "../../../components/admin-shell";
import { AdminEmpty } from "../../../components/admin-empty";
import { LicenseCreateForm } from "../../../components/license-create-form";
import { LicensesTable } from "../../../components/admin-tables";
import { safeApiGet } from "../../../lib/api";
import { getI18n } from "../../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

export default async function LicensesPage() {
  const { t } = await getI18n();
  const data = await safeApiGet("/api/admin/licenses", { licenses: [] });
  const rows = data.licenses || [];
  return (
    <AdminShell title={t.admin.pages.licenses[0]} subtitle={t.admin.pages.licenses[1]}>
      <LicenseCreateForm />
      <LicensesTable rows={rows} empty={<AdminEmpty title={t.admin.pages.licenses[0]} description={t.admin.pages.licenses[1]} />} />
    </AdminShell>
  );
}
