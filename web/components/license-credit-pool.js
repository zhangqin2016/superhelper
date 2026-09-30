import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { fillLicenseCopy, formatCredits, licensePlanName } from "../lib/license-plans.mjs";

const DATE_LOCALE = { zh: "zh-CN", en: "en-US", ar: "ar" };

function resetText(resetsAt, locale) {
  const ms = Date.parse(String(resetsAt || ""));
  if (!Number.isFinite(ms)) return "-";
  return new Intl.DateTimeFormat(DATE_LOCALE[locale] || "zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(ms));
}

// This week's licence credit pool (GET /api/admin/licenses/:id → credits):
// credits per seat × seats in use (bound devices, capped by the seat count).
export function LicenseCreditPool({ credits, legacyPlan = "", copy, locale = "zh" }) {
  const pool = copy.pool;
  const rows = [];
  if (credits && typeof credits === "object") {
    rows.push([pool.plan, licensePlanName(copy, credits.plan)]);
    rows.push([pool.seats, `${formatCredits(credits.seatsInUse)} / ${formatCredits(credits.seatsCap)}`, pool.seatsHelp]);
    if (!credits.unlimited) {
      rows.push([pool.perSeat, `${formatCredits(credits.perSeat)} ${pool.unit}`]);
      rows.push([pool.total, `${formatCredits(credits.total)} ${pool.unit}`]);
      rows.push([pool.used, `${formatCredits(credits.used)} ${pool.unit}`]);
      rows.push([pool.remaining, `${formatCredits(credits.remaining)} ${pool.unit}`]);
    }
    rows.push([pool.resetsAt, resetText(credits.resetsAt, locale)]);
  }

  return (
    <Card data-license-credit-pool={credits ? (credits.unlimited ? "unlimited" : "limited") : "none"}>
      <CardHeader><CardTitle>{pool.title}</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm text-slate-600">
        {!credits ? <p className="text-slate-500">{pool.unavailable}</p> : null}
        {credits?.unlimited ? (
          <p className="font-semibold text-slate-900">{fillLicenseCopy(pool.unlimited, { n: formatCredits(credits.used) })}</p>
        ) : null}
        {rows.map(([label, value, help]) => (
          <div key={label} className="flex justify-between gap-4">
            <span>
              {label}
              {help ? <span className="block text-xs text-slate-400">{help}</span> : null}
            </span>
            <b className="tabular-nums">{value}</b>
          </div>
        ))}
        {legacyPlan ? (
          <div className="border-t border-slate-100 pt-3 text-slate-500">{fillLicenseCopy(pool.legacy, { plan: licensePlanName(copy, legacyPlan) })}</div>
        ) : null}
      </CardContent>
    </Card>
  );
}
