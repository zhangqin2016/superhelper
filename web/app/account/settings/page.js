import Link from "next/link";
import { requireEnterpriseAccount } from "../../../lib/enterprise-page";
import { logoutAccountAction } from "../actions";
export const dynamic = "force-dynamic";
export default async function AccountSettingsPage() {
  const user = await requireEnterpriseAccount("/account/settings");
  return <section className="rounded-lg border bg-white p-6 space-y-4">
    <h1 className="text-2xl font-semibold">账号设置</h1>
    <p>当前账号：{user.loginName || user.phoneMasked}</p>
    {user.loginName && <Link href="/account/password" className="block underline">修改密码</Link>}
    <form action={logoutAccountAction}><button className="rounded-lg border px-4 py-2">退出登录</button></form>
  </section>;
}
