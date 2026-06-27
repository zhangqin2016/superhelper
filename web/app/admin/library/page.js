import { AdminShell } from "../../../components/admin-shell";
import { AdminEmpty } from "../../../components/admin-empty";
import { WorkspaceAppCreateForm } from "../../../components/workspace-app-create-form";
import { SkillPackageCreateForm } from "../../../components/skill-package-create-form";
import { WorkspaceAppsTable, SkillPackagesTable, RuntimePacksTable } from "../../../components/admin-tables";
import { ConfigTabs } from "../../../components/config-tabs";
import { safeApiGet } from "../../../lib/api";
import { getI18n } from "../../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

// Distinct options for the dependency pickers (dedupe across versions).
function dedupeOptions(rows, idKey, labelKey) {
  const seen = new Map();
  for (const row of rows || []) {
    const id = String(row?.[idKey] || "").trim();
    if (!id || seen.has(id)) continue;
    seen.set(id, { id, label: String(row?.[labelKey] || id) });
  }
  return [...seen.values()];
}

export default async function LibraryPage() {
  const { t } = await getI18n();
  const pages = t.admin.pages;
  const [appsData, skillsData, runtimeData] = await Promise.all([
    safeApiGet("/api/admin/workspace-apps", { workspaceApps: [] }),
    safeApiGet("/api/admin/skill-packages", { skillPackages: [] }),
    safeApiGet("/api/admin/runtime-packs", { runtimePacks: [] }),
  ]);
  const apps = appsData.workspaceApps || [];
  const skills = skillsData.skillPackages || [];
  const runtimes = runtimeData.runtimePacks || [];

  const skillPackageOptions = dedupeOptions(skills, "skill_id", "name");
  const runtimePackOptions = dedupeOptions(runtimes, "pack_id", "pack_id");

  const tabs = [
    {
      id: "apps",
      label: pages.apps[0],
      node: (
        <>
          <WorkspaceAppCreateForm runtimePackOptions={runtimePackOptions} skillPackageOptions={skillPackageOptions} />
          <WorkspaceAppsTable rows={apps} empty={<AdminEmpty title={pages.apps[0]} description={pages.apps[1]} />} />
        </>
      ),
    },
    {
      id: "skills",
      label: pages.skillPackages[0],
      node: (
        <>
          <SkillPackageCreateForm />
          <SkillPackagesTable rows={skills} empty={<AdminEmpty title={pages.skillPackages[0]} description={pages.skillPackages[1]} />} />
        </>
      ),
    },
    {
      id: "runtime",
      label: pages.runtimePacks[0],
      node: <RuntimePacksTable rows={runtimes} empty={<AdminEmpty title={pages.runtimePacks[0]} description={pages.runtimePacks[1]} />} />,
    },
  ];

  return (
    <AdminShell title={t.admin.library.title} subtitle={t.admin.library.subtitle}>
      <ConfigTabs tabs={tabs} />
    </AdminShell>
  );
}
