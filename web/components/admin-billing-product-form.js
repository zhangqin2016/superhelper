"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { upsertBillingProductAction } from "../app/admin/billing/actions";
import { Field } from "./admin-field";
import { useI18n } from "../lib/use-i18n";
import { creditUnit } from "../lib/site-copy-pricing.mjs";

const inputClass = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500";
const selectClass = "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-slate-500";
const KINDS = ["day_pass", "week_pass", "month_pass", "token_pack", "image_pack", "video_pack", "single_use"];
const RESOURCES = ["plan", "token", "image_generation", "video_generation", "membership"];
const PLAN_DAYS = { month: 30, year: 365 };
const initialState = { ok: null, message: "" };

function Save({ label, pending: pendingLabel }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} aria-busy={pending ? "true" : "false"} className="mt-4 rounded-lg bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
      {pending ? pendingLabel : label}
    </button>
  );
}

/**
 * The product form, now with subscription plans. Choosing "Subscription plan"
 * swaps the generic fields for tier, period, days per period and weekly
 * allowance; the action saves it as kind "subscription" + resource type
 * "plan" with metadata { plan, period }. The outcome is a sentence in the
 * operator's language, shown right under the button.
 */
export function AdminBillingProductForm() {
  const { t, locale } = useI18n();
  const unit = creditUnit(locale);
  const raw = t?.admin?.billingProduct || {};
  const c = (key) => String(raw[key] || "").replace(/\{unit\}/g, unit);
  const nested = (group, key) => String(raw[group]?.[key] || key).replace(/\{unit\}/g, unit);
  const [state, formAction] = useActionState(upsertBillingProductAction, initialState);
  const [resourceType, setResourceType] = useState("plan");
  const [period, setPeriod] = useState("month");
  const [days, setDays] = useState(String(PLAN_DAYS.month));
  const [daysTouched, setDaysTouched] = useState(false);
  const isPlan = resourceType === "plan";

  return (
    <form action={formAction} className="rounded-xl border border-slate-200 bg-white p-5">
      <h2 className="text-lg font-semibold">{c("title")}</h2>
      <p className="mt-1 text-sm text-slate-500">{c("desc")}</p>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <Field label={c("id")} required>
          <input name="id" required minLength={2} placeholder={c("idPlaceholder")} className={inputClass} />
        </Field>
        <Field label={c("name")} required>
          <input name="name" required placeholder={c("namePlaceholder")} className={inputClass} />
        </Field>
        <Field label={c("resourceType")} help={isPlan ? c("planHelp") : ""}>
          <select name="resourceType" value={resourceType} onChange={(event) => setResourceType(event.target.value)} className={selectClass}>
            {RESOURCES.map((value) => <option key={value} value={value}>{nested("resources", value)}</option>)}
          </select>
        </Field>
        <Field label={c("price")} help={c("priceHelp")} required>
          <input name="priceYuan" required inputMode="decimal" placeholder="49" className={inputClass} />
        </Field>

        {isPlan ? (
          <>
            <Field label={c("planTier")} required>
              <select name="planTier" defaultValue="max" className={selectClass}>
                {["pro", "max"].map((value) => <option key={value} value={value}>{nested("tiers", value)}</option>)}
              </select>
            </Field>
            <Field label={c("planPeriod")} required>
              <select
                name="planPeriod"
                value={period}
                onChange={(event) => {
                  setPeriod(event.target.value);
                  if (!daysTouched) setDays(String(PLAN_DAYS[event.target.value] || ""));
                }}
                className={selectClass}
              >
                {["month", "year"].map((value) => <option key={value} value={value}>{nested("periods", value)}</option>)}
              </select>
            </Field>
            <Field label={c("planDays")} help={c("planDaysHelp")} required>
              <input
                name="planDays"
                required
                type="number"
                min="1"
                max="3650"
                step="1"
                value={days}
                onChange={(event) => { setDays(event.target.value); setDaysTouched(true); }}
                className={inputClass}
              />
            </Field>
            <Field label={c("weeklyUnits")} help={c("weeklyUnitsHelp")} required>
              <input name="weeklyUnits" required type="number" min="0" max="1000000000" step="1" placeholder="0" className={inputClass} />
            </Field>
          </>
        ) : (
          <>
            <Field label={c("kind")}>
              <select name="kind" defaultValue="token_pack" className={selectClass}>
                {KINDS.map((value) => <option key={value} value={value}>{nested("kinds", value)}</option>)}
              </select>
            </Field>
            <Field label={c("unitAmount")} required>
              <input name="unitAmount" required type="number" min="0" step="1" placeholder="100000" className={inputClass} />
            </Field>
            <Field label={c("durationSeconds")} help={c("durationHelp")}>
              <input name="durationSeconds" type="number" min="0" step="1" className={inputClass} />
            </Field>
            <Field label={c("grantExpiresDays")}>
              <input name="grantExpiresDays" type="number" min="0" step="1" placeholder="365" className={inputClass} />
            </Field>
          </>
        )}

        <Field label={c("sortOrder")}>
          <input name="sortOrder" type="number" step="1" placeholder="0" className={inputClass} />
        </Field>
        <Field label={c("status")}>
          <select name="status" defaultValue="active" className={selectClass}>
            {["active", "disabled"].map((value) => <option key={value} value={value}>{nested("statuses", value)}</option>)}
          </select>
        </Field>
        <Field label={c("description")} span="md:col-span-2">
          <textarea name="description" placeholder={c("descriptionPlaceholder")} className={inputClass} rows={3} />
        </Field>
      </div>
      <Save label={c("save")} pending={c("saving")} />
      {state?.message ? (
        <p role={state.ok ? "status" : "alert"} className={`mt-3 rounded-lg px-3 py-2 text-sm ${state.ok ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
