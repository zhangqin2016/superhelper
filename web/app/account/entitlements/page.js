import Link from "next/link";
import { Image, MessageSquareText, Video, Zap } from "lucide-react";
import { userApiGetResult } from "../../../lib/user-api";

export const dynamic = "force-dynamic";

function formatCount(value) {
  return Number(value || 0).toLocaleString("zh-CN");
}

function formatDate(value) {
  if (!value) return "未开通";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未开通";
  return date.toLocaleString("zh-CN");
}

export default async function AccountEntitlementsPage({ searchParams }) {
  const params = await searchParams;
  const result = await userApiGetResult("/api/account/entitlements");
  const loginRequired = !result.ok && (result.status === 401 || result.status === 403 || /USER_LOGIN_REQUIRED|WEB_SESSION/.test(result.message || ""));
  const serviceUnavailable = !result.ok && !loginRequired;
  const data = result.ok ? result.data : null;
  const entitlements = data?.entitlements || null;
  const cards = [
    ["Token 余额", entitlements ? formatCount(entitlements.tokenBalance) : "--", MessageSquareText],
    ["图片生成次数", entitlements ? formatCount(entitlements.imageGenerationsRemaining) : "--", Image],
    ["视频生成次数", entitlements ? formatCount(entitlements.videoGenerationsRemaining) : "--", Video],
    ["会员有效期", entitlements ? formatDate(entitlements.membershipExpiresAt) : "--", Zap],
  ];

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">当前权益</h1>
          <p className="mt-2 text-sm text-slate-500">这里展示官网购买和客户端免费额度汇总后的可用余额。</p>
        </div>
        <Link href="/account/billing" className="inline-flex rounded-lg bg-slate-950 px-4 py-2 text-sm font-semibold text-white">
          购买 / 充值
        </Link>
      </div>

      {params?.paid ? (
        <div className="mt-5 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          支付成功，权益已到账。客户端打开设置中的账户页，点击“刷新额度”即可同步。
        </div>
      ) : null}

      {serviceUnavailable ? (
        <div className="mt-6 rounded-lg border border-red-200 bg-red-50 p-8 text-center">
          <h2 className="text-base font-semibold text-red-900">权益服务暂不可用</h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-red-700">请稍后重试。错误信息：{result.message}</p>
        </div>
      ) : loginRequired ? (
        <div className="mt-6 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-8 text-center">
          <h2 className="text-base font-semibold text-slate-900">登录后查看权益</h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-500">权益和客户端使用同一个手机号同步，包含免费额度、购买额度和会员有效期。</p>
          <Link href="/account/login" className="mt-5 inline-flex rounded-lg bg-slate-950 px-4 py-2 text-sm font-semibold text-white">
            手机号登录
          </Link>
        </div>
      ) : (
        <div className="mt-6 grid gap-4 md:grid-cols-4">
          {cards.map(([label, value, Icon]) => (
            <div key={label} className="rounded-lg border border-slate-200 p-4">
              <div className="flex items-center gap-2 text-sm text-slate-500">
                <Icon size={16} />
                {label}
              </div>
              <div className="mt-3 text-2xl font-semibold">{value}</div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
