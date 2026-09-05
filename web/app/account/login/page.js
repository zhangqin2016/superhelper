import Link from "next/link";
import AccountPasswordLogin from "../../../components/account-password-login";
import { AccountLoginForm } from "../../../components/account-login-form";

export const dynamic = "force-dynamic";

function safeNext(value) {
  if (typeof value !== "string") return "/account/billing";
  if (value.startsWith("//")) return "/account/billing";
  if (value === "/wishes") return value;
  if (!value.startsWith("/account/")) return "/account/billing";
  return value;
}

export default async function AccountLoginPage({ searchParams }) {
  const params = await searchParams;
  const next = safeNext(params?.next || "/account/enterprise");
  const passwordMode = params?.mode !== "sms";
  return (
    <section className="mx-auto max-w-md rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">{passwordMode ? "企业账号登录" : "手机号登录"}</h1>
        <p className="mt-2 text-sm leading-6 text-slate-500">{passwordMode ? "使用企业负责人分配的账号和密码登录。" : "使用手机号与短信验证码登录。"}</p>
      </div>
      <div className="mb-5 flex gap-4 text-sm"><Link className="underline" href={`/account/login?mode=password&next=${encodeURIComponent(next)}`}>企业账号</Link><Link className="underline" href={`/account/login?mode=sms&next=${encodeURIComponent(next)}`}>手机号验证码</Link></div>
      {passwordMode ? <AccountPasswordLogin next={next} /> : <AccountLoginForm next={next} />}
    </section>
  );
}
