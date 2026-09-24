import Link from "next/link";
import { AdminShell } from "../../../../components/admin-shell";
import { AdminEmpty } from "../../../../components/admin-empty";
import { BillingAdminTabs } from "../../../../components/billing-admin-tabs";
import { reconcileBillingAction } from "../actions";
import { formatMoney, PROVIDER_LABEL } from "../../../../lib/billing-format.mjs";
import { loadAdmin } from "../../../../lib/api";

export const dynamic = "force-dynamic";

const RUN_STATUS = {
  matched: ["一致", "bg-emerald-50 text-emerald-700 ring-emerald-200"],
  mismatched: ["有差异", "bg-amber-50 text-amber-800 ring-amber-200"],
  failed: ["未取到账单", "bg-rose-50 text-rose-700 ring-rose-200"],
};

// Each kind of difference, and what the operator should do about it.
const MISMATCH = {
  amount_mismatch: "金额不一致 — 到支付平台核对这笔交易",
  unknown_trade: "支付平台有、我们没有的交易 — 可能是其他系统使用了同一商户号",
  unsettled_payment: "支付平台显示已付、但未能入账 — 打开订单点「向支付平台查询」",
  missing_at_provider: "我们记为已付、账单里没有 — 到支付平台核对，必要时退款",
};

const ERRORS = {
  RECONCILE_FAILED: "对账失败，请稍后重试。",
  BILL_NOT_READY: "该日账单尚未生成（通常次日 10 点后可用）。",
  PAYMENT_PROVIDER_UNAVAILABLE: "该支付方式未启用或配置不完整。",
};

function beijingYesterday() {
  const d = new Date(Date.now() + 8 * 3600 * 1000 - 24 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

function day(value) {
  return String(value || "").slice(0, 10);
}

export default async function ReconciliationPage({ searchParams }) {
  const sp = (await searchParams) || {};
  const { runs = [] } = await loadAdmin("/api/admin/billing/reconciliation", { runs: [] });
  const notice = sp.notice ? `${PROVIDER_LABEL[sp.provider] || sp.provider} ${sp.billDate}：${RUN_STATUS[sp.notice]?.[0] || sp.notice}` : "";
  const error = sp.error ? `${PROVIDER_LABEL[sp.provider] || sp.provider || ""} ${sp.billDate || ""}：${ERRORS[sp.error] || sp.error}` : "";

  return (
    <AdminShell title="对账" subtitle="每天上午自动下载支付宝、微信前一天的账单，与我们的订单逐笔比对；漏掉的到账会自动补上。">
      <BillingAdminTabs active="reconciliation" />
      {notice ? <p className="mb-4 rounded-lg bg-emerald-50 px-4 py-2 text-sm text-emerald-800">{notice}</p> : null}
      {error ? <p className="mb-4 rounded-lg bg-rose-50 px-4 py-2 text-sm text-rose-700">{error}</p> : null}

      <form action={reconcileBillingAction} className="mb-5 flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4 text-sm">
        <label className="text-xs text-slate-500">支付方式
          <select name="provider" defaultValue={sp.provider || "alipay"} className="mt-1 block rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm">
            <option value="alipay">支付宝</option>
            <option value="wechat">微信支付</option>
          </select>
        </label>
        <label className="text-xs text-slate-500">账单日期（北京时间）
          <input type="date" name="billDate" required defaultValue={sp.billDate || beijingYesterday()} className="mt-1 block rounded-lg border border-slate-300 px-3 py-2 text-sm" />
        </label>
        <button className="rounded-lg bg-slate-950 px-4 py-2 font-semibold text-white hover:bg-slate-800">立即对账</button>
        <span className="text-xs text-slate-500">同一天重复对账会覆盖上次结果。</span>
      </form>

      {runs.length ? (
        <div className="space-y-3">
          {runs.map((run) => {
            const summary = run.summary || {};
            const mismatches = summary.mismatches || [];
            const [label, tone] = RUN_STATUS[run.status] || [run.status, "bg-slate-100 text-slate-600 ring-slate-200"];
            return (
              <details key={run.id} className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm" open={run.status !== "matched" && runs.indexOf(run) < 3}>
                <summary className="flex cursor-pointer flex-wrap items-center gap-3">
                  <span className="tabular-nums font-medium">{day(run.bill_date)}</span>
                  <span>{PROVIDER_LABEL[run.provider] || run.provider}</span>
                  <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${tone}`}>{label}</span>
                  {run.status !== "failed" ? (
                    <span className="text-slate-500">平台 {summary.providerPayments ?? 0} 笔 · 我们 {summary.ourPayments ?? 0} 笔{summary.healed ? ` · 自动补单 ${summary.healed} 笔` : ""}</span>
                  ) : <span className="text-slate-500">{summary.error}{summary.detail ? ` ${summary.detail}` : ""}</span>}
                </summary>
                {mismatches.length ? (
                  <ul className="mt-3 space-y-1.5">
                    {mismatches.map((m, i) => (
                      <li key={`${m.outTradeNo}-${i}`} className="flex flex-wrap gap-x-3">
                        <span className="font-mono text-xs">{m.outTradeNo}</span>
                        <span className="text-amber-800">{MISMATCH[m.type] || m.type}</span>
                        {m.ours != null ? <span className="tabular-nums text-slate-500">我们 {formatMoney(m.ours)}</span> : null}
                        {m.theirs != null ? <span className="tabular-nums text-slate-500">平台 {formatMoney(m.theirs)}</span> : null}
                        <Link href={`/admin/billing/orders?q=${encodeURIComponent(m.outTradeNo)}`} className="text-xs underline">查订单</Link>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </details>
            );
          })}
        </div>
      ) : (
        <AdminEmpty title="还没有对账记录" description="启用支付后，系统每天上午自动对前一天的账单；也可以在上方手动对账。" />
      )}
    </AdminShell>
  );
}
