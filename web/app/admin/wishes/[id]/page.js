import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminShell } from "../../../../components/admin-shell";
import { WishAdminForm } from "../../../../components/wish-admin-form";
import { safeApiGet } from "../../../../lib/api";
import { getI18n } from "../../../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

export default async function AdminWishDetailPage({ params }) {
  const { id } = await params;
  const { t } = await getI18n();
  const [wishData, appsData, skillsData] = await Promise.all([
    safeApiGet(`/api/admin/wishes/${encodeURIComponent(id)}`, null),
    safeApiGet("/api/admin/workspace-apps", { workspaceApps: [] }),
    safeApiGet("/api/admin/skill-packages", { skillPackages: [] }),
  ]);
  if (!wishData?.wish) notFound();
  return (
    <AdminShell title={wishData.wish.public_title || wishData.wish.title} subtitle={`${id} · ${wishData.wish.status}`}>
      <Link href="/admin/wishes" className="mb-5 inline-flex text-sm font-semibold text-brand">{t.admin.wishes.back}</Link>
      <WishAdminForm
        wish={wishData.wish}
        apps={(appsData.workspaceApps || []).filter((item) => item.enabled)}
        skills={(skillsData.skillPackages || []).filter((item) => item.enabled && item.display_in_catalog !== false)}
        copy={t.admin.wishes}
      />
    </AdminShell>
  );
}
