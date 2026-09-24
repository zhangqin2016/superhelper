import Link from "next/link";
import { formatMoney, PROVIDER_LABEL, resourceUnits } from "../../../lib/billing-format.mjs";
import { userApiGetResult } from "../../../lib/user-api";

export const dynamic = "force-dynamic";

// The buyer's own books: what they have left (and until when), what they
// bought and got back, and what their usage cost — the same ledger the
// wallet debits, read-only.

const KINDS = [
  ["all", "全部"],
  ["topup", "充值与退款"],
  ["usage", "使用扣费"],
];

function when(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai" }).format(new Date(value));
}

function day(value) {
  return value ? new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Asia/Shanghai" }).format(new Date(value)) : "";
}

export default async function AccountBillsPage({ searchParams }) {
  const params = await searchParams;
  const kind = KINDS.some(([k]) => k === params?.kind) ? params.kind : "all";
  const before = typeof params?.before === "string" ? params.before : "";
  const qs = new URLSearchParams({ kind, limit: "50", ...(before ? { before } : {}) });
  const [statement, balance, usage] = await Promise.all([
    userApiGetResult(`/api/billing/statement?${qs}`),
    userApiGetResult("/api/billing/balance"),
    userApiGetResult("/api/billing/usage-summary?days=30"),
  ]);
  if (!statement.ok && (statement.status === 401 || /USER_LOGIN_REQUIRED|WEB_SESSION/.test(statement.code || ""))) {
    return (
      <section className="rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center">
        <h1 className="text-lg font-semibold">登录后查看账单</h1>
        <Link href="/account/login?next=/account/bills" className="mt-4 inline-flex rounded-lg bg-slate-950 px-4 py-2 text-sm font-semibold text-white">手机号登录</Link>
      </section>
    );
  }
  const lines = statement.ok ? statement.data.lines || [] : [];
  const nextBefore = statement.ok ? statement.data.nextBefore || "" : "";
  const grants = balance.ok ? balance.data.grants || [] : [];
  const byModel = usage.ok ? usage.data.byModel || [] : [];
  // What the buyer holds, per resource; the grants behind it on demand.
  const totals = [...grants.reduce((map, g) => {
    const t = map.get(g.resourceType) || { resourceType: g.resourceType, resourceLabel: g.resourceLabel, remaining: 0, count: 0, soonestExpiry: "", latestExpiry: "" };
    t.remaining += g.remaining;
    t.count += 1;
    if (g.expiresAt && (!t.soonestExpiry || g.expiresAt < t.soonestExpiry)) t.soonestExpiry = g.expiresAt;
    if (g.expiresAt && g.expiresAt > t.latestExpiry) t.latestExpiry = g.expiresAt;
    return map.set(g.resourceType, t);
  }, new Map()).values()];

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold">账单</h1>
            <p className="mt-1 text-sm text-slate-500">每一笔充值、退款和使用扣费都在这里，和实际扣减的额度一致。</p>
          </div>
          <Link href="/account/billing" className="inline-flex rounded-lg bg-slate-950 px-4 py-2 text-sm font-semibold text-white">购买额度</Link>
        </div>
        <h2 className="mt-6 text-sm font-semibold text-slate-500">当前可用</h2>
        {totals.length ? (
          <>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {totals.map((r) => (
                <div key={r.resourceType} className="rounded-lg border border-slate-200 p-4">
                  <div className="text-xs text-slate-500">{r.resourceLabel}</div>
                  <div className="mt-1 text-lg font-semibold tabular-nums">{r.resourceType === "membership" ? `会员至 ${day(r.latestExpiry)}` : resourceUnits(r.resourceType, r.remaining)}</div>
                  {r.resourceType !== "membership" ? <div className="mt-2 text-xs text-slate-500">{r.count > 1 ? `${r.count} 笔，最早 ${day(r.soonestExpiry)} 到期` : `${day(r.soonestExpiry)} 到期`}</div> : null}
                </div>
              ))}
            </div>
            {grants.length > 1 ? (
              <details className="mt-3 text-sm">
                <summary className="cursor-pointer text-slate-500">按笔查看（先到期的先用）</summary>
                <ul className="mt-2 divide-y divide-slate-100">
                  {grants.map((g) => (
                    <li key={g.id} className="flex flex-wrap items-center gap-x-4 py-2">
                      <span className="w-28 text-slate-600">{g.resourceLabel} · {g.source === "purchase" ? "购买" : g.source === "signup" ? "赠送" : "发放"}</span>
                      <span className="tabular-nums">{g.resourceType === "membership" ? "会员" : `${resourceUnits(g.resourceType, g.remaining)} / ${resourceUnits(g.resourceType, g.total)}`}</span>
                      <span className="ms-auto tabular-nums text-slate-500">{day(g.expiresAt)} 到期</span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </>
        ) : <p className="mt-3 text-sm text-slate-500">当前没有可用额度。</p>}
      </section>

      {byModel.length ? (
        <section className="rounded-lg border border-slate-200 bg-white p-6">
          <h2 className="text-base font-semibold">近 30 天使用</h2>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-slate-500"><tr><th className="py-2 pr-4">功能</th><th className="py-2 pr-4">模型</th><th className="py-2 pr-4 text-right">次数</th><th className="py-2 text-right">消耗</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {byModel.map((m) => (
                  <tr key={`${m.feature}|${m.model}|${m.resourceType}`}>
                    <td className="py-2 pr-4">{m.featureLabel || m.feature}</td>
                    <td className="py-2 pr-4 text-slate-600">{m.model || "—"}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{m.calls.toLocaleString("zh-CN")}</td>
                    <td className="py-2 text-right tabular-nums">{resourceUnits(m.resourceType, m.units)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold">明细</h2>
          <nav className="inline-flex overflow-hidden rounded-lg border border-slate-300 text-sm">
            {KINDS.map(([k, label]) => (
              <Link key={k} href={`/account/bills?kind=${k}`} aria-current={k === kind ? "true" : undefined}
                className={`border-s border-slate-300 px-3 py-1.5 first:border-s-0 ${k === kind ? "bg-slate-900 font-medium text-white" : "text-slate-700 hover:bg-slate-50"}`}>{label}</Link>
            ))}
          </nav>
        </div>
        {!statement.ok ? <p className="mt-4 text-sm text-rose-700">账单暂时无法读取，请稍后刷新。</p> : lines.length === 0 ? (
          <p className="mt-4 text-sm text-slate-500">{before ? "没有更早的记录了。" : "还没有记录。"}</p>
        ) : (
          <ul className="mt-4 divide-y divide-slate-100">
            {lines.map((l) => (
              <li key={l.id} className="flex items-center gap-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-slate-900">{l.title}</div>
                  <div className="mt-0.5 text-xs text-slate-500">
                    {when(l.at)}
                    {l.payProvider ? ` · ${PROVIDER_LABEL[l.payProvider] || l.payProvider}` : ""}
                    {l.kind === "usage" && (l.inputTokens || l.outputTokens) ? ` · 输入 ${l.inputTokens.toLocaleString("zh-CN")} / 输出 ${l.outputTokens.toLocaleString("zh-CN")}` : ""}
                  </div>
                </div>
                <div className="text-right">
                  <div className={`text-sm font-semibold tabular-nums ${l.units > 0 ? "text-emerald-700" : "text-slate-900"}`}>
                    {l.units ? `${l.units > 0 ? "+" : "-"}${resourceUnits(l.resourceType, l.units)}` : ""}
                  </div>
                  {l.moneyCents ? <div className="text-xs tabular-nums text-slate-500">{formatMoney(l.moneyCents)}</div> : null}
                  {l.orderId ? <Link href={`/account/orders/${encodeURIComponent(l.orderId)}`} className="text-xs text-slate-500 underline">订单</Link> : null}
                </div>
              </li>
            ))}
          </ul>
        )}
        {nextBefore ? (
          <Link href={`/account/bills?kind=${kind}&before=${encodeURIComponent(nextBefore)}`} className="mt-4 inline-flex text-sm font-medium text-slate-700 underline">更早的记录</Link>
        ) : null}
      </section>
    </div>
  );
}
