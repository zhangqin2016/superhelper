import Link from "next/link";
import { notFound } from "next/navigation";
import { Users, Coins, BarChart3 } from "lucide-react";
import { userApiGet } from "../../../../lib/user-api";

export const dynamic = "force-dynamic";

export default async function OrgDetailPage({ params }) {
  const { id } = await params;
  const org = await userApiGet(`/api/enterprise/organizations/${id}`, null);
  if (!org?.id) notFound();
  const cards = [
    { href: `/account/enterprise/${id}/members`, icon: Users, label: "成员管理", desc: "添加/移除成员，设置角色与配额" },
    { href: `/account/enterprise/${id}/grants`, icon: Coins, label: "额度配置", desc: "查看组织额度池与调拨记录" },
    { href: `/account/enterprise/${id}/usage`, icon: BarChart3, label: "用量报表", desc: "按成员、按模型查看用量" },
  ];
  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <Link href="/account/enterprise" className="text-sm text-slate-500 hover:text-slate-700">← 返回组织列表</Link>
          <h1 className="mt-1 text-2xl font-semibold">{org.name}</h1>
          <p className="mt-1 text-sm text-slate-500">状态：{org.status === "active" ? "正常" : "已停用"} · 角色：{org.role}</p>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        {cards.map(({ href, icon: Icon, label, desc }) => (
          <Link key={href} href={href} className="rounded-lg border border-slate-200 bg-white p-6 hover:shadow-sm">
            <div className="flex items-center gap-2 text-slate-900">
              <Icon size={18} className="text-brand" />
              <span className="font-medium">{label}</span>
            </div>
            <p className="mt-2 text-sm text-slate-500">{desc}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
