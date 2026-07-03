import Link from "next/link";
import { AdminShell } from "../../../../components/admin-shell";
import { LicenseCreateForm } from "../../../../components/license-create-form";
import { getI18n } from "../../../../lib/i18n.mjs";

export default async function NewLicensePage() {
  const { t } = await getI18n();

  return (
    <AdminShell title="新增授权" subtitle="创建授权码并配置席位、到期时间和功能。">
      <div className="mb-5">
        <Link href="/admin/licenses" className="text-sm font-semibold text-brand">返回授权列表</Link>
      </div>
      <LicenseCreateForm title={t.admin.pages.licenses[0]} />
    </AdminShell>
  );
}
