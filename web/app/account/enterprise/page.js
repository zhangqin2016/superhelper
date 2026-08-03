import Link from "next/link";
import { Building2, Plus } from "lucide-react";
import { userApiGet } from "../../../lib/user-api";
import { createOrganizationAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function EnterprisePage() {
  const data = await userApiGet("/api/enterprise/organizations", { organizations: [] });
  const orgs = Array.isArray(data?.organizations) ? data.organizations : [];
  return (
    <div className="space-y-8">
      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-2xl font-semibold">企业组织</h1>
            <p className="mt-2 text-sm text-slate-500">创建组织后即可添加成员、配置 token 额度并查看用量。</p>
          </div>
        </div>
        <form action={createOrganizationAction} className="mt-6 flex flex-col gap-3 sm:flex-row">
          <input name="name" required maxLength={120} placeholder="组织名称" className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm" />
          <button type="submit" className="inline-flex items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700">
            <Plus size={16} /> 创建组织
          </button>
        </form>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <h2 className="text-lg font-semibold">我的组织</h2>
        {orgs.length === 0 ? (
          <p className="mt-4 text-sm text-slate-500">你还没有加入任何组织。创建第一个组织开始管理企业额度。</p>
        ) : (
          <ul className="mt-4 divide-y divide-slate-100">
            {orgs.map((org) => (
              <li key={org.id} className="flex items-center justify-between gap-4 py-3">
                <div className="flex items-center gap-3">
                  <Building2 size={18} className="text-slate-400" />
                  <div>
                    <div className="text-sm font-medium">{org.name}</div>
                    <div className="text-xs text-slate-500">角色：{org.role}</div>
                  </div>
                </div>
                <Link
                  href={`/account/enterprise/${org.id}`}
                  className="rounded-lg bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-200"
                >
                  进入
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
