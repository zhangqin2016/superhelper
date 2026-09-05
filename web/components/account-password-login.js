"use client";
import { useActionState } from "react";
import { loginPasswordAccountAction } from "../app/account/actions";

export default function AccountPasswordLogin({ next = "/account/enterprise" }) {
  const [state, action, pending] = useActionState(loginPasswordAccountAction, null);
  return <form action={action} className="space-y-4">
    <input type="hidden" name="next" value={next} />
    <label className="block text-sm">企业账号<input name="loginName" autoComplete="username" required minLength={3} maxLength={40} className="mt-2 w-full rounded-lg border px-3 py-3" /></label>
    <label className="block text-sm">密码<input name="password" type="password" autoComplete="current-password" required maxLength={128} className="mt-2 w-full rounded-lg border px-3 py-3" /></label>
    {state?.message && <p role="alert" className="text-sm text-red-700">{state.message}</p>}
    <button disabled={pending} className="w-full rounded-lg bg-slate-950 px-4 py-3 text-white disabled:opacity-50">{pending ? "登录中…" : "企业账号登录"}</button>
  </form>;
}
