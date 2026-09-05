import { requireEnterpriseOrganization, requireEnterpriseData } from "../../../../../lib/enterprise-page";
import Link from "next/link";
import { notFound } from "next/navigation";
import { userApiGet } from "../../../../../lib/user-api";

export const dynamic = "force-dynamic";

function fmt(value) {
  return Number(value || 0).toLocaleString("zh-CN");
}

export default async function OrgUsagePage({ params, searchParams }) {
  const { id } = await params;
  const org = await requireEnterpriseOrganization(id, "admin");
  const query = await searchParams;
  const days = Number(query?.days || 30);
  const data = await requireEnterpriseData(`/api/enterprise/organizations/${id}/usage?days=${days}`, { usage: { byMember: [], byModel: [] } });
  const usage = data?.usage || {};
  const byMember = Array.isArray(usage.byMember) ? usage.byMember : [];
  const byModel = Array.isArray(usage.byModel) ? usage.byModel : [];
  if (!org?.id) notFound();
  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <Link href={`/account/enterprise/${id}`} className="text-sm text-slate-500 hover:text-slate-700">← 返回组织</Link>
          <h1 className="mt-1 text-2xl font-semibold">用量报表</h1>
          <p className="mt-1 text-sm text-slate-500">最近 {days} 天</p>
        </div>
        <form className="flex items-center gap-2">
          <label className="text-sm text-slate-600">天数</label>
          <select name="days" defaultValue={days} className="rounded-lg border border-slate-200 px-3 py-2 text-sm">
            {[7, 30, 90, 365].map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <button type="submit" className="rounded-lg bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-700">查询</button>
        </form>
      </div>
      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <h2 className="mb-4 text-base font-medium">按成员</h2>
        {byMember.length === 0 ? <p className="text-sm text-slate-500">暂无用量数据。</p> : (
          <table className="w-full text-sm">
            <thead><tr className="text-left text-slate-500"><th className="py-2">成员</th><th className="py-2">单位</th><th className="py-2">次数</th></tr></thead>
            <tbody>
              {byMember.map((row) => (
                <tr key={row.user_id || row.userId} className="border-t border-slate-100">
                  <td className="py-2">{row.user_id || row.userId}</td>
                  <td className="py-2">{fmt(row.units)}</td>
                  <td className="py-2">{fmt(row.request_count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <h2 className="mb-4 text-base font-medium">按模型</h2>
        {byModel.length === 0 ? <p className="text-sm text-slate-500">暂无用量数据。</p> : (
          <table className="w-full text-sm">
            <thead><tr className="text-left text-slate-500"><th className="py-2">模型</th><th className="py-2">单位</th></tr></thead>
            <tbody>
              {byModel.map((row) => (
                <tr key={row.model} className="border-t border-slate-100">
                  <td className="py-2">{row.model}</td>
                  <td className="py-2">{fmt(row.units)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
