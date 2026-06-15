"use client";

import { useActionState } from "react";
import { createLicenseAction } from "../app/admin/actions";
import { Field, SelectField, SubmitButton } from "./admin-forms";
import { useI18n } from "../lib/use-i18n";

const initialState = { ok: null, message: "" };

export function LicenseCreateForm() {
  const [state, action, pending] = useActionState(createLicenseAction, initialState);
  const { t } = useI18n();

  return (
    <div className="table-card mb-6 p-6">
      <h2 className="mb-5 text-xl font-semibold">{t.admin.pages.licenses[0]}</h2>
      <form action={action} className="grid gap-4 lg:grid-cols-6">
        <div className="lg:col-span-2">
          <Field label="Customer" name="customerName" placeholder="Lanren Soft" />
        </div>
        <SelectField label="Plan" name="plan" defaultValue="pro" options={["trial", "pro", "team", "enterprise"]} />
        <Field label="Seats" name="seats" type="number" defaultValue="1" required />
        <Field label="Expires at" name="expiresAt" type="datetime-local" required />
        <Field label="Features" name="features" defaultValue="updates,skill-packages,usage" />
        <div className="flex items-end">
          <SubmitButton disabled={pending}>{pending ? "..." : t.admin.pages.licenses[0]}</SubmitButton>
        </div>
      </form>

      {state?.message ? (
        <div
          className={`mt-5 rounded-xl border px-4 py-3 text-sm ${
            state.ok ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-red-200 bg-red-50 text-red-800"
          }`}
        >
          <p className="font-medium">{state.message}</p>
          {state.ok && state.licenseKey ? (
            <div className="mt-3 rounded-lg bg-white p-3 font-mono text-base text-slate-900 shadow-sm">
              {state.licenseKey}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
