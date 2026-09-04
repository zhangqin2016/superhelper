import Link from "next/link";
import { notFound } from "next/navigation";
import { userApiGet } from "../../../../../lib/user-api";
import { addMemberAction, patchMemberAction, removeMemberAction, revokeInvitationAction } from "../../actions";

export const dynamic = "force-dynamic";

export default async function OrgMembersPage({ params }) {
  const { id } = await params;
  const data = await userApiGet(`/api/enterprise/organizations/${id}/members`, { members: [] });
  const members = Array.isArray(data?.members) ? data.members : [];
  const org = await userApiGet(`/api/enterprise/organizations/${id}`, null);
  // Seats handed to staff who have no account yet. They are not members
  // until they log in, so they are listed separately rather than mixed in.
  const invitationData = await userApiGet(`/api/enterprise/organizations/${id}/invitations`, { invitations: [] });
  const invitations = Array.isArray(invitationData?.invitations) ? invitationData.invitations : [];
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

      {canManage && (
        <form action={addMemberAction.bind(null, id)} className="space-y-3 rounded-lg border border-slate-200 bg-white p-6">
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
        </form>
      )}

      <section className="rounded-lg border border-slate-200 bg-white">
        <ul className="divide-y divide-slate-100">
          {members.length === 0 && <li className="p-6 text-sm text-slate-500">暂无成员。</li>}
          {members.map((m) => (
            <li key={m.user_id} className="flex flex-wrap items-center gap-3 px-6 py-4">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-900">{m.user_id}</p>
                <p className="text-xs text-slate-500">{roleLabel[m.role] || m.role} · {m.status === "active" ? "正常" : "已停用"} · 配额：{m.quota === null || m.quota === undefined ? "不限" : m.quota}</p>
              </div>
              {canManage && (
                <form action={patchMemberAction.bind(null, id, m.user_id)} className="flex items-center gap-2">
                  <select name="status" className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm">
                    <option value="active" selected={m.status === "active"}>正常</option>
                    <option value="disabled" selected={m.status === "disabled"}>停用</option>
                  </select>
                  <input name="quota" defaultValue={m.quota ?? ""} placeholder="配额" className="w-24 rounded-lg border border-slate-200 px-2 py-1.5 text-sm" />
                  <button type="submit" className="rounded-lg bg-slate-100 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-200">更新</button>
                </form>
              )}
              {canManage && (
                <form action={removeMemberAction.bind(null, id, m.user_id)}>
                  <button type="submit" className="rounded-lg bg-red-50 px-3 py-1.5 text-sm text-red-600 hover:bg-red-100">移除</button>
                </form>
              )}
            </li>
          ))}
        </ul>
      </section>

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
                <form action={revokeInvitationAction.bind(null, id, invitation.id)}>
                  <button type="submit" className="rounded-lg bg-white px-3 py-1.5 text-sm text-amber-700 ring-1 ring-amber-200 hover:bg-amber-100">撤销</button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
