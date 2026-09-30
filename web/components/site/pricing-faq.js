import Link from "next/link";
import { Plus } from "lucide-react";

/** Billing questions as native disclosure, so it works without JavaScript. */
export function PricingFaq({ copy }) {
  const faq = copy.faq;
  return (
    <section className="pr-faq" aria-labelledby="pr-faq-title">
      <div className="pr-section-head">
        <p className="site-eyebrow">{faq.eyebrow}</p>
        <h2 id="pr-faq-title" className="site-h2">{faq.title}</h2>
      </div>
      <div className="pr-faq-list">
        {faq.items.map((item) => (
          <details key={item.q} className="pr-faq-item">
            <summary>
              <span>{item.q}</span>
              <Plus size={18} className="pr-faq-icon" aria-hidden="true" />
            </summary>
            <div className="pr-faq-body">
              <p>{item.a}</p>
              {item.link ? <p><Link href={item.link.href} className="site-link">{item.link.label}</Link></p> : null}
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}
