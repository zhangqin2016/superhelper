import Link from "next/link";
import { Check } from "lucide-react";
import { PlanOfferCard } from "./pricing-plans-card";

function fill(template, values) {
  return String(template || "").replace(/\{(\w+)\}/g, (_, key) => (values[key] ?? `{${key}}`));
}

function FreeCard({ plan }) {
  return (
    <article className="pr-plan site-card pr-plan--free">
      <header className="pr-plan-head">
        <h3 className="site-h3 pr-plan-name">{plan.name}</h3>
        <span className="site-chip">{plan.tag}</span>
      </header>
      <p className="pr-plan-price">{plan.price}</p>
      <p className="pr-plan-note">{plan.priceNote}</p>
      <p className="pr-plan-desc">{plan.desc}</p>
      <div className="pr-plan-actions">
        <Link href="/download" className="site-btn site-btn--secondary">{plan.cta}</Link>
        <Link href="/account/login" className="site-btn site-btn--ghost">{plan.secondary}</Link>
      </div>
      <hr className="site-divider pr-plan-rule" />
      <ul className="pr-plan-points">
        {plan.points.map((point) => (
          <li key={point}>
            <Check size={16} strokeWidth={2.25} aria-hidden="true" />
            <span>{point}</span>
          </li>
        ))}
      </ul>
    </article>
  );
}

/**
 * The main offer: the free trial, then Pro and Max (Max highlighted). The
 * monthly / yearly switch is two radio inputs and CSS, so it works before —
 * and without — JavaScript, and the server and client render the same thing.
 */
export function PricingPlans({ copy, plans }) {
  const p = copy.plans;
  const months = plans.tiers.find((tier) => tier.yearMonths)?.yearMonths || 0;
  return (
    <section className="pr-offer" aria-labelledby="pr-offer-title">
      <div className="pr-section-head">
        <p className="site-eyebrow">{p.eyebrow}</p>
        <h2 id="pr-offer-title" className="site-h2">{p.title}</h2>
        <p className="site-lead pr-section-lead">{p.lead}</p>
      </div>
      <input type="radio" name="pr-period" id="pr-period-month" className="pr-period-radio pr-period-radio--month" defaultChecked />
      <input type="radio" name="pr-period" id="pr-period-year" className="pr-period-radio pr-period-radio--year" />
      <div className="pr-period-toggle" role="group" aria-label={p.periodLegend}>
        <label htmlFor="pr-period-month">{p.month}</label>
        <label htmlFor="pr-period-year">
          {p.year}
          {months ? <span className="pr-period-save">{fill(p.yearHint, { n: months })}</span> : null}
        </label>
      </div>
      <div className="pr-offer-grid">
        <FreeCard plan={copy.personal} />
        {plans.tiers.map((tier) => <PlanOfferCard key={tier.tier} tierState={tier} copy={copy} />)}
      </div>
    </section>
  );
}
