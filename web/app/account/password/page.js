import { redirect } from "next/navigation";
import { userApiGetResult } from "../../../lib/user-api";
import ActionForm from "../../../components/action-form";
import { changePasswordAccountAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function PasswordPage({ searchParams }) {
  const params = await searchParams;
  const result = await userApiGetResult("/api/auth/session/current");
  if (result.status === 401) redirect("/account/login?mode=password");
  if (!result.ok) throw new Error(result.message);
  return <section className="mx-auto max-w-md rounded-lg border bg-white p-6">
    <h1 className="text-2xl font-semibold">{result.data.user.passwordMustChange ? "首次登录，请设置新密码" : "修改密码"}</h1>
    <p className="my-4 text-sm text-slate-500">至少 8 位，包含字母和数字。修改后即可管理企业和使用企业额度。</p>
    <ActionForm action={changePasswordAccountAction} className="space-y-4">
      <input type="hidden" name="next" value={params?.next || "/account/enterprise"} />
      <label className="block">当前密码<input type="password" name="currentPassword" autoComplete="current-password" required className="mt-2 w-full rounded-lg border p-3" /></label>
      <label className="block">新密码<input type="password" name="newPassword" autoComplete="new-password" required minLength={8} maxLength={128} className="mt-2 w-full rounded-lg border p-3" /></label>
      <label className="block">确认新密码<input type="password" name="confirmPassword" autoComplete="new-password" required minLength={8} maxLength={128} className="mt-2 w-full rounded-lg border p-3" /></label>
      <button className="w-full rounded-lg bg-slate-950 p-3 text-white">保存新密码</button>
    </ActionForm>
  </section>;
}
