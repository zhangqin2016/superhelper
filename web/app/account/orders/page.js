import Link from "next/link";
import { mockPayBillingOrderAction } from "../actions";
import { userApiGetResult } from "../../../lib/user-api";
import { AccountSubmitButton } from "../../../components/account-submit-button";

export const dynamic = "force-dynamic";

function formatMoney(cents, currency = "CNY") {
  const amount = Number(cents || 0) / 100;
  return `${currency === "CNY" ? "¥" : currency} ${amount.toFixed(2)}`;
}

function statusLabel(status) {
  if (status === "paid") return "已支付";
  if (status === "pending") return "待支付";
  return status || "未知";
}

function unitLabel(order) {
  if (order.resourceType === "token") return `${Number(order.unitAmount || 0).toLocaleString("zh-CN")} tokens`;
  if (order.resourceType === "image_generation") return `${Number(order.unitAmount || 0).toLocaleString("zh-CN")} 次图片`;
  if (order.resourceType === "video_generation") return `${Number(order.unitAmount || 0).toLocaleString("zh-CN")} 次视频`;
  if (order.resourceType === "membership") return "会员权益";
  return `${order.unitAmount || 0} 单位`;
}

export default async function AccountOrdersPage({ searchParams }) {
  const params = await searchParams;
  const result = await userApiGetResult("/api/billing/orders");
  const loginRequired = !result.ok && (result.status === 401 || result.status === 403 || /USER_LOGIN_REQUIRED|WEB_SESSION/.test(result.message || ""));
  const serviceUnavailable = !result.ok && !loginRequired;
  const data = result.ok ? result.data : null;
  const orders = Array.isArray(data?.orders) ? data.orders : [];
  const fakePaymentsEnabled = Boolean(data?.fakePaymentsEnabled);

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">订单</h1>
          <p className="mt-2 text-sm text-slate-500">创建订单后可在这里完成模拟支付，支付成功会立即发放权益。</p>
        </div>
        <Link href="/account/billing" className="inline-flex rounded-lg bg-slate-950 px-4 py-2 text-sm font-semibold text-white">
          继续购买
        </Link>
      </div>

      {params?.created ? (
        <div className="mt-5 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          订单已创建，请点击“模拟支付完成”完成闭环。
        </div>
      ) : null}
      {params?.error ? (
        <div className="mt-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          支付失败：{params.error}
        </div>
      ) : null}

      {serviceUnavailable ? (
        <div className="mt-6 rounded-lg border border-red-200 bg-red-50 p-8 text-center">
          <h2 className="text-base font-semibold text-red-900">订单服务暂不可用</h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-red-700">请稍后重试。错误信息：{result.message}</p>
        </div>
      ) : loginRequired ? (
        <div className="mt-6 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-8 text-center">
          <h2 className="text-base font-semibold text-slate-900">登录后查看订单</h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-500">订单和支付状态绑定到手机号。登录后可完成模拟支付并查看到账记录。</p>
          <Link href="/account/login" className="mt-5 inline-flex rounded-lg bg-slate-950 px-4 py-2 text-sm font-semibold text-white">
            手机号登录
          </Link>
        </div>
      ) : orders.length === 0 ? (
        <div className="mt-6 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-8 text-center">
          <h2 className="text-base font-semibold text-slate-900">暂无订单</h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-500">从购买页选择会员、Token 包或图片视频次数包，下单后会出现在这里。</p>
          <Link href="/account/billing" className="mt-5 inline-flex rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-100">
            去购买
          </Link>
        </div>
      ) : (
        <div className="mt-6 overflow-hidden rounded-lg border border-slate-200">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-4 py-3">商品</th>
                <th className="px-4 py-3">金额</th>
                <th className="px-4 py-3">支付方式</th>
                <th className="px-4 py-3">状态</th>
                <th className="px-4 py-3 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {orders.map((order) => (
                <tr key={order.id}>
                  <td className="px-4 py-4">
                    <div className="font-medium text-slate-950">{order.productName}</div>
                    <div className="mt-1 text-xs text-slate-500">{unitLabel(order)} · {order.id}</div>
                  </td>
                  <td className="px-4 py-4">{formatMoney(order.amountCents, order.currency)}</td>
                  <td className="px-4 py-4">{order.provider === "wechat" ? "微信" : "支付宝"}</td>
                  <td className="px-4 py-4">
                    <span className={order.status === "paid" ? "text-emerald-700" : "text-amber-700"}>{statusLabel(order.status)}</span>
                  </td>
                  <td className="px-4 py-4 text-right">
                    {order.status === "pending" && fakePaymentsEnabled ? (
                      <form action={mockPayBillingOrderAction}>
                        <input type="hidden" name="orderId" value={order.id} />
                        <AccountSubmitButton
                          className="rounded-lg bg-slate-950 px-3 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                          pendingChildren="支付中..."
                        >
                          模拟支付完成
                        </AccountSubmitButton>
                      </form>
                    ) : order.status === "paid" ? (
                      <Link href="/account/entitlements" className="text-sm font-medium text-slate-700 hover:text-slate-950">
                        查看权益
                      </Link>
                    ) : (
                      <span className="text-xs text-slate-400">不可支付</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
