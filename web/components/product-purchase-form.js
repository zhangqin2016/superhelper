"use client";

import { useActionState } from "react";
import { createBillingOrderAction } from "../app/account/actions";
import { AccountSubmitButton } from "./account-submit-button";

const initialState = { ok: null, message: "" };

// submitLabel lets a plan say "订阅" / "续费"; the order flow is the same for every product.
export function ProductPurchaseForm({ productId, paymentProviders = [], submitLabel = "购买" }) {
  const [state, formAction] = useActionState(createBillingOrderAction, initialState);
  const providers = Array.isArray(paymentProviders) ? paymentProviders : [];
  const disabled = providers.length === 0;

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="productId" value={productId} />
      <div className="flex items-end gap-2">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-500">支付方式</span>
          <select name="payProvider" className="rounded-lg border border-slate-300 bg-white px-2 py-2 text-xs text-slate-700 disabled:cursor-not-allowed disabled:opacity-60" disabled={disabled}>
            {disabled ? <option value="">未启用</option> : null}
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>{provider.label || provider.id}</option>
            ))}
          </select>
        </label>
        <AccountSubmitButton
          className="rounded-lg border border-slate-300 px-3 py-2 font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
          pendingChildren="创建中..."
          disabled={disabled}
        >
          {submitLabel}
        </AccountSubmitButton>
      </div>
      {disabled ? (
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-600">在线支付即将开放。现在需要订阅或充值，请<a className="font-semibold text-brand" href="/contact">联系我们</a>。</p>
      ) : null}
      {state?.message ? (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-xs leading-5 text-red-700">{state.message}</p>
      ) : null}
    </form>
  );
}
