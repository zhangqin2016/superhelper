import Link from "next/link";
import { AdminShell } from "../../../../components/admin-shell";
import { SkillPackageCreateForm } from "../../../../components/skill-package-create-form";
import { getI18n } from "../../../../lib/i18n.mjs";

export default async function NewSkillPackagePage() {
  const { t } = await getI18n();

  return (
    <AdminShell title="新增技能包" subtitle="上传一个 skillpack 并配置能力层、风险等级和默认推荐策略。">
      <div className="mb-5">
        <Link href="/admin/skill-packages" className="text-sm font-semibold text-brand">返回技能包列表</Link>
      </div>
      <SkillPackageCreateForm title={t.admin.pages.skillPackages[0]} />
    </AdminShell>
  );
}
