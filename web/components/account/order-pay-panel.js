"use client";

// Paying one order, start to finish:
//
//   pending ─start─▶ redirecting (Alipay page/wap)  ─┐
//                 └▶ qrcode (Alipay 当面付 / WeChat)  ─┤ poll status (+ on tab return)
//                                                     ▼
//                                          paid · closed · refunded
//
// The page never decides the order is paid: it only asks. The API asks the
// provider while the order is unpaid, so a buyer coming back from Alipay sees
// "已到账" within seconds even when the provider's notification is late.

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatMoney, orderStatusLabel, paymentErrorMessage, PROVIDER_LABEL, unitLabel } from "../../lib/billing-format.mjs";

const TERMINAL = new Set(["paid", "closed", "refunded", "partially_refunded"]);

function isMobile() {
  return typeof navigator !== "undefined" && /Android|iPhone|iPad|iPod|HarmonyOS|Mobile/i.test(navigator.userAgent || "");
}

function remaining(expiresAt, now) {
  const ms = Date.parse(expiresAt || "") - now;
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m ? `${m} 分 ${s % 60} 秒` : `${s} 秒`;
}

export function OrderPayPanel({ initialOrder, autoStart = false }) {
  const [order, setOrder] = useState(initialOrder);
  const [phase, setPhase] = useState(TERMINAL.has(initialOrder.status) ? "done" : "idle"); // idle|starting|redirecting|qrcode|done|error
  const [checkout, setCheckout] = useState(null);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const started = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/account/orders/${encodeURIComponent(order.id)}/status`, { cache: "no-store" });
      const json = await res.json();
      if (json?.ok && json.order) {
        setOrder(json.order);
        if (TERMINAL.has(json.order.status)) setPhase("done");
      }
    } catch { /* next poll */ }
  }, [order.id]);

  const start = useCallback(async () => {
    setPhase("starting");
    setError("");
    try {
      const res = await fetch(`/account/orders/${encodeURIComponent(order.id)}/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client: isMobile() ? "mobile" : "desktop" }),
      });
      const json = await res.json();
      if (!json?.ok) {
        setPhase("error");
        setError(paymentErrorMessage(json?.code));
        if (json?.code === "ORDER_ALREADY_PAID" || json?.code === "ORDER_NOT_PAYABLE" || json?.code === "ORDER_EXPIRED") void refresh();
        return;
      }
      setCheckout(json.checkout);
      if (json.checkout.kind === "redirect") {
        setPhase("redirecting");
        window.location.assign(json.checkout.url);
      } else {
        setPhase("qrcode");
      }
    } catch {
      setPhase("error");
      setError(paymentErrorMessage("NETWORK_ERROR"));
    }
  }, [order.id, refresh]);

  // Coming back from the checkout, or opening with ?pay=1: go.
  useEffect(() => {
    if (autoStart && !started.current && order.status === "pending") {
      started.current = true;
      void start();
    }
  }, [autoStart, order.status, start]);

  // While unpaid: poll, faster at first; and at once when the tab regains focus.
  useEffect(() => {
    if (TERMINAL.has(order.status)) return undefined;
    let stopped = false;
    let delay = 2500;
    let timer;
    const loop = async () => {
      if (stopped) return;
      await refresh();
      delay = Math.min(10_000, delay + 500);
      timer = setTimeout(loop, delay);
    };
    timer = setTimeout(loop, delay);
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { stopped = true; clearTimeout(timer); clearInterval(tick); document.removeEventListener("visibilitychange", onVisible); };
  }, [order.status, refresh]);

  const expiresIn = remaining(order.expiresAt, now);
  const provider = PROVIDER_LABEL[order.provider] || order.provider;

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-6">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm text-slate-500">订单 {order.id}</p>
          <h1 className="mt-1 text-xl font-semibold text-slate-950">{order.productName}</h1>
          <p className="mt-1 text-sm text-slate-500">{unitLabel(order)} · {provider}</p>
        </div>
        <div className="text-left sm:text-right">
          <div className="text-2xl font-semibold tabular-nums">{formatMoney(order.amountCents, order.currency)}</div>
          <div className="mt-1 text-sm text-slate-500">{orderStatusLabel(order.status)}</div>
        </div>
      </div>

      <div className="mt-6 rounded-lg bg-slate-50 p-5">
        {order.status === "paid" ? (
          <div>
            <p className="text-base font-semibold text-emerald-700">支付成功，权益已到账</p>
            <p className="mt-1 text-sm text-slate-600">桌面客户端回到前台时会自动刷新额度，无需手动操作。</p>
            <div className="mt-4 flex flex-wrap gap-3 text-sm">
              <Link href="/account/bills" className="rounded-lg bg-slate-950 px-4 py-2 font-semibold text-white">查看账单</Link>
              <Link href="/account/entitlements" className="rounded-lg border border-slate-300 px-4 py-2 font-medium text-slate-700">查看权益</Link>
            </div>
          </div>
        ) : order.status === "closed" ? (
          <div>
            <p className="text-base font-semibold text-slate-700">订单已超时关闭</p>
            <p className="mt-1 text-sm text-slate-600">没有产生扣款。如需购买，请重新下单。</p>
            <Link href="/account/billing" className="mt-4 inline-flex rounded-lg bg-slate-950 px-4 py-2 text-sm font-semibold text-white">重新下单</Link>
          </div>
        ) : order.status === "refunded" || order.status === "partially_refunded" ? (
          <div>
            <p className="text-base font-semibold text-slate-700">{orderStatusLabel(order.status)} {formatMoney(order.refundedCents, order.currency)}</p>
            <p className="mt-1 text-sm text-slate-600">退款原路退回，一般 1–3 个工作日到账。对应的未用权益已按比例收回。</p>
          </div>
        ) : phase === "qrcode" && checkout?.image ? (
          <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start sm:gap-6">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={checkout.image} alt={`${provider}付款码`} className="h-52 w-52 rounded-lg bg-white p-2 ring-1 ring-slate-200" />
            <div className="text-sm leading-6 text-slate-600">
              <p className="text-base font-semibold text-slate-900">用{order.provider === "wechat" ? "微信" : "支付宝"}扫码支付</p>
              <p>支付完成后此页面会自动更新。</p>
              {isMobile() ? <p className="mt-1 text-amber-700">在手机上：截图后在{order.provider === "wechat" ? "微信" : "支付宝"}里「扫一扫 → 相册」识别，或用另一台设备扫码。</p> : null}
              {expiresIn ? <p className="mt-2 tabular-nums text-slate-500">{expiresIn} 后订单关闭</p> : null}
              <span className="mt-3 inline-flex items-center gap-2 text-slate-500"><span className="h-2 w-2 animate-pulse rounded-full bg-sky-500" />等待支付结果…</span>
            </div>
          </div>
        ) : phase === "redirecting" ? (
          <p className="text-sm text-slate-600">正在前往{provider}…如果没有自动跳转，<button type="button" className="font-medium text-slate-900 underline" onClick={() => checkout?.url && window.location.assign(checkout.url)}>点这里</button>。</p>
        ) : (
          <div>
            <p className="text-sm text-slate-600">{phase === "starting" ? "正在发起支付…" : "确认信息无误后点击付款。支付结果以支付平台通知为准，此页面会自动更新。"}</p>
            {error ? <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p> : null}
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button type="button" onClick={() => void start()} disabled={phase === "starting"} className="rounded-lg bg-slate-950 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-60">
                {phase === "starting" ? "发起中…" : `使用${provider}付款`}
              </button>
              {expiresIn ? <span className="text-sm tabular-nums text-slate-500">{expiresIn} 后订单关闭</span> : null}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
