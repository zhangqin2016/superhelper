"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { setByokRequiresPlanAction } from "../app/admin/billing/actions";
import { DangerForm } from "./danger-form";
import { useI18n } from "../lib/use-i18n";

function Toggle({ label, pendingLabel, on }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending ? "true" : "false"}
      className={`rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-60 ${on ? "border border-slate-300 bg-white text-slate-800" : "bg-red-600 text-white"}`}
    >
      {pending ? pendingLabel : label}
    </button>
  );
}

/**
 * The byokRequiresPlan switch. It changes what every free user may do with
 * their own model keys, so both directions ask first (through DangerForm, the
 * console's one confirming form) and say exactly who is affected.
 */
export function AdminBillingByokToggle({ enabled }) {
  const { t } = useI18n();
  const copy = t?.admin?.byokPolicy || {};
  const [state, formAction] = useActionState(setByokRequiresPlanAction, { ok: null, message: "", value: undefined });
  const on = typeof state?.value === "boolean" ? state.value : Boolean(enabled);
  return (
    <div className="mt-6 space-y-3">
      <p className={`inline-flex rounded-lg px-3 py-1.5 text-xs font-medium ${on ? "bg-amber-50 text-amber-800" : "bg-slate-100 text-slate-600"}`}>
        {on ? copy.on : copy.off}
      </p>
      <p className="max-w-2xl text-sm text-slate-600">{copy.effect}</p>
      <DangerForm action={formAction} confirm={on ? copy.confirmOff : copy.confirmOn} className="flex items-center gap-3">
        <input type="hidden" name="byokRequiresPlan" value={on ? "false" : "true"} />
        <Toggle label={on ? copy.turnOff : copy.turnOn} pendingLabel={copy.saving} on={on} />
      </DangerForm>
      {state?.message ? (
        <p role={state.ok ? "status" : "alert"} className={`rounded-lg px-3 py-2 text-sm ${state.ok ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>
          {state.message}
        </p>
      ) : null}
    </div>
  );
}
