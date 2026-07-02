"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { loginAccountAction, sendAccountSmsAction } from "../app/account/actions";

const initialState = { ok: null, message: "", phone: "" };

export function AccountLoginForm({ next = "/account/billing" }) {
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [cooldownRemaining, setCooldownRemaining] = useState(0);
  const lastCooldownKeyRef = useRef("");
  const [sendState, sendAction, sending] = useActionState(sendAccountSmsAction, initialState);
  const [loginState, loginAction, loggingIn] = useActionState(loginAccountAction, initialState);
  const shownPhone = phone;
  const canSend = Boolean(shownPhone.trim()) && !sending && cooldownRemaining <= 0;
  const canLogin = Boolean(shownPhone.trim()) && code.trim().length >= 4 && !loggingIn;

  useEffect(() => {
    if (!sendState?.ok) return;
    if (sendState.phone) setPhone(sendState.phone);
    const cooldownKey = `${sendState.phone || ""}:${sendState.message || ""}`;
    if (lastCooldownKeyRef.current === cooldownKey) return;
    lastCooldownKeyRef.current = cooldownKey;
    setCooldownRemaining(60);
  }, [sendState]);

  useEffect(() => {
    if (!loginState?.phone) return;
    setPhone(loginState.phone);
  }, [loginState]);

  useEffect(() => {
    if (cooldownRemaining <= 0) return undefined;
    const timer = window.setTimeout(() => {
      setCooldownRemaining((value) => Math.max(0, value - 1));
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [cooldownRemaining]);

  return (
    <div className="space-y-4">
      <label className="block">
        <span className="mb-2 block text-sm font-medium text-slate-700">手机号</span>
        <input
          className="w-full rounded-lg border border-slate-200 px-3 py-3 text-sm outline-none focus:border-brand"
          value={shownPhone}
          onChange={(event) => setPhone(event.target.value)}
          placeholder="13800000000"
          inputMode="tel"
          autoComplete="tel"
          disabled={sending || loggingIn}
        />
      </label>

      <form action={sendAction}>
        <input type="hidden" name="phone" value={shownPhone} />
        <button className="w-full rounded-lg border border-slate-300 px-4 py-3 text-sm font-medium text-slate-700 disabled:cursor-not-allowed disabled:opacity-60" type="submit" disabled={!canSend}>
          {sending ? "发送中..." : cooldownRemaining > 0 ? `${cooldownRemaining}s 后重发` : "发送验证码"}
        </button>
      </form>

      <form action={loginAction} className="space-y-4">
        <input type="hidden" name="phone" value={shownPhone} />
        <input type="hidden" name="next" value={next} />
        <label className="block">
          <span className="mb-2 block text-sm font-medium text-slate-700">验证码</span>
          <input
            className="w-full rounded-lg border border-slate-200 px-3 py-3 text-sm outline-none focus:border-brand"
            name="code"
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
            placeholder="6 位验证码"
            inputMode="numeric"
            autoComplete="one-time-code"
            disabled={loggingIn}
          />
        </label>
        <p className="text-xs leading-5 text-slate-500">验证码 5 分钟内有效，请勿转发给他人。</p>
        {sendState?.message ? <p aria-live="polite" className={`rounded-lg px-3 py-2 text-sm ${sendState.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-800"}`}>{sendState.message}</p> : null}
        {loginState?.message ? <p aria-live="polite" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{loginState.message}</p> : null}
        <button className="w-full rounded-lg bg-slate-950 px-4 py-3 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60" type="submit" disabled={!canLogin}>
          {loggingIn ? "登录中..." : "登录"}
        </button>
      </form>
    </div>
  );
}
