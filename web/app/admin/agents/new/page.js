import Link from "next/link";
import { AdminShell } from "../../../../components/admin-shell";
import { AgentPackageForm } from "../../../../components/agent-package-form";
import { getI18n } from "../../../../lib/i18n.mjs";

export const dynamic = "force-dynamic";

export default async function NewAgentPackagePage() {
  const { locale, t } = await getI18n();
  const zh = locale === "zh";
  const page = t.admin.pages.agents || ["Agents", ""];

  return (
    <AdminShell
      title={zh ? "发布智能体" : "Publish an agent"}
      subtitle={zh ? "粘贴一份智能体定义（JSON），选择全局或某个企业组织下发。" : "Paste an agent definition (JSON) and choose global or organization delivery."}
    >
      <div className="mb-5">
        <Link href="/admin/agents" className="text-sm font-semibold text-brand">{zh ? `返回${page[0]}列表` : `Back to ${page[0]}`}</Link>
      </div>
      <AgentPackageForm />
    </AdminShell>
  );
}
