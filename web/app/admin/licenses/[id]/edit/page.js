import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminShell } from "../../../../../components/admin-shell";
import { LicenseEditForm } from "../../../../../components/license-edit-form";
import { safeApiGet } from "../../../../../lib/api";

export const dynamic = "force-dynamic";

export default async function EditLicensePage({ params }) {
  const { id } = await params;
  const data = await safeApiGet(`/api/admin/licenses/${id}`, null);
  if (!data?.license) notFound();

  return (
    <AdminShell title="编辑授权" subtitle={data.license.id}>
      <div className="mb-5">
        <Link href={`/admin/licenses/${data.license.id}`} className="text-sm font-semibold text-brand">返回授权详情</Link>
      </div>
      <LicenseEditForm license={data.license} />
    </AdminShell>
  );
}
