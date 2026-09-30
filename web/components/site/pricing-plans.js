import Link from "next/link";
import { ArrowRight, Check } from "lucide-react";

function PlanCard({ plan, variant, children }) {
  return (
    <article className={`pr-plan site-card pr-plan--${variant}`}>
      <header className="pr-plan-head">
        <h2 className="site-h3 pr-plan-name">{plan.name}</h2>
        <span className={variant === "personal" ? "site-chip site-chip--brand" : "site-chip"}>{plan.tag}</span>
      </header>
      <p className="pr-plan-price">{plan.price}</p>
      <p className="pr-plan-note">{plan.priceNote}</p>
      <p className="pr-plan-desc">{plan.desc}</p>
      <div className="pr-plan-actions">{children}</div>
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

/** The two ways to use Lily: personal (free trial, then usage) and enterprise (opened by the platform). */
export function PricingPlans({ copy }) {
  return (
    <section className="pr-plans" aria-label={`${copy.personal.name} / ${copy.enterprise.name}`}>
      <PlanCard plan={copy.personal} variant="personal">
        <Link href="/download" className="site-btn site-btn--primary">{copy.personal.cta}</Link>
        <Link href="/account/login" className="site-btn site-btn--secondary">{copy.personal.secondary}</Link>
      </PlanCard>
      <PlanCard plan={copy.enterprise} variant="enterprise">
        <Link href="/contact" className="site-btn site-btn--dark">
          {copy.enterprise.cta}
          <ArrowRight size={16} className="pr-arrow" aria-hidden="true" />
        </Link>
      </PlanCard>
    </section>
  );
}
