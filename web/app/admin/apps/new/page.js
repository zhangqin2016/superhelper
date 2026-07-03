import Link from "next/link";
import { AdminShell } from "../../../../components/admin-shell";
import { WorkspaceAppCreateForm } from "../../../../components/workspace-app-create-form";
import { safeApiGet } from "../../../../lib/api";
import { getI18n } from "../../../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

function dedupeOptions(rows, idKey, labelKey) {
  const seen = new Map();
  for (const row of rows || []) {
    const id = String(row?.[idKey] || "").trim();
    if (!id || seen.has(id)) continue;
    seen.set(id, { id, label: String(row?.[labelKey] || id) });
  }
  return [...seen.values()];
}

export default async function NewAppPage() {
  const { t } = await getI18n();
  const [skillsData, runtimeData] = await Promise.all([
    safeApiGet("/api/admin/skill-packages", { skillPackages: [] }),
    safeApiGet("/api/admin/runtime-packs", { runtimePacks: [] }),
  ]);
  const skillPackageOptions = dedupeOptions(skillsData.skillPackages || [], "skill_id", "name");
  const runtimePackOptions = dedupeOptions(runtimeData.runtimePacks || [], "pack_id", "pack_id");

  return (
    <AdminShell title="新增应用" subtitle="上传一个工作空间导出的应用、模板、工具或连接器。">
      <div className="mb-5">
        <Link href="/admin/apps" className="text-sm font-semibold text-brand">返回应用列表</Link>
      </div>
      <WorkspaceAppCreateForm
        title={t.admin.pages.apps[0]}
        runtimePackOptions={runtimePackOptions}
        skillPackageOptions={skillPackageOptions}
      />
    </AdminShell>
  );
}
