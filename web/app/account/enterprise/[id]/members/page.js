import ActionForm from "../../../../../components/action-form";
import { requireEnterpriseOrganization, requireEnterpriseData } from "../../../../../lib/enterprise-page";
import Link from "next/link";
import { notFound } from "next/navigation";
import { userApiGet } from "../../../../../lib/user-api";
import { addMemberAction, patchMemberAction, removeMemberAction, revokeInvitationAction, provisionAccountsAction, resetAccountPasswordAction } from "../../actions";
import IssuedCredentials from "../../../../../components/issued-credentials";

export const dynamic = "force-dynamic";

export default async function OrgMembersPage({ params }) {
  const { id } = await params;
  const org = await requireEnterpriseOrganization(id, "admin");
  const data = await requireEnterpriseData(`/api/enterprise/organizations/${id}/members`, { members: [] });
  const members = Array.isArray(data?.members) ? data.members : [];
  // Seats handed to staff who have no account yet. They are not members
  // until they log in, so they are listed separately rather than mixed in.
  const invitationData = await requireEnterpriseData(`/api/enterprise/organizations/${id}/invitations`, { invitations: [] });
  const invitations = Array.isArray(invitationData?.invitations) ? invitationData.invitations : [];
  // Accounts the company itself issued (login name + password, no phone).
  const issuedData = await requireEnterpriseData(`/api/enterprise/organizations/${id}/accounts`, { accounts: [] });
  const issued = Array.isArray(issuedData?.accounts) ? issuedData.accounts : [];
  if (!org?.id) notFound();
  const roleLabel = { owner: "所有者", admin: "管理员", member: "成员" };
  const canManage = org.role === "owner" || org.role === "admin";
  return (
    <div className="space-y-8">
      <div>
        <Link href={`/account/enterprise/${id}`} className="text-sm text-slate-500 hover:text-slate-700">← 返回组织</Link>
        <h1 className="mt-1 text-2xl font-semibold">成员管理</h1>
        <p className="mt-1 text-sm text-slate-500">{org.name}</p>
      </div>

      <IssuedCredentials />

      {canManage && (
        <ActionForm action={provisionAccountsAction.bind(null, id)} className="space-y-3 rounded-lg border border-slate-200 bg-white p-6">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">生成企业专属账户</h2>
            <p className="mt-1 text-xs text-slate-500">企业直接为员工创建账号，员工不需要手机号。填前缀+数量按序号批量生成（如 MAX + 20 → max_0001 ～ max_0020，下一批自动接着编号；登录名统一小写）。每个账户附一次性初始密码，首次登录必须修改。账户归企业所有：移出企业即无法登录。</p>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <input name="prefix" placeholder="前缀（如 MAX → max_0001…）" className="w-44 rounded-lg border border-slate-200 px-3 py-2 text-sm" />
            <input name="count" type="number" min="1" max="100" placeholder="数量" className="w-24 rounded-lg border border-slate-200 px-3 py-2 text-sm" />
            <textarea name="loginNames" rows={1} placeholder="或直接列出登录名（逗号/换行分隔）" className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm" />
            <select name="role" defaultValue="member" className="rounded-lg border border-slate-200 px-3 py-2 text-sm">
              <option value="member">成员</option>
              <option value="admin">管理员</option>
            </select>
            <button type="submit" className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700">生成账户</button>
          </div>
        </ActionForm>
      )}

      {canManage && (
        <ActionForm action={addMemberAction.bind(null, id)} className="space-y-3 rounded-lg border border-slate-200 bg-white p-6">
          <div className="flex flex-col gap-3 sm:flex-row">
            <input name="phoneE164" placeholder="手机号（+8613…）" className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm" />
            <input name="userId" placeholder="或用户 ID（usr_…）" className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm" />
            <select name="role" defaultValue="member" className="rounded-lg border border-slate-200 px-3 py-2 text-sm">
              <option value="member">成员</option>
              <option value="admin">管理员</option>
            </select>
            <button type="submit" className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700">添加</button>
          </div>
          <p className="text-xs text-slate-500">手机号还没注册也可以添加：席位会先记为待接受，对方首次登录时自动加入。</p>
        </ActionForm>
      )}

      <section className="rounded-lg border border-slate-200 bg-white">
        <ul className="divide-y divide-slate-100">
          {members.length === 0 && <li className="p-6 text-sm text-slate-500">暂无成员。</li>}
          {members.map((m) => (
            <li key={m.user_id} className="flex flex-wrap items-center gap-3 px-6 py-4">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-900">{m.user_id}</p>
                <p className="text-xs text-slate-500">{roleLabel[m.role] || m.role} · {m.status === "active" ? "正常" : "已停用"} · 单次扣费上限：{m.quota === null || m.quota === undefined ? "不限" : m.quota}</p>
              </div>
              {canManage && (
                <ActionForm action={patchMemberAction.bind(null, id, m.user_id)} className="flex items-center gap-2">
                  <select name="status" defaultValue={m.status} className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm">
                    <option value="active">正常</option>
                    <option value="disabled">停用</option>
                  </select>
                  <input aria-label="单次扣费上限" name="quota" type="number" min="0" step="1" defaultValue={m.quota ?? ""} placeholder="单次扣费上限，空为不限" className="w-24 rounded-lg border border-slate-200 px-2 py-1.5 text-sm" />
                  <button type="submit" className="rounded-lg bg-slate-100 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-200">更新</button>
                </ActionForm>
              )}
              {canManage && (
                <ActionForm action={removeMemberAction.bind(null, id, m.user_id)}>
                  <button type="submit" className="rounded-lg bg-red-50 px-3 py-1.5 text-sm text-red-600 hover:bg-red-100">移除</button>
                </ActionForm>
              )}
            </li>
          ))}
        </ul>
      </section>

      {canManage && issued.length > 0 && (
        <section className="rounded-lg border border-slate-200 bg-white">
          <header className="border-b border-slate-200 px-6 py-3">
            <h2 className="text-sm font-medium text-slate-900">企业专属账户（{issued.length}）</h2>
            <p className="mt-0.5 text-xs text-slate-500">企业签发的账号。重置密码会生成新的一次性初始密码，旧密码立即失效。</p>
          </header>
          <ul className="divide-y divide-slate-100">
            {issued.map((a) => (
              <li key={a.userId} className="flex flex-wrap items-center gap-3 px-6 py-4">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-sm font-medium text-slate-900">{a.loginName}{a.displayName ? <span className="ml-2 font-sans font-normal text-slate-500">{a.displayName}</span> : null}</p>
                  <p className="text-xs text-slate-500">
                    {roleLabel[a.role] || a.role} · {a.status === "active" ? "正常" : "已停用"}
                    {a.passwordMustChange ? " · 尚未首次登录" : a.lastLoginAt ? ` · 最近登录 ${new Date(a.lastLoginAt).toLocaleDateString("zh-CN")}` : ""}
                  </p>
                </div>
                {(org.role === "owner" || a.role !== "owner") && <ActionForm action={resetAccountPasswordAction.bind(null, id, a.userId)}>
                  <button type="submit" className="rounded-lg bg-slate-100 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-200">重置密码</button>
                </ActionForm>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {canManage && invitations.length > 0 && (
        <section className="rounded-lg border border-amber-200 bg-amber-50/40">
          <header className="border-b border-amber-200 px-6 py-3">
            <h2 className="text-sm font-medium text-slate-900">待接受席位（{invitations.length}）</h2>
            <p className="mt-0.5 text-xs text-slate-500">这些手机号还没有账号，首次登录后自动成为成员。</p>
          </header>
          <ul className="divide-y divide-amber-100">
            {invitations.map((invitation) => (
              <li key={invitation.id} className="flex flex-wrap items-center gap-3 px-6 py-4">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-900">{invitation.phone_e164}</p>
                  <p className="text-xs text-slate-500">{roleLabel[invitation.role] || invitation.role} · 待接受</p>
                </div>
                <ActionForm action={revokeInvitationAction.bind(null, id, invitation.id)}>
                  <button type="submit" className="rounded-lg bg-white px-3 py-1.5 text-sm text-amber-700 ring-1 ring-amber-200 hover:bg-amber-100">撤销</button>
                </ActionForm>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
