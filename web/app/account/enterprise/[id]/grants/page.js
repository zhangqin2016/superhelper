import Link from "next/link";
import { notFound } from "next/navigation";
import { userApiGet } from "../../../../../lib/user-api";

export const dynamic = "force-dynamic";

const typeLabel = { token: "Token", image_generation: "图片生成", video_generation: "视频生成" };

export default async function OrgGrantsPage({ params }) {
  const { id } = await params;
  const data = await userApiGet(`/api/enterprise/organizations/${id}/grants`, { grants: [] });
  const grants = Array.isArray(data?.grants) ? data.grants : [];
  const org = await userApiGet(`/api/enterprise/organizations/${id}`, null);
  if (!org?.id) notFound();
  const total = grants.reduce((sum, g) => sum + Number(g.unit_remaining || 0), 0);
  return (
    <div className="space-y-8">
      <div>
        <Link href={`/account/enterprise/${id}`} className="text-sm text-slate-500 hover:text-slate-700">← 返回组织</Link>
        <h1 className="mt-1 text-2xl font-semibold">额度配置</h1>
        <p className="mt-1 text-sm text-slate-500">组织额度池由平台管理员调拨，到期自动失效。</p>
      </div>
      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <div className="flex items-baseline gap-3">
          <span className="text-3xl font-semibold">{total.toLocaleString("zh-CN")}</span>
          <span className="text-sm text-slate-500">剩余单位（合计）</span>
        </div>
      </section>
      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <h2 className="mb-4 text-base font-medium">额度池明细</h2>
        {grants.length === 0 ? (
          <p className="text-sm text-slate-500">暂无额度，请联系平台管理员调拨。</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {grants.map((g) => (
              <li key={g.id} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <span className="font-medium">{typeLabel[g.resource_type] || g.resource_type}</span>
                  <span className="ml-2 text-sm text-slate-500">剩余 {Number(g.unit_remaining || 0).toLocaleString("zh-CN")} / {Number(g.unit_total || 0).toLocaleString("zh-CN")}</span>
                </div>
                <span className="text-xs text-slate-400">到期 {new Date(g.expires_at).toLocaleDateString("zh-CN")}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
