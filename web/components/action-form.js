"use client";

import { useActionState } from "react";
import IssuedCredentials from "./issued-credentials";

export default function ActionForm({ action, children, className }) {
  const [state, submit, pending] = useActionState(async (_previous, formData) => action(formData), null);
  return <form action={submit} className={className}>
    <fieldset disabled={pending} className="contents">{children}</fieldset>
    {pending && <p role="status" className="text-sm text-slate-500">正在提交…</p>}
    {state && <p role={state.ok ? "status" : "alert"} className={`text-sm ${state.ok ? "text-emerald-700" : "text-red-700"}`}>{state.message || (state.ok ? "操作成功" : "操作失败")}</p>}
    {state?.issued && <IssuedCredentials credentials={state.issued} />}
  </form>;
}
