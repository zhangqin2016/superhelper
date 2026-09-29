"use client";

import { useActionState } from "react";
import { DangerForm } from "./danger-form";
import EnterpriseCredentials from "./enterprise-credentials";
import { enterpriseConsoleText } from "../lib/enterprise-console-i18n.mjs";

/**
 * Every enterprise-console form: shows "submitting", then the action's own
 * sentence (never a raw server code — actions translate them), and any
 * one-time credentials the action returned.
 *
 * With `confirm`, the submit goes through the shared DangerForm, which asks
 * before it sends — the one way this console performs a destructive action.
 */
export default function EnterpriseActionForm({ action, locale, confirm = "", confirmName = "", className = "", children }) {
  const text = enterpriseConsoleText(locale).common;
  const [state, submit, pending] = useActionState(async (_previous, formData) => action(formData), null);
  const body = (
    <>
      <fieldset disabled={pending} className="contents">{children}</fieldset>
      {pending ? <p role="status" className="basis-full text-sm text-slate-500">{text.submitting}</p> : null}
      {!pending && state ? (
        <p role={state.ok ? "status" : "alert"} className={`basis-full text-sm ${state.ok ? "text-emerald-700" : "text-red-700"}`}>
          {state.message || (state.ok ? text.saved : text.failed)}
        </p>
      ) : null}
      {state?.issued ? <div className="basis-full"><EnterpriseCredentials credentials={state.issued} locale={locale} /></div> : null}
    </>
  );
  if (confirm) {
    return <DangerForm action={submit} confirm={confirm} name={confirmName} className={className}>{body}</DangerForm>;
  }
  return <form action={submit} className={className}>{body}</form>;
}
