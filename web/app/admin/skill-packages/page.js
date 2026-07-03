import { AdminShell } from "../../../components/admin-shell";
import { AdminEmpty } from "../../../components/admin-empty";
import { AdminPageActions } from "../../../components/admin-page-actions";
import { SkillPackagesTable } from "../../../components/admin-tables";
import { safeApiGet } from "../../../lib/api";
import { getI18n } from "../../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

export default async function SkillPackagesPage() {
  const { t } = await getI18n();
  const data = await safeApiGet("/api/admin/skill-packages", { skillPackages: [] });
  const skills = data.skillPackages || [];

  return (
    <AdminShell title={t.admin.pages.skillPackages[0]} subtitle={t.admin.pages.skillPackages[1]}>
      <AdminPageActions actions={[{ href: "/admin/skill-packages/new", label: "新增技能包", variant: "primary" }]} />
      <SkillPackagesTable rows={skills} empty={<AdminEmpty title={t.admin.pages.skillPackages[0]} description={t.admin.pages.skillPackages[1]} />} />
    </AdminShell>
  );
}
