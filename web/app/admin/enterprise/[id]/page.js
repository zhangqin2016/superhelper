import ActionForm from "../../../../components/action-form";
import Link from "next/link";
import IssuedCredentials from "../../../../components/issued-credentials";
import { AdminShell } from "../../../../components/admin-shell";
import { apiGet, safeApiGet } from "../../../../lib/api";
import { getI18n } from "../../../../lib/i18n.mjs";
import { adjustOrgGrantAction, toggleOrgStatusAction, reissueOwnerInitialPasswordAction } from "../actions";

export const dynamic = "force-dynamic";

function fmt(value) {
  return Number(value || 0).toLocaleString("en-US");
}

export default async function AdminOrgDetailPage({ params }) {
  const { id } = await params;
  const { t } = await getI18n();
  let data;
  try { data = await apiGet(`/api/admin/enterprise/organizations/${id}`); }
  catch (error) { if (error.status !== 404) throw error; }
  const org = data?.organization;
  if (!org?.id) return <AdminShell title="Enterprise">
      <IssuedCredentials /><p className="text-sm text-slate-500">Organization not found.</p></AdminShell>;
  const usage = await safeApiGet(`/api/admin/enterprise/organizations/${id}/usage?days=30`, { usage: { byMember: [], byModel: [] } });
  const byMember = usage?.usage?.byMember || [];
  return (
    <AdminShell title={org.name} subtitle={`状态：${org.status === "active" ? "正常" : "已停用"}`}>
      <IssuedCredentials />
      <section className="table-card mb-4 space-y-3 p-6">
        <h2 className="font-medium">企业负责人账号</h2>
        <p className="text-sm text-slate-600">密码不保存明文，不能查看旧密码。首次密码尚未修改时，可重新签发初始密码；负责人已设置自己的密码后，由企业内部管理。</p>
        {(org.owners || []).map((owner) => <div key={owner.id} className="space-y-2 border-t pt-3">
          <p className="text-sm">登录名：<strong>{owner.loginName || "手机号账户"}</strong>{owner.displayName ? ` · ${owner.displayName}` : ""}</p>
          {owner.issued && owner.passwordMustChange && <ActionForm action={reissueOwnerInitialPasswordAction.bind(null, id, owner.id)}>
            <button className="rounded-lg border px-4 py-2 text-sm">重新签发负责人初始密码</button>
          </ActionForm>}
        </div>)}
      </section>
      <p className="mb-4 text-sm text-slate-600">企业负责人请使用签发的账号到 <Link href="/account/login" className="underline">企业账户登录</Link> 管理员工。平台管理员在此配置企业 Token 池。</p>
      <section className="table-card mb-4 p-6"><h2 className="font-medium">企业额度池</h2>{(org.grants || []).map((g) => <p key={g.id} className="mt-2 text-sm">{g.resource_type}：剩余 {fmt(g.unit_remaining)} / {fmt(g.unit_total)} · 到期 {String(g.expires_at).slice(0, 10)}</p>)}</section>
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="table-card p-6">
          <h2 className="mb-3 font-medium">配置企业 Token / 资源池</h2>
          <ActionForm action={adjustOrgGrantAction.bind(null, id)} className="grid gap-3">
            <select name="resourceType" defaultValue="token" className="rounded-lg border border-slate-200 px-3 py-2 text-sm">
              <option value="token">Token</option>
              <option value="image_generation">Image generation</option>
              <option value="video_generation">Video generation</option>
            </select>
            <input name="unitTotal" type="number" min={1} required placeholder="Units" className="rounded-lg border border-slate-200 px-3 py-2 text-sm" />
            <input name="expiresDays" type="number" min={1} max={3650} defaultValue={365} className="rounded-lg border border-slate-200 px-3 py-2 text-sm" />
            <button type="submit" className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700">调拨额度</button>
          </ActionForm>
        </section>
        <section className="table-card p-6">
          <h2 className="mb-3 font-medium">企业状态</h2>
          <p className="mb-3 text-sm text-slate-600">停用后员工无法使用企业额度池，个人额度保留。</p>
          <ActionForm action={toggleOrgStatusAction.bind(null, id)}>
            <input type="hidden" name="status" value={org.status === "active" ? "disabled" : "active"} />
            <button type="submit" className="rounded-lg bg-red-50 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-100">
              {org.status === "active" ? "Disable org" : "Enable org"}
            </button>
          </ActionForm>
        </section>
      </div>
      <section className="table-card mt-4 p-6">
        <h2 className="mb-3 font-medium">员工用量（最近 30 天）</h2>
        {byMember.length === 0 ? (
          <p className="text-sm text-slate-500">暂无用量。</p>
        ) : (
          <table className="w-full text-sm">
            <thead><tr className="text-left text-slate-500"><th className="py-2 pr-4">User</th><th className="py-2">Units</th></tr></thead>
            <tbody>
              {byMember.map((row) => (
                <tr key={row.user_id} className="border-t border-slate-100">
                  <td className="py-2">{row.user_id}</td>
                  <td className="py-2">{fmt(row.units)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </AdminShell>
  );
}
