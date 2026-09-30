import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { PlanPoints } from "./pricing-plans-card";

function fill(template, values) {
  return String(template || "").replace(/\{(\w+)\}/g, (_, key) => (values[key] ?? `{${key}}`));
}

/** The two published seat tiers. Sold by contract, so the action is always "contact sales". */
export function PricingEnterprise({ copy, tiers }) {
  const e = copy.enterprisePlans;
  return (
    <section className="pr-enterprise" aria-labelledby="pr-enterprise-title">
      <div className="pr-section-head">
        <p className="site-eyebrow">{e.eyebrow}</p>
        <h2 id="pr-enterprise-title" className="site-h2">{e.title}</h2>
        <p className="site-lead pr-section-lead">{e.lead}</p>
      </div>
      <div className="pr-enterprise-grid">
        {tiers.map((item) => {
          const tier = e.tiers[item.tier];
          return (
            <article key={item.tier} className="pr-plan site-card pr-plan--enterprise">
              <header className="pr-plan-head">
                <h3 className="site-h3 pr-plan-name">{tier.name}</h3>
                <span className="site-chip">{tier.tag}</span>
              </header>
              <p className="pr-plan-price site-num">
                {item.month}
                <span className="pr-plan-per">{e.perSeatMonth}</span>
              </p>
              <p className="pr-plan-note site-num">{fill(e.yearly, { price: item.year })}{e.perSeatYear}</p>
              <p className="pr-plan-weekly site-num">{fill(e.minSeats, { n: item.minSeats })} · {fill(e.minOrder, { price: item.minimum })}</p>
              <div className="pr-plan-actions">
                <Link href="/contact?topic=enterprise" className="site-btn site-btn--dark">
                  {e.cta}
                  <ArrowRight size={16} className="pr-arrow" aria-hidden="true" />
                </Link>
              </div>
              <hr className="site-divider pr-plan-rule" />
              <PlanPoints points={tier.points} excludes={tier.excludes} copy={copy.compare} />
            </article>
          );
        })}
      </div>
      <p className="pr-enterprise-note">{e.privateNote} {e.legalNote}</p>
    </section>
  );
}
