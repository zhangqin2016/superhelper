"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { DangerForm } from "./danger-form";
import { useI18n } from "../lib/use-i18n";

/**
 * The forms of the platform enterprise pages.
 *
 * Two kinds, and the name says which: EnterpriseActionForm for a change that
 * costs nothing to redo (rename, a budget), EnterpriseDangerForm for anything
 * that freezes, takes back or moves money — it submits only through the shared
 * DangerForm, so the operator is always asked first. A gate
 * (test-admin-destructive-and-chrome) holds destructive actions to the second.
 *
 * Both show the action's own answer next to the control, in the operator's
 * language, and render an issued owner password from the action's result —
 * never from the URL.
 */

function useEnterpriseAction(action, onSuccess) {
  return useActionState(async (_previous, formData) => {
    const result = await action(formData);
    if (result?.ok && onSuccess) onSuccess(result);
    return result;
  }, null);
}

function Outcome({ state, pending }) {
  const { t } = useI18n();
  const copy = t?.admin?.enterprise || {};
  return (
    <>
      {pending ? <p role="status" className="text-sm text-slate-500">{copy.form?.pending}</p> : null}
      {!pending && state ? (
        <p role={state.ok ? "status" : "alert"} className={`text-sm ${state.ok ? "text-emerald-700" : "text-red-700"}`}>
          {state.message || (state.ok ? copy.form?.ok : copy.form?.failed)}
        </p>
      ) : null}
      {state?.ok && state.issued?.length ? <OwnerCredentials rows={state.issued} organizationId={state.organizationId} /> : null}
    </>
  );
}

export function EnterpriseActionForm({ action, onSuccess, className = "", children }) {
  const [state, submit, pending] = useEnterpriseAction(action, onSuccess);
  return (
    <form action={submit} className={className}>
      <fieldset disabled={pending} className="contents">{children}</fieldset>
      <Outcome state={state} pending={pending} />
    </form>
  );
}

/**
 * `confirm` is the question the operator answers; `name` names what it is about.
 * `onSuccess` lets a form clear what it just did, so a second click cannot
 * repeat a grant by accident.
 */
export function EnterpriseDangerForm({ action, confirm, name = "", onSuccess, className = "", children }) {
  const [state, submit, pending] = useEnterpriseAction(action, onSuccess);
  return (
    <DangerForm action={submit} confirm={confirm} name={name} className={className}>
      <fieldset disabled={pending} className="contents">{children}</fieldset>
      <Outcome state={state} pending={pending} />
    </DangerForm>
  );
}

/**
 * An owner's one-time credentials. Said as what they are — the OWNER's initial
 * password, which the platform can reissue only until the owner activates —
 * not the employee copy the enterprise console uses.
 */
export function OwnerCredentials({ rows = [], organizationId = "" }) {
  const { t } = useI18n();
  const copy = t?.admin?.enterprise?.credentials || {};
  const [copied, setCopied] = useState(false);
  const list = rows.filter((row) => row && row.l && row.p);
  if (!list.length) return null;
  const text = list.map((row) => `${row.l}\t${row.p}`).join("\n");
  return (
    <section className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50/50 p-4" aria-live="polite">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">{copy.title}</h3>
          <p className="mt-1 text-xs text-slate-600">{copy.body}</p>
        </div>
        <button
          type="button"
          onClick={() => {
            navigator.clipboard?.writeText(text).then(() => setCopied(true), () => setCopied(false));
          }}
          className="shrink-0 rounded-lg bg-slate-900 px-3 py-1.5 text-sm text-white hover:bg-slate-700"
        >
          {copied ? copy.copied : copy.copy}
        </button>
      </div>
      <table className="mt-3 w-full text-sm">
        <thead>
          <tr className="text-start text-xs text-slate-500">
            <th className="py-1 pe-4 text-start font-medium">{copy.loginName}</th>
            <th className="py-1 text-start font-medium">{copy.password}</th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {list.map((row) => (
            <tr key={row.l} className="border-t border-emerald-100">
              <td className="select-all py-1.5 pe-4 text-slate-900">{row.l}</td>
              <td className="select-all py-1.5 text-slate-900">{row.p}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {organizationId ? (
        <Link href={`/admin/enterprise/${encodeURIComponent(organizationId)}`} className="mt-3 inline-block text-sm font-semibold text-brand hover:underline">
          {copy.openOrg} →
        </Link>
      ) : null}
    </section>
  );
}
