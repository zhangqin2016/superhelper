import { AccountLoginForm } from "../../../components/account-login-form";

export const dynamic = "force-dynamic";

function safeNext(value) {
  if (typeof value !== "string") return "/account/billing";
  if (!value.startsWith("/account/") || value.startsWith("//")) return "/account/billing";
  return value;
}

export default async function AccountLoginPage({ searchParams }) {
  const params = await searchParams;
  const next = safeNext(params?.next);
  return (
    <section className="mx-auto max-w-md rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">手机号登录</h1>
        <p className="mt-2 text-sm leading-6 text-slate-500">登录后可购买并同步客户端里的会员、Token、图片和视频权益。</p>
      </div>
      <AccountLoginForm next={next} />
    </section>
  );
}
