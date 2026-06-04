"use client";

import { useActionState } from "react";
import { loginAction } from "../app/admin/actions";
import { useI18n } from "../lib/use-i18n";

const initialState = { ok: null, message: "" };

export function AdminLoginForm() {
  const [state, action, pending] = useActionState(loginAction, initialState);
  const { t } = useI18n();

  return (
    <form action={action} className="space-y-4">
      <label className="block">
        <span className="mb-2 block text-sm font-medium text-slate-700">{t.admin.email}</span>
        <input
          className="w-full rounded-lg border border-slate-200 bg-white px-3 py-3 text-sm outline-none focus:border-brand"
          name="email"
          type="email"
          autoComplete="username"
          required
        />
      </label>
      <label className="block">
        <span className="mb-2 block text-sm font-medium text-slate-700">{t.admin.password}</span>
        <input
          className="w-full rounded-lg border border-slate-200 bg-white px-3 py-3 text-sm outline-none focus:border-brand"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </label>
      {state?.message ? <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800">{state.message}</p> : null}
      <button className="w-full rounded-lg bg-brand px-4 py-3 font-semibold text-white disabled:opacity-60" disabled={pending}>
        {pending ? t.admin.checking : t.admin.continue}
      </button>
    </form>
  );
}
