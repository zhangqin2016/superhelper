"use client";

import { useState } from "react";
import { useI18n } from "../lib/use-i18n";
import {
  LICENSE_PLAN_WEEKLY_CREDITS,
  UNLIMITED_LICENSE_PLAN,
  fillLicenseCopy,
  formatCredits,
  licensePlanHint,
  licensePlanOptions,
  normalizeLicensePlan,
} from "../lib/license-plans.mjs";

const inputClass = "w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand disabled:bg-slate-50 disabled:text-slate-400";

// The plan select and the optional "credits per seat per week" override. Two
// grid cells; the override is disabled for the unlimited plan (the server
// ignores it there) and empty means the plan's default.
export function LicensePlanFields({ defaultPlan = "pro", defaultWeeklyCredits = "" }) {
  const { t } = useI18n();
  const copy = t.admin.licensePlans;
  const [plan, setPlan] = useState(() => normalizeLicensePlan(defaultPlan));
  const unlimited = plan === UNLIMITED_LICENSE_PLAN;

  return (
    <>
      <label className="block lg:col-span-2">
        <span className="mb-2 block text-sm font-medium text-slate-700">{copy.label}</span>
        <select className={inputClass} name="plan" value={plan} onChange={(event) => setPlan(event.target.value)}>
          {licensePlanOptions(copy).map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <span className="mt-1 block text-xs text-slate-500" data-plan-hint={plan}>{licensePlanHint(copy, plan)}</span>
      </label>
      <label className="block">
        <span className="mb-2 block text-sm font-medium text-slate-700">{copy.override}</span>
        <input
          className={inputClass}
          name="weeklyCreditsPerSeat"
          type="number"
          min="0"
          step="1"
          disabled={unlimited}
          defaultValue={defaultWeeklyCredits ?? ""}
          placeholder={unlimited ? "" : fillLicenseCopy(copy.overridePlaceholder, { n: formatCredits(LICENSE_PLAN_WEEKLY_CREDITS[plan]) })}
        />
        <span className="mt-1 block text-xs text-slate-500">{unlimited ? copy.overrideUnlimited : copy.overrideHelp}</span>
      </label>
    </>
  );
}
