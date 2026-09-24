import Link from "next/link";
import { mockPayBillingOrderAction } from "../actions";
import { userApiGetResult } from "../../../lib/user-api";
import { AccountSubmitButton } from "../../../components/account-submit-button";
import { formatMoney, ORDER_STATUS, orderStatusLabel, PROVIDER_LABEL, TONE_CLASS, unitLabel } from "../../../lib/billing-format.mjs";

export const dynamic = "force-dynamic";

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
          <p className="mt-2 text-sm text-slate-500">待支付的订单可以继续付款；支付成功后权益立即到账。未支付的订单 30 分钟后自动关闭，不会扣款。</p>
        </div>
        <Link href="/account/billing" className="inline-flex rounded-lg bg-slate-950 px-4 py-2 text-sm font-semibold text-white">
          继续购买
        </Link>
      </div>

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
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-500">订单和支付状态绑定到手机号。登录后可继续支付并查看到账记录。</p>
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
                  <td className="px-4 py-4">{PROVIDER_LABEL[order.provider] || order.provider}</td>
                  <td className="px-4 py-4">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${TONE_CLASS[ORDER_STATUS[order.status]?.tone || "slate"]}`}>{orderStatusLabel(order.status)}</span>
                    {order.refundedCents ? <div className="mt-1 text-xs text-slate-500">已退 {formatMoney(order.refundedCents, order.currency)}</div> : null}
                  </td>
                  <td className="px-4 py-4 text-right">
                    <div className="flex flex-col items-end gap-2">
                      {order.status === "pending" ? (
                        <Link href={`/account/orders/${encodeURIComponent(order.id)}?pay=1`} className="rounded-lg bg-slate-950 px-3 py-2 text-xs font-semibold text-white">继续支付</Link>
                      ) : (
                        <Link href={`/account/orders/${encodeURIComponent(order.id)}`} className="text-sm font-medium text-slate-700 hover:text-slate-950">详情</Link>
                      )}
                      {order.status === "pending" && fakePaymentsEnabled ? (
                        <form action={mockPayBillingOrderAction}>
                          <input type="hidden" name="orderId" value={order.id} />
                          <AccountSubmitButton className="text-xs text-slate-500 underline disabled:opacity-60" pendingChildren="支付中...">模拟支付（测试环境）</AccountSubmitButton>
                        </form>
                      ) : null}
                    </div>
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
