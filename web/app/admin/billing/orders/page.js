import Link from "next/link";
import { AdminShell } from "../../../../components/admin-shell";
import { AdminEmpty } from "../../../../components/admin-empty";
import { BillingAdminTabs } from "../../../../components/billing-admin-tabs";
import { ListFilter } from "../../../../components/list-filter";
import { Pagination } from "../../../../components/pagination";
import { EVENT_OUTCOME, formatMoney, ORDER_STATUS, orderStatusLabel, PROVIDER_LABEL, TONE_CLASS } from "../../../../lib/billing-format.mjs";
import { loadAdmin } from "../../../../lib/api";

export const dynamic = "force-dynamic";

const STATUSES = ["all", "pending", "paid", "partially_refunded", "refunded", "closed"];

function when(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai" }).format(new Date(value));
}

export default async function AdminOrdersPage({ searchParams }) {
  const params = (await searchParams) || {};
  const status = STATUSES.includes(params.status) ? params.status : "all";
  const q = typeof params.q === "string" ? params.q.trim() : "";
  const cursor = String(params.cursor || "");
  const query = new URLSearchParams({ status });
  if (q) query.set("q", q);
  if (cursor) query.set("cursor", cursor);
  const [data, anomalies] = await Promise.all([
    loadAdmin(`/api/admin/billing/orders?${query}`, { orders: [], nextCursor: "", total: null, counts: {} }),
    loadAdmin("/api/admin/billing/payment-events", { events: [] }),
  ]);
  const orders = data.orders || [];
  const counts = data.counts || {};
  const all = Object.values(counts).reduce((a, b) => a + b, 0);
  const events = anomalies.events || [];
  const recent = events.filter((e) => Date.now() - Date.parse(e.created_at) < 7 * 24 * 3600 * 1000);

  return (
    <AdminShell title="订单" subtitle="每一笔购买的支付状态、到账与退款。支付结果以支付平台为准，系统会自动补查和关闭超时订单。">
      <BillingAdminTabs active="orders" />

      {recent.length ? (
        <details className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm">
          <summary className="cursor-pointer font-medium text-amber-800">近 7 天有 {recent.length} 条支付异常，点开查看</summary>
          <ul className="mt-3 space-y-1.5 text-amber-900">
            {recent.slice(0, 30).map((e) => (
              <li key={e.id} className="flex flex-wrap gap-x-3">
                <span className="tabular-nums text-amber-700">{when(e.created_at)}</span>
                <span>{PROVIDER_LABEL[e.provider] || e.provider}</span>
                <span className="font-medium">{EVENT_OUTCOME[e.outcome] || e.outcome}</span>
                {e.payment_id ? <span className="font-mono text-xs">{e.payment_id}</span> : null}
                {e.detail ? <span className="text-amber-700">{e.detail}</span> : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <div className="flex flex-wrap items-start justify-between gap-3">
        <ListFilter
          basePath="/admin/billing/orders"
          searchParams={params}
          param="status"
          value={status}
          options={STATUSES.map((s) => ({ value: s, label: `${s === "all" ? "全部" : orderStatusLabel(s)} ${s === "all" ? all : counts[s] || 0}` }))}
        />
        <form action="/admin/billing/orders" className="mb-3 flex gap-2 text-sm">
          <input type="hidden" name="status" value={status} />
          <input name="q" defaultValue={q} placeholder="订单号 / 手机号 / 支付单号" className="w-64 rounded-lg border border-slate-300 px-3 py-1.5 outline-none focus:border-slate-500" />
          <button className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-medium hover:bg-slate-50">搜索</button>
        </form>
      </div>

      <div className="table-card overflow-x-auto p-4">
        {orders.length ? (
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-4 py-2">下单时间</th>
                <th className="px-4 py-2">订单</th>
                <th className="px-4 py-2">用户</th>
                <th className="px-4 py-2">商品</th>
                <th className="px-4 py-2 text-right">金额</th>
                <th className="px-4 py-2">支付方式</th>
                <th className="px-4 py-2">状态</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id} className="border-t border-slate-100">
                  <td className="whitespace-nowrap px-4 py-2 tabular-nums text-slate-500">{when(o.created_at)}</td>
                  <td className="px-4 py-2"><Link href={`/admin/billing/orders/${encodeURIComponent(o.id)}`} className="font-mono text-xs text-slate-900 underline">{o.id}</Link></td>
                  <td className="px-4 py-2 tabular-nums">{o.phone || <span className="font-mono text-xs text-slate-500">{o.user_id}</span>}</td>
                  <td className="px-4 py-2">{o.product_name || o.product_id}</td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {formatMoney(o.amount_cents, o.currency)}
                    {Number(o.refunded_cents) ? <div className="text-xs text-slate-500">退 {formatMoney(o.refunded_cents, o.currency)}</div> : null}
                  </td>
                  <td className="px-4 py-2">{PROVIDER_LABEL[o.provider] || o.provider}</td>
                  <td className="px-4 py-2">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${TONE_CLASS[ORDER_STATUS[o.status]?.tone || "slate"]}`}>{orderStatusLabel(o.status)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <AdminEmpty title={q ? "没有匹配的订单" : "还没有订单"} description={q ? "换个订单号、手机号或支付单号试试。" : "用户在官网下单后会出现在这里。"} />
        )}
      </div>
      <Pagination basePath="/admin/billing/orders" searchParams={params} shown={orders.length} total={data.total ?? null} nextCursor={data.nextCursor || ""} cursor={cursor} />
    </AdminShell>
  );
}
