import Link from "next/link";
import { Check, Minus } from "lucide-react";
import { PLAN_PERIODS } from "../../lib/site-copy-pricing.mjs";

function fill(template, values) {
  return String(template || "").replace(/\{(\w+)\}/g, (_, key) => (values[key] ?? `{${key}}`));
}

/** What a plan includes (check) and what it does not (dash), so a missing feature is never shown with a check. */
export function PlanPoints({ points = [], excludes = [], copy }) {
  return (
    <ul className="pr-plan-points">
      {points.map((point) => (
        <li key={point}>
          <Check size={16} strokeWidth={2.25} aria-hidden="true" />
          <span>{point}</span>
        </li>
      ))}
      {excludes.map((point) => (
        <li key={point} className="pr-plan-point--no">
          <Minus size={16} aria-hidden="true" />
          <span><span className="pr-sr">{copy.no}: </span>{point}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * One billing period of a plan. A buy button only for a real product while a
 * payment method is live; otherwise "opening soon" and a way to reach us.
 */
function PeriodBlock({ cell, period, yearMonths, plans }) {
  const notes = [];
  if (period === "year" && yearMonths) notes.push(fill(plans.yearHint, { n: yearMonths }));
  if (cell.source === "quote") notes.push(plans.quoteLabel);
  return (
    <div className={`pr-period pr-period--${period}`}>
      <p className="pr-plan-price site-num">
        {cell.price}
        <span className="pr-plan-per">{period === "year" ? plans.perYear : plans.perMonth}</span>
      </p>
      <p className="pr-plan-note">{notes.join(" · ") || " "}</p>
      {cell.weekly ? <p className="pr-plan-weekly site-num">{cell.weekly}</p> : null}
      <div className="pr-plan-actions">
        {cell.buyable ? (
          <Link href="/account/billing" className="site-btn site-btn--primary">{plans.buy}</Link>
        ) : (
          <>
            <span className="pr-plan-soon">{plans.soon}</span>
            <Link href="/contact" className="site-btn site-btn--secondary">{plans.contact}</Link>
          </>
        )}
      </div>
      {!cell.buyable ? <p className="pr-plan-soon-note">{cell.source === "product" ? plans.paymentSoon : plans.soonNote}</p> : null}
    </div>
  );
}

/** Pro or Max: both periods are rendered; the page's period toggle shows one. */
export function PlanOfferCard({ tierState, copy }) {
  const plans = copy.plans;
  const tier = plans.tiers[tierState.tier];
  return (
    <article className={`pr-plan site-card${tierState.featured ? " pr-plan--featured" : ""}`}>
      <header className="pr-plan-head">
        <h3 className="site-h3 pr-plan-name">{tier.name}</h3>
        {tierState.featured ? <span className="site-chip site-chip--brand">{plans.recommended}</span> : <span className="site-chip">{tier.tag}</span>}
      </header>
      {PLAN_PERIODS.map((period) => (
        <PeriodBlock key={period} cell={tierState[period]} period={period} yearMonths={tierState.yearMonths} plans={plans} />
      ))}
      <p className="pr-plan-desc">{tier.desc}</p>
      <hr className="site-divider pr-plan-rule" />
      <PlanPoints points={tier.points} excludes={tier.excludes} copy={copy.compare} />
    </article>
  );
}
