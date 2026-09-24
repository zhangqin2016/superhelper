import Link from "next/link";
import { AdminShell } from "../../../../../components/admin-shell";
import { BillingAdminTabs } from "../../../../../components/billing-admin-tabs";
import { refundBillingOrderAction, syncBillingOrderAction } from "../../actions";
import { centsToYuan, EVENT_KIND, EVENT_OUTCOME, eventOutcomeLabel, formatMoney, ORDER_STATUS, orderStatusLabel, PROVIDER_LABEL, TONE_CLASS, unitLabel } from "../../../../../lib/billing-format.mjs";
import { loadAdmin } from "../../../../../lib/api";

export const dynamic = "force-dynamic";

const PAYMENT_STATUS = { pending: "待支付", succeeded: "已支付", closed: "已关闭", failed: "失败" };
const REFUND_STATUS = { pending: "处理中", processing: "处理中", succeeded: "已退款", failed: "失败" };
const METHOD = { page: "电脑网站", wap: "手机网站", precreate: "扫码（当面付）", native: "扫码（Native）" };

// Outcomes of the operator's own action, said plainly.
const NOTICE = {
  synced: "已向支付平台查询",
  refunded: "退款成功，对应权益已按比例收回",
  refund_processing: "退款已提交，支付平台处理中；结果由系统自动跟进",
};
const ERROR = {
  REFUND_NOT_CONFIRMED: "请勾选确认后再退款。",
  REFUND_AMOUNT_INVALID: "退款金额不对：格式如 9.90，且不能超过可退余额。",
  REFUND_REASON_REQUIRED: "请填写退款原因。",
  ORDER_NOT_REFUNDABLE: "这个订单当前不能退款。",
  REFUND_FAILED: "退款失败，请稍后重试或到支付平台核对。",
  SYNC_FAILED: "查询失败，请稍后重试。",
};

function when(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Asia/Shanghai" }).format(new Date(value));
}

function Row({ label, children }) {
  return (
    <div className="flex gap-4 py-1.5 text-sm">
      <dt className="w-24 shrink-0 text-slate-500">{label}</dt>
      <dd className="min-w-0 break-all text-slate-900">{children}</dd>
    </div>
  );
}

