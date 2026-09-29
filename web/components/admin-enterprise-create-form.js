"use client";

import { useState } from "react";
import { EnterpriseActionForm } from "./admin-enterprise-form";
import { Field } from "./admin-field";
import { useI18n } from "../lib/use-i18n";

const inputClass = "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-brand";

/**
 * Open an organization for a customer, naming its first owner exactly one of
 * two ways. Only the fields of the chosen way are shown, so a phone and an
 * issued login name can never both be filled in and silently one ignored.
 * An issued owner's initial password is shown right here, from the action's
 * result, with a link to the new organization.
 */
export function CreateOrganizationForm({ action }) {
  const { t } = useI18n();
  const c = t?.admin?.enterprise?.list || {};
  const [mode, setMode] = useState("issue");
  const choice = (value, label, help) => (
    <label className={`flex cursor-pointer gap-3 rounded-lg border p-3 ${mode === value ? "border-brand bg-brand/5" : "border-slate-200 bg-white"}`}>
      <input type="radio" name="ownerMode" value={value} checked={mode === value} onChange={() => setMode(value)} className="mt-1" />
      <span>
        <span className="block text-sm font-semibold text-slate-900">{label}</span>
        <span className="mt-0.5 block text-xs text-slate-500">{help}</span>
      </span>
    </label>
  );
  return (
    <EnterpriseActionForm action={action} className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
        <Field label={c.name} required>
          <input name="name" required maxLength={120} placeholder={c.namePlaceholder} className={inputClass} />
        </Field>
        <Field label={c.plan} help={c.planHelp}>
          <input name="plan" maxLength={40} placeholder="standard" className={inputClass} />
        </Field>
      </div>
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium text-slate-700">{c.ownerLegend}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {choice("issue", c.ownerIssue, c.ownerIssueHelp)}
          {choice("phone", c.ownerPhone, c.ownerPhoneHelp)}
        </div>
      </fieldset>
      {mode === "issue" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={c.ownerLoginName} help={c.ownerLoginNameHelp}>
            <input name="ownerLoginName" maxLength={40} autoComplete="off" className={inputClass} />
          </Field>
          <Field label={c.ownerDisplayName} help={c.ownerDisplayNameHelp}>
            <input name="ownerDisplayName" maxLength={80} className={inputClass} />
          </Field>
        </div>
      ) : (
        <Field label={c.ownerPhoneLabel} required>
          <input name="ownerPhone" type="tel" required maxLength={32} placeholder={c.ownerPhonePlaceholder} className={inputClass} />
        </Field>
      )}
      <div>
        <button type="submit" className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand/90">{c.create}</button>
      </div>
    </EnterpriseActionForm>
  );
}
