"use client";

import { useState } from "react";
import { EnterpriseDangerForm } from "./admin-enterprise-form";
import { fill, formatAmount, intlLocale, parseWhole } from "./admin-enterprise-shared";
import { useI18n } from "../lib/use-i18n";

/**
 * Moving quota in and out of an organization's pool.
 *
 * Every one of these moves money, so each goes through EnterpriseDangerForm and
 * the confirmation repeats exactly what will happen ("grant 1,000,000 tokens to
 * Galaxy, expiring in 365 days") — the operator confirms the sentence, not a
 * generic "are you sure".
 */

const RESOURCES = ["token", "image_generation", "video_generation"];

const inputClass = "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-brand";

function newKey() {
  return globalThis.crypto?.randomUUID?.() || `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * `idempotencyKey` is minted by the server page for this form. The form keeps
 * it until a grant SUCCEEDS, then takes a fresh one: a retry after a timeout —
 * or after any other change re-rendered the page — resends the same key, and
 * the server returns the first grant instead of granting twice.
 */
export function GrantQuotaForm({ action, organizationName, idempotencyKey, disabled = false }) {
  const { t, locale } = useI18n();
  const [key, setKey] = useState(idempotencyKey);
  const copy = t?.admin?.enterprise || {};
  const g = copy.grant || {};
  const [resourceType, setResourceType] = useState("token");
  const [unitsText, setUnitsText] = useState("");
  const [daysText, setDaysText] = useState("365");
  const units = parseWhole(unitsText);
  const days = parseWhole(daysText);
  const valid = units >= 1 && units <= 1000000000 && days >= 1 && days <= 3650;
  const expires = valid ? new Date(Date.now() + days * 24 * 60 * 60 * 1000).toLocaleDateString(intlLocale(locale)) : "";
  const summary = valid
    ? fill(g.summary, { org: organizationName, amount: formatAmount(copy, resourceType, units, locale), days: days.toLocaleString(intlLocale(locale)), date: expires })
    : "";
  const scale = units >= 10000
    ? fill(g.scale, { value: new Intl.NumberFormat(intlLocale(locale), { notation: "compact", maximumFractionDigits: 2 }).format(units) })
    : "";
  return (
    <EnterpriseDangerForm
      action={action}
      confirm={`${g.confirm || ""}\n${summary}`}
      onSuccess={() => { setUnitsText(""); setKey(newKey()); }}
      className="grid gap-3"
    >
      <input type="hidden" name="idempotencyKey" value={key} />
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">{g.resource}</span>
          <select name="resourceType" value={resourceType} onChange={(event) => setResourceType(event.target.value)} className={inputClass}>
            {RESOURCES.map((value) => <option key={value} value={value}>{copy.resource?.[value] || value}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">{g.units}<span className="ms-1 text-red-600" aria-hidden="true">*</span></span>
          <input
            name="unitTotal"
            inputMode="numeric"
            autoComplete="off"
            required
            value={unitsText}
            onChange={(event) => setUnitsText(event.target.value)}
            onBlur={() => { if (units) setUnitsText(units.toLocaleString("en-US")); }}
            placeholder={g.unitsPlaceholder}
            className={`${inputClass} tabular-nums`}
          />
          <span className="mt-1 block text-xs text-slate-500">
            {g.unitsHelp?.[resourceType]}
            {scale ? <span className="ms-2 font-medium text-slate-700">{scale}</span> : null}
          </span>
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">{g.expiresDays}</span>
          <input name="expiresDays" type="number" min={1} max={3650} value={daysText} onChange={(event) => setDaysText(event.target.value)} className={`${inputClass} tabular-nums`} />
          <span className="mt-1 block text-xs text-slate-500">{g.expiresHelp}</span>
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">{g.note}</span>
          <input name="note" maxLength={200} placeholder={g.notePlaceholder} className={inputClass} />
        </label>
      </div>
      <p className={`rounded-lg px-3 py-2 text-sm ${valid ? "bg-amber-50 text-amber-900" : "bg-slate-50 text-slate-500"}`}>{valid ? summary : g.summaryEmpty}</p>
      <div>
        <button type="submit" disabled={disabled || !valid} className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">
          {g.submit}
        </button>
      </div>
    </EnterpriseDangerForm>
  );
}

/** Take back part of one grant, or revoke what is left. Both ask for a reason and confirm the amount. */
export function GrantRowActions({ reduceAction, revokeAction, resourceType, remaining }) {
  const { t, locale } = useI18n();
  const copy = t?.admin?.enterprise || {};
  const p = copy.pool || {};
  const [open, setOpen] = useState(false);
  const [unitsText, setUnitsText] = useState("");
  const units = Math.min(parseWhole(unitsText), Number(remaining || 0));
  const left = formatAmount(copy, resourceType, remaining, locale);
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50">
        {p.reduce} / {p.revoke}
      </button>
    );
  }
  return (
    <div className="grid min-w-[16rem] gap-3">
      <EnterpriseDangerForm action={reduceAction} confirm={fill(p.reduceConfirm, { units: formatAmount(copy, resourceType, units, locale) })} onSuccess={() => setUnitsText("")} className="grid gap-2">
        <input name="units" inputMode="numeric" required value={unitsText} onChange={(event) => setUnitsText(event.target.value)} placeholder={p.reduceUnits} aria-label={p.reduceUnits} className={`${inputClass} tabular-nums`} />
        <input name="reason" required maxLength={200} placeholder={p.reduceReasonPlaceholder} aria-label={p.reduceReason} className={inputClass} />
        <button type="submit" disabled={units < 1} className="justify-self-start rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50">
          {p.reduce}
        </button>
      </EnterpriseDangerForm>
      <EnterpriseDangerForm action={revokeAction} confirm={fill(p.revokeConfirm, { units: left })} className="grid gap-2 border-t border-slate-100 pt-3">
        <input name="reason" required maxLength={200} placeholder={p.reduceReasonPlaceholder} aria-label={p.reduceReason} className={inputClass} />
        <button type="submit" className="justify-self-start rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700">
          {p.revoke}
        </button>
      </EnterpriseDangerForm>
    </div>
  );
}