export default async function AdminOrderDetailPage({ params, searchParams }) {
  const { orderId } = await params;
  const sp = (await searchParams) || {};
  const data = await loadAdmin(`/api/admin/billing/orders/${encodeURIComponent(orderId)}`, { order: null });
  const order = data.order;
  if (!order) {
    return (
      <AdminShell title="订单" subtitle="">
        <BillingAdminTabs active="orders" />
        <p className="text-sm text-slate-600">找不到订单 {orderId}。<Link href="/admin/billing/orders" className="underline">返回订单列表</Link></p>
      </AdminShell>
    );
  }
  const refunds = order.refunds || [];
  const inFlight = refunds.filter((r) => r.status === "pending" || r.status === "processing").reduce((a, r) => a + Number(r.amount_cents), 0);
  const refundable = Math.max(0, Number(order.amount_cents) - Number(order.refunded_cents || 0) - inFlight);
  const canRefund = (order.status === "paid" || order.status === "partially_refunded") && refundable > 0;
  const canSync = (order.payments || []).some((p) => p.status === "pending" || p.status === "closed");
  const notice = NOTICE[sp.notice];
  const error = sp.error ? ERROR[sp.error] || `操作失败：${sp.error}` : "";

  return (
    <AdminShell title={`订单 ${order.id}`} subtitle={`${order.product_name || order.product_id} · ${unitLabel({ resourceType: order.resource_type, unitAmount: order.unit_amount })}`}>
      <BillingAdminTabs active="orders" />
      <Link href="/admin/billing/orders" className="mb-4 inline-flex text-sm text-slate-500 hover:text-slate-800">← 订单列表</Link>
      {notice ? <p className="mb-4 rounded-lg bg-emerald-50 px-4 py-2 text-sm text-emerald-800">{notice}{sp.notice === "synced" && sp.detail ? `（${sp.detail.split(",").map((o) => EVENT_OUTCOME[o] || o).join("、")}）` : ""}</p> : null}
      {error ? <p className="mb-4 rounded-lg bg-rose-50 px-4 py-2 text-sm text-rose-700">{error}</p> : null}

      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="flex items-center justify-between">
            <span className="text-2xl font-semibold tabular-nums">{formatMoney(order.amount_cents, order.currency)}</span>
            <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ring-1 ${TONE_CLASS[ORDER_STATUS[order.status]?.tone || "slate"]}`}>{orderStatusLabel(order.status)}</span>
          </div>
          <dl className="mt-4 divide-y divide-slate-100">
            <Row label="用户">{order.phone || "—"} <span className="font-mono text-xs text-slate-500">{order.user_id}</span></Row>
            <Row label="支付方式">{PROVIDER_LABEL[order.provider] || order.provider}</Row>
            <Row label="支付平台单号"><span className="font-mono text-xs">{order.provider_order_id || "—"}</span></Row>
            <Row label="下单">{when(order.created_at)}</Row>
            <Row label="支付">{when(order.paid_at)}</Row>
            <Row label="超时关闭">{order.closed_at ? when(order.closed_at) : order.status === "pending" ? `${when(order.expires_at)} 前未付将关闭` : "—"}</Row>
            <Row label="已退款">{formatMoney(order.refunded_cents || 0, order.currency)}</Row>
          </dl>
        </section>

        <aside className="space-y-4">
          {canSync ? (
            <form action={syncBillingOrderAction} className="rounded-xl border border-slate-200 bg-white p-4">
              <input type="hidden" name="id" value={order.id} />
              <p className="text-sm text-slate-600">用户说付了但没到账？立即向支付平台查询，已付款会马上入账。</p>
              <button className="mt-3 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold hover:bg-slate-50">向支付平台查询</button>
            </form>
          ) : null}
          {canRefund ? (
            <form action={refundBillingOrderAction} className="rounded-xl border border-slate-200 bg-white p-4">
              <input type="hidden" name="id" value={order.id} />
              <h2 className="text-sm font-semibold">退款</h2>
              <p className="mt-1 text-xs text-slate-500">原路退回，可退 {formatMoney(refundable, order.currency)}。未用完的权益按退款比例收回。</p>
              <label className="mt-3 block text-xs text-slate-500">金额（元，留空为全部可退）
                <input name="amountYuan" inputMode="decimal" placeholder={centsToYuan(refundable)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500" />
              </label>
              <label className="mt-3 block text-xs text-slate-500">原因（写入审计记录）
                <input name="reason" required maxLength={200} placeholder="例如：用户误购" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500" />
              </label>
              <label className="mt-3 flex items-center gap-2 text-xs text-slate-600">
                <input type="checkbox" name="confirm" value="yes" required /> 我确认退款，此操作不可撤销
              </label>
              <button className="mt-3 w-full rounded-lg bg-rose-600 px-3 py-2 text-sm font-semibold text-white hover:bg-rose-700">退款</button>
            </form>
          ) : null}
        </aside>
      </div>

      <section className="mt-6">
        <h2 className="mb-2 text-base font-semibold">支付尝试</h2>
        <div className="table-card overflow-x-auto p-4">
          {(order.payments || []).length ? (
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-slate-500"><tr><th className="px-4 py-2">支付单号</th><th className="px-4 py-2">方式</th><th className="px-4 py-2 text-right">金额</th><th className="px-4 py-2">状态</th><th className="px-4 py-2">平台交易号</th><th className="px-4 py-2">发起</th><th className="px-4 py-2">最近查询</th></tr></thead>
              <tbody>
                {order.payments.map((p) => (
                  <tr key={p.id} className="border-t border-slate-100">
                    <td className="px-4 py-2 font-mono text-xs">{p.id}</td>
                    <td className="px-4 py-2">{PROVIDER_LABEL[p.provider] || p.provider} · {METHOD[p.method] || p.method}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatMoney(p.amount_cents, p.currency)}</td>
                    <td className="whitespace-nowrap px-4 py-2">{PAYMENT_STATUS[p.status] || p.status}</td>
                    <td className="px-4 py-2 font-mono text-xs">{p.provider_trade_no || "—"}</td>
                    <td className="whitespace-nowrap px-4 py-2 tabular-nums text-slate-500">{when(p.created_at)}</td>
                    <td className="whitespace-nowrap px-4 py-2 tabular-nums text-slate-500">{when(p.last_synced_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="text-sm text-slate-500">用户还没有发起支付。</p>}
        </div>
      </section>

      {refunds.length ? (
        <section className="mt-6">
          <h2 className="mb-2 text-base font-semibold">退款</h2>
          <div className="table-card overflow-x-auto p-4">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-slate-500"><tr><th className="px-4 py-2">退款单号</th><th className="px-4 py-2 text-right">金额</th><th className="px-4 py-2">状态</th><th className="px-4 py-2">原因</th><th className="px-4 py-2">发起方</th><th className="px-4 py-2">时间</th></tr></thead>
              <tbody>
                {refunds.map((r) => (
                  <tr key={r.id} className="border-t border-slate-100 align-top">
                    <td className="px-4 py-2 font-mono text-xs">{r.id}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatMoney(r.amount_cents, order.currency)}</td>
                    <td className="whitespace-nowrap px-4 py-2">{REFUND_STATUS[r.status] || r.status}{r.error ? <div className="text-xs text-rose-600">{r.error}</div> : null}</td>
                    <td className="px-4 py-2">{r.reason || "—"}</td>
                    <td className="px-4 py-2">{r.actor === "system" ? "系统（重复支付自动退款）" : r.actor || "—"}</td>
                    <td className="whitespace-nowrap px-4 py-2 tabular-nums text-slate-500">{when(r.succeeded_at || r.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {(order.grants || []).length ? (
        <section className="mt-6">
          <h2 className="mb-2 text-base font-semibold">发放的权益</h2>
          <div className="table-card overflow-x-auto p-4">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-slate-500"><tr><th className="px-4 py-2">权益</th><th className="px-4 py-2 text-right">总量</th><th className="px-4 py-2 text-right">剩余</th><th className="px-4 py-2">到期</th></tr></thead>
              <tbody>
                {order.grants.map((g) => (
                  <tr key={g.id} className="border-t border-slate-100">
                    <td className="px-4 py-2 font-mono text-xs">{g.id} · {g.resource_type}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{Number(g.unit_total).toLocaleString("zh-CN")}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{Number(g.unit_remaining).toLocaleString("zh-CN")}</td>
                    <td className="whitespace-nowrap px-4 py-2 tabular-nums text-slate-500">{when(g.expires_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section className="mt-6">
        <h2 className="mb-2 text-base font-semibold">支付平台往来</h2>
        <div className="table-card overflow-x-auto p-4">
          {(order.events || []).length ? (
            <ol className="space-y-2 text-sm">
              {order.events.map((e) => (
                <li key={e.id} className="flex flex-wrap gap-x-3">
                  <span className="whitespace-nowrap tabular-nums text-slate-500">{when(e.created_at)}</span>
                  <span className="text-slate-600">{EVENT_KIND[e.kind] || e.kind}</span>
                  <span className={["rejected", "error", "double_paid"].includes(e.outcome) ? "font-medium text-rose-700" : "font-medium text-slate-900"}>{eventOutcomeLabel(e)}</span>
                  {e.verified ? <span className="text-xs text-emerald-700">已验签</span> : null}
                  {e.detail ? <span className="text-slate-500">{e.detail}</span> : null}
                </li>
              ))}
            </ol>
          ) : <p className="text-sm text-slate-500">暂无记录。</p>}
        </div>
      </section>
    </AdminShell>
  );
}
