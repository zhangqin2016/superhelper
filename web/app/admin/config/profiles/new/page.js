import Link from "next/link";
import { AdminShell } from "../../../../../components/admin-shell";
import { ConfigProfileForm } from "../../../../../components/config-profile-form";
import { safeApiGet } from "../../../../../lib/api";
import { getI18n } from "../../../../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

export default async function NewConfigProfilePage() {
  const { t } = await getI18n();
  const [providersData, skillsData] = await Promise.all([
    safeApiGet("/api/admin/model-providers", { providers: [] }),
    safeApiGet("/api/admin/skill-packages", { skillPackages: [] }),
  ]);
  const skillPackageOptions = [
    ...new Map((skillsData.skillPackages || []).map((s) => [String(s.skill_id || ""), { id: String(s.skill_id || ""), label: String(s.name || s.skill_id || "") }])).values(),
  ].filter((o) => o.id);

  return (
    <AdminShell title="新增下发规则" subtitle="只创建一条客户端配置下发规则。已有规则请回列表查看、停用或回滚。">
      <div className="mb-5">
        <Link href="/admin/config/profiles" className="text-sm font-semibold text-brand">返回下发规则</Link>
      </div>
      <ConfigProfileForm providers={providersData.gateway || []} skillPackageOptions={skillPackageOptions} />
    </AdminShell>
  );
}
